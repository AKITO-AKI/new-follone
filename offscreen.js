// follone offscreen document (MV3) v0.4.8
// Purpose: Run Prompt API (LanguageModel) in an extension-owned document context,
//          so it isn't gated by x.com's Permissions-Policy / origin restrictions.

const LOG_PREFIX = "[follone:offscreen]";

function log(level, ...args) {
  const fn = console[level] || console.log;
  fn.call(console, LOG_PREFIX, ...args);
}

const LM_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["ja", "en"] }],
  expectedOutputs: [{ type: "text", languages: ["ja"] }],
};


// Priority task queues (v0.4.9)
// - Because we now "pre-analyze" a lot of posts, we must prioritize near-viewport tasks.
// - We process tasks sequentially to keep model latency predictable.
const highQ = [];
const lowQ = [];
let busy = false;

function pushTask(task) {
  const p = task?.priority === "high" ? highQ : lowQ;
  p.push(task);
  log("debug", "enqueue", { priority: task?.priority || "low", high: highQ.length, low: lowQ.length });
  pump();
}

async function pump() {
  if (busy) return;
  const task = highQ.shift() || lowQ.shift();
  if (!task) return;
  busy = true;
  try {
    const { requestId, batch, topicList } = task;
    const out = await classifyBatch(Array.isArray(batch) ? batch : [], topicList);
    chrome.runtime.sendMessage({
      target: "sw",
      type: "FOLLONE_OFFSCREEN_RESULT",
      requestId,
      ...out,
    });
  } catch (e) {
    chrome.runtime.sendMessage({
      target: "sw",
      type: "FOLLONE_OFFSCREEN_RESULT",
      requestId: task?.requestId,
      ok: false,
      status: "error",
      availability: "unknown",
      error: String(e),
      results: []
    });
  } finally {
    busy = false;
    // Continue
    setTimeout(pump, 0);
  }
}

const RISK_ENUM = ["誹謗中傷", "政治", "偏見", "差別", "詐欺", "成人向け", "その他", "問題なし"];


const REASON_ENUM = ["攻撃的な言い回し", "個人への非難", "煽り/扇動", "属性の一般化", "差別的表現", "政治的煽動", "誤情報の可能性", "金銭/誘導", "詐欺の可能性", "性的示唆", "露骨な表現", "スパム/宣伝", "過度な断定", "低情報量", "画像のみ", "絵文字のみ"];

let session = null;
let sessionStatus = "not_ready"; // not_ready | ready | unavailable | downloading | downloadable | mock
let sessionCreatedAt = 0;

async function ensureSession() {
  if (typeof LanguageModel === "undefined") {
    sessionStatus = "mock";
    return { ok: false, status: "mock", availability: "no_api" };
  }

  const availability = await LanguageModel.availability(LM_OPTIONS);
  // We *cannot* guarantee user activation in an offscreen document.
  // So: if model is not already "available", report status so UI can guide user.
  if (availability === "unavailable") {
    sessionStatus = "unavailable";
    session = null;
    return { ok: false, status: "unavailable", availability };
  }
  if (availability === "downloadable" || availability === "downloading") {
    sessionStatus = availability; // downloadable / downloading
    session = null;
    return { ok: false, status: availability, availability };
  }

  // availability === "available"
  if (session) {
    sessionStatus = "ready";
    return { ok: true, status: "ready", availability };
  }

  session = await LanguageModel.create({
    ...LM_OPTIONS,
    outputLanguage: "ja",
    // No monitor here; offscreen should be quiet.
  });
  sessionCreatedAt = Date.now();
  sessionStatus = "ready";
  return { ok: true, status: "ready", availability };
}




function sanitizeTopicList(topicList) {
  // Accept: array of strings; return a safe, deduped list for schema enum usage.
  // Keep it short to reduce prompt + schema size.
  const MAX_TOPICS = 24;       // hard cap (speed)
  const MAX_LEN = 18;          // per-topic char cap
  const FALLBACK = ["その他"];

  if (!Array.isArray(topicList)) return FALLBACK;

  const out = [];
  const seen = new Set();
  for (const raw of topicList) {
    if (raw == null) continue;
    let s = String(raw).trim();
    if (!s) continue;
    // strip control chars
    s = s.replace(/[\u0000-\u001F\u007F]/g, "");
    if (!s) continue;
    if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_TOPICS) break;
  }
  return out.length ? out : FALLBACK;
}


function clampInt(v, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}


const LOW_INFO_REASONS = new Set(["低情報量", "画像のみ", "絵文字のみ"]);

function inferRiskCategoryFromReasons(reasons) {
  if (!Array.isArray(reasons)) return null;
  const has = (x) => reasons.includes(x);
  if (has("露骨な表現") || has("性的示唆")) return "成人向け";
  if (has("政治的煽動")) return "政治";
  if (has("差別的表現")) return "差別";
  if (has("属性の一般化")) return "偏見";
  if (has("スパム/宣伝")) return "詐欺";
  if (has("攻撃的な言い回し") || has("個人への非難") || has("煽り/扇動") || has("過度な断定")) return "誹謗中傷";
  return null;
}

function normalizeOneResult(r, topicList) {
  if (!r || typeof r !== "object") return null;
  const id = String(r.id ?? "").trim();
  if (!id) return null;

  let riskScore = clampInt(r.riskScore ?? r.risk ?? 0, 0, 100);
  let riskCategory = RISK_ENUM.includes(r.riskCategory) ? r.riskCategory : "その他";
  let topicCategory = topicList.includes(r.topicCategory) ? r.topicCategory : (topicList[0] || "その他");

  let reasons = Array.isArray(r.reasons) ? r.reasons.filter(x => REASON_ENUM.includes(x)).slice(0, 2) : [];
  if (reasons.length === 0) reasons = REASON_ENUM.includes("低情報量") ? ["低情報量"] : [];

  // Coherence / sanity rules (favor speed + stable UI):
  // - Low-info posts => always "問題なし" with low score
  // - If model outputs "問題なし" but score/reasons indicate risk => promote category (do NOT clamp score down)
  // - If category is vague but reasons indicate a specific risk => infer category from reasons
  const lowInfoOnly = reasons.length > 0 && reasons.every(r => LOW_INFO_REASONS.has(r));

  const inferred = inferRiskCategoryFromReasons(reasons);

  if (lowInfoOnly) {
    riskCategory = "問題なし";
    riskScore = Math.min(riskScore, 10);
  } else {
    // Promote category when inconsistent
    if (riskCategory === "問題なし") {
      if (inferred) {
        log("warn", "sanity: safe category but non-low-info reasons -> promoted", { id, riskScore, riskCategory, to: inferred, reasons });
        riskCategory = inferred;
      } else {
        if (riskScore >= 20) {
          log("warn", "sanity: safe category but score>=20 -> promoted to その他", { id, riskScore, reasons });
          riskCategory = "その他";
        }
      }
    } else if (riskCategory === "その他" && inferred) {
      riskCategory = inferred;
    }

    // Keep a minimal floor for non-safe categories if the model under-scores
    if (riskCategory !== "問題なし" && riskScore < 15) riskScore = 20;
  }

return { id, riskScore, riskCategory, topicCategory, reasons };
}

function buildSchema(topicList) {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            riskScore: { type: "integer", minimum: 0, maximum: 100 },
            riskCategory: { type: "string", enum: RISK_ENUM },
            topicCategory: { type: "string", enum: topicList },
            reasons: { type: "array", maxItems: 2, items: { type: "string", enum: REASON_ENUM } },
          },
          required: ["id", "riskScore", "riskCategory", "topicCategory", "reasons"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
}

function buildClassifyPrompt(batch, topicList) {
  const persona = "あなたは「ふぉろね（follone）」です。少し気怠そうだがユーザーには優しく、介入時は説明重視。";
  const rules = [
    "次のX投稿（複数）について「危険カテゴリ」「危険度」「トピックカテゴリ」を判定し、理由タグ（最大2つ）を選ぶ。",
    `危険カテゴリ: ${RISK_ENUM.join(" / ")}`,
    "危険度: 0〜100（高いほど危険）",
    "整合性: 「問題なし」は低情報量（低情報量/画像のみ/絵文字のみ）のときのみ。問題なしの場合riskScoreは0〜10。riskScoreが20以上ならriskCategoryは必ず「問題なし」以外。",
    "reasonsは必ず1〜2個。自由記述は禁止。問題なしの場合は「低情報量/画像のみ/絵文字のみ」などから選ぶ。",
    `トピックカテゴリ: ${topicList.join(" / ")}`,
    `理由タグ: ${REASON_ENUM.join(" / ")}（この中から最大2つ。自由記述は禁止）`,
    "制約: 出力はJSONのみ（responseConstraintに合致）。余計な文は出さない。",
    "注意: 差別語/露骨な性的表現/誹謗中傷の文言は再掲しない。タグで表現する。"
  ].join("\\n");

  const payload = batch.map(p => `ID:${p.id}\\nTEXT:${p.text}\\nMETA:${p.meta}`).join("\\n\\n---\\n\\n");
  return `${persona}\\n${rules}\\n\\n${payload}`;
}

async function classifyBatch(batch, topicList) {
  // batch: [{id,text,meta}]
  const ensure = await ensureSession();
  if (!ensure.ok) {
    return { ok: false, status: ensure.status, availability: ensure.availability, engine: "none", latencyMs: 0, results: [] };
  }

  const topics = sanitizeTopicList(topicList);
  const schema = buildSchema(topics);
  const prompt = buildClassifyPrompt(batch, topics);

  const t0 = performance.now();
  const raw = await session.prompt(prompt, {
    responseConstraint: schema,
    omitResponseConstraintInput: true,
  });
  const latencyMs = Math.round(performance.now() - t0);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log("warn", "JSON parse failed, returning empty", String(e), raw?.slice?.(0, 200));
    return { ok: false, status: "parse_error", availability: "available", engine: "prompt_api", latencyMs: 0, results: [] };
  }

  const rawResults = Array.isArray(parsed?.results) ? parsed.results : [];
  const results = rawResults.map(r => normalizeOneResult(r, topicList)).filter(Boolean);
  return { ok: true, status: "ready", availability: "available", engine: "prompt_api", latencyMs, results };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || msg.target !== "offscreen") return;

    if (msg.type === "FOLLONE_OFFSCREEN_STATUS") {
      const availability =
        typeof LanguageModel === "undefined"
          ? "no_api"
          : await LanguageModel.availability(LM_OPTIONS).catch(() => "error");
      sendResponse({
        ok: true,
        status: sessionStatus,
        availability,
        hasSession: Boolean(session),
        sessionAgeSec: session ? Math.round((Date.now() - sessionCreatedAt) / 1000) : 0,
      });
      return;
    }

    
    // Direct classify (SW waits for this response; avoids SW pending-map loss)
    
    if (msg.type === "FOLLONE_OFFSCREEN_WARMUP") {
      const ensure = await ensureSession();
      sendResponse({ ok: ensure.ok, status: ensure.status, availability: ensure.availability, hasSession: Boolean(session) });
      return;
    }

if (msg.type === "FOLLONE_OFFSCREEN_CLASSIFY_DIRECT") {
      const batch = Array.isArray(msg.batch) ? msg.batch : [];
      const topicList = Array.isArray(msg.topicList) ? msg.topicList : [];
      try {
        const out = await classifyBatch(batch, topicList);
        sendResponse({ ...out, backend: "offscreen" });
      } catch (e) {
        sendResponse({
          ok: false,
          backend: "offscreen",
          engine: "none",
          latencyMs: 0,
          status: "unavailable",
          availability: "error",
          error: String(e),
          results: []
        });
      }
      return;
    }

if (msg.type === "FOLLONE_OFFSCREEN_CLASSIFY") {
      const { requestId, batch, topicList, priority } = msg;
      pushTask({ requestId, batch, topicList, priority: priority === "high" ? "high" : "low" });
      sendResponse({ ok: true }); // immediate ack
      return;
    }
  })().catch((e) => {
    log("error", "onMessage handler error", String(e));
    try {
      sendResponse({ ok: false, error: String(e) });
    } catch (_) {}
  });

  return true;
});

log("info", "offscreen booted", { LanguageModel: typeof LanguageModel });
