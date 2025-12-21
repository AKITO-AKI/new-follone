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

let session = null;
let sessionStatus = "not_ready"; // not_ready | ready | unavailable | downloading | downloadable | mock
let sessionCreatedAt = 0;

function buildSchema(topicList) {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            riskScore: { type: "integer", minimum: 0, maximum: 100 },
            riskCategory: { type: "string", enum: RISK_ENUM },
            topicCategory: { type: "string", enum: topicList },
            summary: { type: "string" },
            explanation: { type: "string" },
            suggestedSearches: { type: "array", maxItems: 3, items: { type: "string" } },
          },
          required: ["id", "riskScore", "riskCategory", "topicCategory", "summary", "explanation", "suggestedSearches"],
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
    "次のX投稿（複数）について「危険カテゴリ」「危険度」「トピックカテゴリ」を判定し、説明と安全な検索誘導を作る。",
    `危険カテゴリ: ${RISK_ENUM.join(" / ")}`,
    "危険度: 0〜100（高いほど危険）",
    `トピックカテゴリ: ${topicList.join(" / ")}`,
    "制約: 出力はJSONのみ（responseConstraintに合致）。余計な文は出さない。",
    "summary: 100文字目安。罵倒/差別語/露骨な性的表現をそのまま再掲せず、言い換える。",
    "explanation: なぜ注意か、どう行動するとよいかを説明重視で。断定しすぎず可能性として述べる。",
    "suggestedSearches: X内検索に使える安全で中立な語句を最大3つ。学習/検証/別視点を促す。",
  ].join("\n");

  const payload = batch
    .map((p) => `ID:${p.id}\nTEXT:${p.text}\nMETA:${p.meta || ""}`)
    .join("\n\n---\n\n");

  return `${persona}\n${rules}\n\n${payload}`;
}

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
    // No monitor here; offscreen should be quiet.
  });
  sessionCreatedAt = Date.now();
  sessionStatus = "ready";
  return { ok: true, status: "ready", availability };
}

function sanitizeTopicList(topicList) {
  const unique = [];
  const set = new Set();
  for (const t of (Array.isArray(topicList) ? topicList : [])) {
    const s = String(t || "").trim();
    if (!s) continue;
    if (set.has(s)) continue;
    set.add(s);
    unique.push(s);
    if (unique.length >= 30) break;
  }
  if (unique.length === 0) unique.push("その他");
  return unique;
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

  const results = Array.isArray(parsed?.results) ? parsed.results : [];
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
