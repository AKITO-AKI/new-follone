// follone offscreen backend (Prompt API / LanguageModel)
// - Lives in extension origin, so it can access Prompt API even when page origin can't.
// - Provides batch classification with JSON schema output.

"use strict";

const LM_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["ja", "en"] }],
  expectedOutputs: [{ type: "text", languages: ["ja"] }]
};

let session = null;
let sessionCreatedAt = 0;

// Helper: pick the right LanguageModel namespace across Chrome versions.
// - Web Prompt API: global `LanguageModel`
// - Extension origin trial (older): `chrome.aiOriginTrial.languageModel`
function getLM() {
  try {
    if (chrome?.aiOriginTrial?.languageModel) return chrome.aiOriginTrial.languageModel;
  } catch (_e) {}
  try {
    // Standard Prompt API.
    if (typeof LanguageModel !== "undefined") return LanguageModel;
  } catch (_e) {}
  return null;
}

// AI model download / setup state (onboarding)
let aiSetup = {
  status: "idle", // idle | downloading | ready | unavailable | error
  availability: "unknown",
  progress: 0,
  errorCode: "",
  error: ""
};

function nowSec() { return Math.round(Date.now() / 1000); }

async function availabilitySafe() {
  try {
    const LM = getLM();
    if (!LM) return { availability: "missing", ok: false };
    const a = await LM.availability(LM_OPTIONS);
    return { availability: String(a), ok: true };
  } catch (e) {
    return { availability: "error", ok: false, error: String(e) };
  }
}

async function createSessionSafe() {
  if (session) return { ok: true, status: "ready" };

  const LM = getLM();
  if (!LM) {
    return { ok: false, status: "unavailable", availability: "missing", engine: "none", errorCode: "LM_MISSING" };
  }

  let availability = "unknown";
  try {
    availability = await LM.availability(LM_OPTIONS);
  } catch (e) {
    return { ok: false, status: "unavailable", availability: "error", engine: "none", errorCode: "LM_AVAILABILITY_ERROR", detail: String(e) };
  }

  // "available" | "downloadable" | "downloading" | "unavailable"
  if (availability !== "available") {
    return { ok: false, status: "unavailable", availability, engine: "none", errorCode: "LM_NOT_AVAILABLE" };
  }

  // Try to pass language hints to avoid Chrome warnings (output language).
  try {
    session = await LM.create({
      ...LM_OPTIONS,
      outputLanguage: "ja"
    });
  } catch (e1) {
    try {
      session = await LM.create({ ...LM_OPTIONS });
    } catch (e2) {
      try {
        session = await LM.create();
      } catch (e3) {
        return { ok: false, status: "unavailable", availability, engine: "none", errorCode: "LM_CREATE_FAILED", detail: String(e3) };
      }
    }
  }

  sessionCreatedAt = Date.now();
  return { ok: true, status: "ready", availability, engine: "prompt_api" };
}

function clampPct(x) {
  const n = Number.isFinite(x) ? x : 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function updateAiProgressFromEvent(e) {
  // Event shapes differ between Chrome versions.
  const loaded = (e && (e.loaded ?? e.detail?.loaded ?? e.bytesDownloaded ?? e.downloadedBytes)) ?? 0;
  const total = (e && (e.total ?? e.detail?.total ?? e.totalBytes ?? e.totalBytesExpected)) ?? 0;
  if (total > 0) {
    aiSetup.progress = Math.max(aiSetup.progress, clampPct((loaded / total) * 100));
  } else if (typeof e?.progress === "number") {
    aiSetup.progress = Math.max(aiSetup.progress, clampPct(e.progress * 100));
  }
}

async function startAiSetup() {
  // Reset state
  aiSetup = { status: "idle", availability: "unknown", progress: 0, errorCode: "", error: "" };

  const LM = getLM();
  if (!LM) {
    aiSetup.status = "unavailable";
    aiSetup.availability = "missing";
    aiSetup.errorCode = "LM_MISSING";
    aiSetup.error = "LanguageModel is undefined";
    return { ok: false, ...aiSetup };
  }

  let availability = "unknown";
  try {
    availability = await LM.availability(LM_OPTIONS);
  } catch (e) {
    aiSetup.status = "error";
    aiSetup.availability = "error";
    aiSetup.errorCode = "LM_AVAILABILITY_ERROR";
    aiSetup.error = String(e);
    return { ok: false, ...aiSetup };
  }

  aiSetup.availability = String(availability);

  // If already ready, create a session normally.
  if (availability === "available") {
    const st = await createSessionSafe();
    if (st.ok) {
      aiSetup.status = "ready";
      aiSetup.progress = 100;
      return { ok: true, ...aiSetup, engine: "prompt_api" };
    }
    aiSetup.status = "error";
    aiSetup.errorCode = st.errorCode || "LM_CREATE_FAILED";
    aiSetup.error = st.detail || st.error || "create_failed";
    return { ok: false, ...aiSetup };
  }

  // Download path (best-effort). We'll attempt create() with a monitor.
  if (availability === "downloadable" || availability === "downloading") {
    aiSetup.status = "downloading";
    aiSetup.progress = 0;
    try {
      session = await LM.create({
        ...LM_OPTIONS,
        outputLanguage: "ja",
        monitor(m) {
          try {
            if (m && typeof m.addEventListener === "function") {
              m.addEventListener("downloadprogress", (e) => {
                updateAiProgressFromEvent(e);
              });
            }
          } catch (_e) {
            // ignore
          }
        }
      });
      sessionCreatedAt = Date.now();
      aiSetup.status = "ready";
      aiSetup.progress = 100;
      return { ok: true, ...aiSetup, engine: "prompt_api" };
    } catch (e) {
      aiSetup.status = "error";
      aiSetup.errorCode = "LM_DOWNLOAD_OR_CREATE_FAILED";
      aiSetup.error = String(e);
      return { ok: false, ...aiSetup };
    }
  }

  aiSetup.status = "unavailable";
  aiSetup.errorCode = "LM_NOT_AVAILABLE";
  aiSetup.error = "not available";
  return { ok: false, ...aiSetup };
}

function shouldResetSessionFromError(err) {
  const s = String(err || "");
  return s.includes("InvalidStateError") || s.includes("session") && s.includes("destroy") || s.includes("The model process crashed");
}

function resetSession(reason) {
  try {
    if (session && typeof session.destroy === "function") session.destroy();
  } catch (_e) {}
  session = null;
  sessionCreatedAt = 0;
  // Keep aiSetup as-is (onboarding UI reads it), but mark error if we were "ready".
  if (aiSetup.status === "ready") {
    aiSetup.status = "error";
    aiSetup.errorCode = "SESSION_RESET";
    aiSetup.error = String(reason || "reset");
  }
}

function sanitizeText(s, maxChars) {
  let t = String(s || "");
  // strip URLs to reduce prompt size
  t = t.replace(/https?:\/\/\S+/g, "");
  t = t.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  // cap per-post length (token safety)
  const cap = Math.max(80, Number(maxChars || 0) || 0);
  const chars = Array.from(t);
  if (cap && chars.length > cap) t = chars.slice(0, cap).join("");
  return t;
}

function buildSchema(topicList, mode) {
  const RISK_ENUM = ["誹謗中傷","政治・扇動","偏見","差別","詐欺・誘導","成人向け","暴力・脅迫","自傷","スパム","その他","なし"];
  const REASON_ENUM = [
    "攻撃的な言い回し","個人への非難","煽り/扇動","属性の一般化","差別的表現",
    "政治的煽動","誤情報の可能性","金銭/誘導","詐欺の可能性","性的示唆","露骨な表現",
    "スパム/宣伝","過度な断定","低情報量","画像のみ","絵文字のみ"
  ];
  const fast = mode === "fast";
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
            score: { type: "integer", minimum: 0, maximum: 100 },
            kind: { type: "string", enum: RISK_ENUM },
            topic: { type: "string", enum: topicList },
            // Fast pass keeps reasons optional and short (stability + speed).
            reasons: { type: "array", maxItems: fast ? 1 : 2, items: { type: "string", enum: REASON_ENUM } }
          },
          required: ["id", "score", "kind", "topic", "reasons"],
          additionalProperties: false
        }
      }
    },
    required: ["results"],
    additionalProperties: false
  };
}

function buildPrompt(batch, topicList, prefs, mode) {
  const persona = (prefs?.characterId === "likoris")
    ? "あなたは「りこりす（Likoris）」です。元気でまっすぐ、でも言葉は短く優しい。"
    : "あなたは「ふぉろね（Forone）」です。少し気怠そうだがユーザーには優しく、説明重視。";

  const fast = mode === "fast";

  const rules = [
    fast
      ? "次のX投稿（複数）について「危険の種類(kind)」「危険度(score)」「トピック(topic)」を高速に判定し、理由タグを最大1つ選ぶ。"
      : "次のX投稿（複数）について「危険の種類(kind)」「危険度(score)」「トピック(topic)」を丁寧に判定し、理由タグ（最大2つ）を選ぶ。",
    "score: 0〜100（高いほど危険）",
    "kind: 誹謗中傷 / 政治・扇動 / 偏見 / 差別 / 詐欺・誘導 / 成人向け / 暴力・脅迫 / 自傷 / スパム / その他 / なし",
    `topic: ${topicList.join(" / ")}`,
    fast ? "reasons: 指定のタグから最大1つ（自由記述は禁止）" : "reasons: 指定のタグから最大2つ（自由記述は禁止）",
    "重要: 誤爆を避け、迷う場合は score を低めにする。",
    "注意: 差別語/露骨な性的表現/誹謗中傷の文言は再掲しない。タグで表現する。",
    "出力はJSONのみ。余計な文は出さない。"
  ].join("\n");

  const payload = batch.map(p => {
    const id = String(p.id || "");
    // Fast pass sends shorter text to reduce token/cost.
    const text = sanitizeText(p.text, fast ? 160 : 320);
    const meta = sanitizeText(p.meta || "", 80);
    return `ID:${id}\nTEXT:${text}${meta ? `\nMETA:${meta}` : ""}`;
  }).join("\n\n---\n\n");
  return `${persona}\n${rules}\n\n${payload}`;
}

async function promptWithLanguageSafe(prompt, schema, outputLanguage) {
  if (!session) throw new Error("no_session");

  const attempt = async () => {
    // Try passing outputLanguage if supported; fall back if not.
    try {
      return await session.prompt(prompt, { responseConstraint: schema, omitResponseConstraintInput: true, outputLanguage: outputLanguage || "ja" });
    } catch (e1) {
      try {
        return await session.prompt(prompt, { responseConstraint: schema, omitResponseConstraintInput: true });
      } catch (e2) {
        // last fallback: no constraint (should be rare / debug)
        return await session.prompt(prompt);
      }
    }
  };

  try {
    return await attempt();
  } catch (e) {
    // If Chrome kills the session (crash / destroy), reset and retry once.
    if (shouldResetSessionFromError(e)) {
      resetSession(e);
      const st = await createSessionSafe();
      if (st.ok && session) {
        return await attempt();
      }
    }
    throw e;
  }
}

async function classifyBatch(batch, topicList, prefs) {
  const st = await createSessionSafe();
  if (!st.ok) return { ok: false, ...st };

  const t0 = Date.now();
  const list = Array.isArray(topicList) && topicList.length ? topicList.map(String).slice(0, 30) : ["その他"];
  const modeFast = true;
  const schemaFast = buildSchema(list, "fast");
  const promptFast = buildPrompt(batch, list, prefs, "fast");

  // ---- Pass 1 (fast) ----
  const raw1 = await promptWithLanguageSafe(promptFast, schemaFast, "ja");
  let obj1 = null;
  try {
    obj1 = JSON.parse(raw1);
  } catch (e) {
    return {
      ok: false,
      status: "error",
      availability: st.availability,
      engine: "prompt_api",
      errorCode: "JSON_PARSE_FAILED",
      detail: String(e),
      raw: String(raw1 || "").slice(0, 500)
    };
  }

  const fastResults = Array.isArray(obj1 && obj1.results) ? obj1.results : [];
  const byId = new Map(fastResults.map(r => [String(r?.id || ""), r]));

  // Decide which posts need confirmation.
  // - Confirm if score is high OR if kind is not "なし" and score is mid-range.
  const toConfirm = [];
  const seen = new Set();
  for (const p of (Array.isArray(batch) ? batch : [])) {
    const id = String(p?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const r = byId.get(id);
    const score = Number(r?.score || 0);
    const kind = String(r?.kind || "なし");
    const confirm = (score >= 60) || (kind !== "なし" && score >= 35);
    if (confirm) toConfirm.push(p);
  }

  // ---- Pass 2 (confirm) ----
  if (toConfirm.length) {
    const schema2 = buildSchema(list, "full");
    const prompt2 = buildPrompt(toConfirm, list, prefs, "full");
    try {
      const raw2 = await promptWithLanguageSafe(prompt2, schema2, "ja");
      const obj2 = JSON.parse(raw2);
      const conf = Array.isArray(obj2 && obj2.results) ? obj2.results : [];
      for (const r of conf) {
        const id = String(r?.id || "");
        if (id) byId.set(id, r);
      }
    } catch (_e) {
      // If confirm fails, keep fast results.
    }
  }

  const merged = [];
  for (const p of (Array.isArray(batch) ? batch : [])) {
    const id = String(p?.id || "");
    const r = byId.get(id);
    if (r) merged.push(r);
  }

  const dt = Date.now() - t0;
  return {
    ok: true,
    status: "ready",
    availability: st.availability,
    engine: "prompt_api",
    latencyMs: dt,
    results: merged
  };
}

// -----------------------------
// Messages from service worker
// -----------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Only handle messages explicitly targeted to the offscreen document.
  // This prevents the offscreen listener from stealing responses intended for the service worker.
  if (!msg || msg.target !== "offscreen") {
    return; // do not return true; we are not responding
  }

  (async () => {
    const type = msg && msg.type;
    if (type === "FOLLONE_OFFSCREEN_STATUS") {
      const a = await availabilitySafe();
      sendResponse({
        ok: true,
        availability: a.availability,
        status: session ? "ready" : (a.availability === "available" ? "ready" : "unavailable"),
        hasSession: !!session,
        sessionAgeSec: session ? Math.round((Date.now() - sessionCreatedAt) / 1000) : 0
      });
      return;
    }

    if (type === "FOLLONE_OFFSCREEN_WARMUP") {
      const st = await createSessionSafe();
      sendResponse({ ...st, hasSession: !!session, sessionAgeSec: session ? Math.round((Date.now() - sessionCreatedAt) / 1000) : 0 });
      return;
    }

    // Onboarding: trigger AI model download / setup (best-effort).
    if (type === "FOLLONE_OFFSCREEN_AI_SETUP_START") {
      const st = await startAiSetup();
      sendResponse({ ...st, hasSession: !!session, sessionAgeSec: session ? Math.round((Date.now() - sessionCreatedAt) / 1000) : 0 });
      return;
    }

    if (type === "FOLLONE_OFFSCREEN_AI_SETUP_STATUS") {
      // If we already have a session, consider AI "ready" for onboarding.
      if (session && aiSetup.status !== "ready") {
        aiSetup.status = "ready";
        aiSetup.availability = aiSetup.availability === "unknown" ? "available" : aiSetup.availability;
        aiSetup.progress = 100;
      }
      sendResponse({ ok: true, ...aiSetup, hasSession: !!session, sessionAgeSec: session ? Math.round((Date.now() - sessionCreatedAt) / 1000) : 0 });
      return;
    }

    if (type === "FOLLONE_OFFSCREEN_CLASSIFY") {
      const batch = Array.isArray(msg.batch) ? msg.batch : [];
      const topicList = Array.isArray(msg.topicList) ? msg.topicList : [];
      const prefs = msg.prefs || {};
      const resp = await classifyBatch(batch, topicList, prefs);
      sendResponse(resp);
      return;
    }

    if (type === "FOLLONE_OFFSCREEN_CHAT") {
      const st = await createSessionSafe();
      if (!st.ok) { sendResponse({ ok: false, ...st }); return; }

      const text = String(msg.text || "").slice(0, 240);
      const prefs = msg.prefs || {};
      const persona = (prefs?.characterId === "likoris")
        ? [
            "あなたは『りこりす』。元気でまっすぐな妹系。",
            "返答はやさしく、安心させる。"
          ].join("\n")
        : [
            "あなたは『ふぉろね』。紫が特徴のダウナーお姉さん系の猫。",
            "ふわっと寄り添うが、言い方は刺さない。"
          ].join("\n");

      // Hard constraint: ALWAYS respond within 30 characters (Japanese).
      // We still post-trim to guarantee the constraint even if the model slips.
      const prompt = [
        persona,
        "ユーザーの発話に返事してください。",
        "制約: 必ず30文字以内。改行しない。余計な前置き・説明をしない。",
        "危険行為や自傷の助言はしない。",
        `USER:${text}`,
        "ASSISTANT:"
      ].join("\n");
      let out = "";
      try {
        out = await session.prompt(prompt, { outputLanguage: "ja" });
      } catch (e1) {
        try { out = await session.prompt(prompt); } catch (e2) { out = ""; }
      }

      // Normalize whitespace and enforce <= 30 chars (codepoint-wise).
      out = String(out || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
      const chars = Array.from(out);
      if (chars.length > 30) out = chars.slice(0, 30).join("");
      if (!out) out = "…"; // keep it minimal; options/UI can decorate

      sendResponse({ ok: true, status: "ready", availability: st.availability, engine: "prompt_api", text: out });
      return;
    }


    sendResponse({ ok: false, errorCode: "UNKNOWN_MESSAGE", detail: String(type) });
  })().catch((e) => {
    sendResponse({ ok: false, status: "error", availability: "error", engine: "none", errorCode: "OFFSCREEN_HANDLER_ERROR", detail: String(e) });
  });
  return true;
});