// follone offscreen (MV3) - Prompt API worker
// Notes:
// - No mock fallback. Prompt API must be available or we report ERROR.
// - Optional speed mode: avoid responseConstraint (often slower) unless explicitly enabled.

const TAG = "[ForoneOffscreen]";

let session = null;
let sessionStatus = "not_ready"; // not_ready | ready | unavailable | downloadable | downloading
let lastAvailability = "unknown"; // available | downloadable | downloading | unavailable | no_api

function log(...args) {
  try { console.log(TAG, ...args); } catch (_) {}
}

function safeString(x) {
  try { return String(x); } catch (_) { return ""; }
}

function nowMs() { return Date.now(); }

async function probeAvailability() {
  try {
    const lm = globalThis.LanguageModel;
    if (!lm || typeof lm.availability !== "function") {
      return { availability: "no_api", detail: "LanguageModel not found" };
    }
    const av = await lm.availability();
    return { availability: av, detail: "" };
  } catch (e) {
    return { availability: "unavailable", detail: safeString(e) };
  }
}

async function ensureSession(userInitiated) {
  const probe = await probeAvailability();
  lastAvailability = probe.availability;

  if (probe.availability === "no_api") {
    sessionStatus = "unavailable";
    session = null;
    return { ok: false, status: "unavailable", availability: "no_api", errorCode: "PROMPT_UNAVAILABLE", detail: probe.detail };
  }
  if (probe.availability === "unavailable") {
    sessionStatus = "unavailable";
    session = null;
    return { ok: false, status: "unavailable", availability: "unavailable", errorCode: "PROMPT_UNAVAILABLE", detail: probe.detail };
  }
  if (probe.availability === "downloadable") {
    sessionStatus = "downloadable";
    session = null;
    if (userInitiated) {
      // Try to create() to trigger the model download.
      try {
        if (globalThis.LanguageModel && typeof globalThis.LanguageModel.create === "function") {
          session = await globalThis.LanguageModel.create();
          sessionStatus = "ready";
          lastAvailability = "available";
          return { ok: true, status: "ready", availability: "available" };
        }
      } catch (e) {
        // leave as downloadable; create may throw while initiating download.
        log("create() while downloadable threw:", safeString(e));
      }
    }
    return { ok: false, status: "downloadable", availability: "downloadable", errorCode: "WARMUP_REQUIRED", detail: probe.detail };
  }
  if (probe.availability === "downloading") {
    sessionStatus = "downloading";
    session = null;
    return { ok: false, status: "downloading", availability: "downloading", errorCode: "MODEL_DOWNLOADING", detail: probe.detail };
  }

  // available
  try {
    if (!session) {
      session = await globalThis.LanguageModel.create();
    }
    sessionStatus = "ready";
    lastAvailability = "available";
    return { ok: true, status: "ready", availability: "available" };
  } catch (e) {
    session = null;
    sessionStatus = "unavailable";
    return { ok: false, status: "unavailable", availability: "unavailable", errorCode: "PROMPT_CREATE_FAILED", detail: safeString(e) };
  }
}

// ---------- prompt building & parsing ----------

const RISK_ENUM = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

function clampRisk(x) {
  const s = (x || "").toString().toUpperCase();
  return RISK_ENUM.includes(s) ? s : "LOW";
}

function buildPromptFast(batch, topicList) {
  const topics = Array.isArray(topicList) && topicList.length ? topicList.slice(0, 20).join(", ") : "";
  const items = batch.map((p, i) => {
    const id = p?.id || `i${i}`;
    const txt = (p?.text || "").slice(0, 700);
    return `#${i+1} id=${id}\n${txt}`;
  }).join("\n\n");

  return [
    "You are a safety classifier for social media posts.",
    "Return ONLY valid JSON.",
    "Output format:",
    '{"results":[{"id":"...","risk":"SAFE|LOW|MEDIUM|HIGH|CRITICAL","score":0-100,"topic":"...","reasons":["..."]}]}',
    "Rules:",
    "- Keep reasons short (<= 12 words each).",
    "- If unclear, choose LOW with a conservative score.",
    topics ? `- Topics hint: ${topics}` : "",
    "",
    "Posts:",
    items,
    ""
  ].filter(Boolean).join("\n");
}

function buildSchema(topicList) {
  // Minimal schema; used only when prefs.useConstraint is true.
  const topics = Array.isArray(topicList) ? topicList.slice(0, 40) : [];
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            risk: { type: "string", enum: RISK_ENUM },
            score: { type: "number" },
            topic: { type: "string", enum: topics.length ? topics : undefined },
            reasons: { type: "array", items: { type: "string" } }
          },
          required: ["id", "risk", "score"]
        }
      }
    },
    required: ["results"]
  };
}

function extractJsonObject(text) {
  const s = safeString(text);
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const maybe = s.slice(first, last + 1);
  try { return JSON.parse(maybe); } catch (_) { return null; }
}

function normalizeResults(obj) {
  const arr = Array.isArray(obj?.results) ? obj.results : (Array.isArray(obj) ? obj : []);
  const out = [];
  for (const r of arr) {
    const id = safeString(r?.id || "");
    const risk = clampRisk(r?.risk);
    let score = Number(r?.score);
    if (!Number.isFinite(score)) score = (risk === "SAFE") ? 0 : (risk === "CRITICAL" ? 90 : 40);
    score = Math.max(0, Math.min(100, score));
    const topic = safeString(r?.topic || "");
    const reasons = Array.isArray(r?.reasons) ? r.reasons.map(safeString).filter(Boolean).slice(0, 5) : [];
    out.push({ id, risk, score, topic, reasons });
  }
  return out;
}

async function classifyBatch(batch, topicList, prefs) {
  const p = Object.assign({ fastMode: true, useConstraint: false }, (prefs || {}));
  const st = await ensureSession(false);
  if (!st.ok) return Object.assign({ ok: false, results: [] }, st);

  const t0 = nowMs();
  let raw = "";
  try {
    if (p.useConstraint) {
      const schema = buildSchema(topicList);
      raw = await session.prompt(buildPromptFast(batch, topicList), {
        responseConstraint: schema,
        // Let the model return JSON only (implementation detail varies across builds)
        // omitResponseConstraintInput: true,
      });
    } else {
      // fast path (no constraint)
      raw = await session.prompt(buildPromptFast(batch, topicList));
    }
  } catch (e) {
    return { ok: false, status: "unavailable", availability: lastAvailability, errorCode: "PROMPT_FAILED", detail: safeString(e), results: [] };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = extractJsonObject(raw);
  }
  if (!parsed) {
    return { ok: false, status: "parse_error", availability: lastAvailability, errorCode: "JSON_PARSE_FAILED", detail: "invalid_json", results: [] };
  }

  const results = normalizeResults(parsed);
  const latencyMs = nowMs() - t0;
  return { ok: true, status: "ready", availability: "available", engine: "prompt_api", latencyMs, results };
}

// ---------- message handling ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return;

      if (msg.type === "FOLLONE_OFFSCREEN_STATUS") {
        const probe = await probeAvailability();
        lastAvailability = probe.availability;
        sendResponse({ ok: true, status: sessionStatus, availability: probe.availability, detail: probe.detail || "" });
        return;
      }

      if (msg.type === "FOLLONE_OFFSCREEN_WARMUP") {
        const st = await ensureSession(true);
        sendResponse(st.ok ? { ok: true, status: st.status, availability: st.availability } : st);
        return;
      }

      if (msg.type === "FOLLONE_OFFSCREEN_CLASSIFY_DIRECT") {
        const batch = Array.isArray(msg.batch) ? msg.batch : [];
        const topicList = Array.isArray(msg.topicList) ? msg.topicList : [];
        const prefs = msg.prefs || {};
        const out = await classifyBatch(batch, topicList, prefs);
        sendResponse(out);
        return;
      }
    } catch (e) {
      sendResponse({ ok: false, status: "unavailable", availability: lastAvailability, errorCode: "OFFSCREEN_ERROR", detail: safeString(e), results: [] });
    }
  })();
  return true;
});

log("offscreen ready");
