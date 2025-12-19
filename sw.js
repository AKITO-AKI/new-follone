// follone service worker (MV3) v0.4.8
const DEFAULTS = {
  follone_enabled: true,
  follone_aiMode: "auto", // auto | mock | off
  follone_riskSoftThreshold: 60,
  follone_riskHardThreshold: 75,
  follone_batchSize: 3,
  follone_idleMs: 650,

  // Filter-bubble
  follone_topicWindow: 30,
  follone_bubbleDominance: 0.62,
  follone_bubbleEntropy: 0.55,
  follone_bubbleCooldownMs: 10 * 60 * 1000,
  follone_bubbleMinSamples: 16,
  follone_bubbleUseLLM: true,

  // Report
  follone_reportMinSeconds: 60,
  follone_inactiveSuggestSeconds: 180,
  follone_inactiveCooldownMs: 10 * 60 * 1000,

  // Debug
  follone_debug: true,
  follone_logLevel: "info", // debug | info | warn | error

  // Progress
  follone_xp: 0
};

const PREFIX = "[follone:sw]";
function log(level, ...args) {
  const fn = console[level] || console.log;
  fn.call(console, PREFIX, ...args);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  log("info", "onInstalled", details?.reason);
  const cur = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (cur[k] === undefined) toSet[k] = v;
  }
  if (Object.keys(toSet).length) {
    await chrome.storage.local.set(toSet);
    log("info", "defaults applied", Object.keys(toSet));
  } else {
    log("info", "defaults already present");
  }
});

// -----------------------------
// Offscreen document broker (Prompt API host)
// -----------------------------
const OFFSCREEN_URL = "offscreen.html";
const pending = new Map(); // requestId -> { sendResponse, timer }

function makeId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return String(Date.now()) + "_" + Math.random().toString(16).slice(2);
  }
}

function sendMessageP(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(resp);
    });
  });
}

async function hasOffscreen() {
  // Prefer runtime.getContexts when available.
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
      });
      return Array.isArray(contexts) && contexts.length > 0;
    }
  } catch (_) {}

  // Fallback: best-effort — assume absent and try createDocument.
  return false;
}

async function ensureOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    return { ok: false, error: "offscreen API not available" };
  }
  const exists = await hasOffscreen();
  if (exists) return { ok: true };

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["DOM_PARSER"],
      justification: "Run built-in Prompt API in extension origin (document context) for timeline classification."
    });
  } catch (e) {
    // If it already exists (older Chrome without getContexts), treat as success.
    const msg = String(e?.message || e);
    if (!msg.includes("Only one offscreen") && !msg.includes("already")) {
      return { ok: false, error: msg };
    }
  }
  return { ok: true };
}

async function getBackendStatus() {
  const ensured = await ensureOffscreen();
  if (!ensured.ok) return { ok: false, status: "unavailable", availability: "no_offscreen", error: ensured.error };

  const resp = await sendMessageP({ target: "offscreen", type: "FOLLONE_OFFSCREEN_STATUS" });
  if (!resp || !resp.ok) return { ok: false, status: "unavailable", availability: "error", error: resp?.error || "no_response" };
  return resp;
}

async function forwardClassify(requestId, batch, topicList, priority) {
  const ensured = await ensureOffscreen();
  if (!ensured.ok) {
    chrome.runtime.sendMessage({
      target: "sw",
      type: "FOLLONE_OFFSCREEN_RESULT",
      requestId,
      ok: false,
      status: "unavailable",
      availability: "no_offscreen",
      error: ensured.error,
      results: []
    });
    return;
  }

  // Fire-and-forget; offscreen posts result back to SW via runtime message.
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "FOLLONE_OFFSCREEN_CLASSIFY",
    requestId,
    batch,
    topicList
  }, () => {
    // ignore ack; lastError here is not actionable; timeout will cover it.
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== "string") {
      sendResponse({ ok: false });
      return;
    }

    // Offscreen -> SW result relay
    if (msg.target === "sw" && msg.type === "FOLLONE_OFFSCREEN_RESULT") {
      const requestId = msg.requestId;
      const p = pending.get(requestId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(requestId);
        p.sendResponse({
          ok: Boolean(msg.ok),
          status: msg.status,
          availability: msg.availability,
          results: Array.isArray(msg.results) ? msg.results : [],
          error: msg.error
        });
      }
      // No response expected for this message
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "FOLLONE_PING") {
      sendResponse({ ok: true, sw: "ok", sender: sender?.url || "" });
      return;
    }

    if (msg.type === "FOLLONE_BACKEND_STATUS") {
      const s = await getBackendStatus();
      // Normalize shape expected by content.js
      sendResponse({
        ok: Boolean(s.ok),
        status: s.status || "unavailable",
        availability: s.availability || "unavailable",
        hasSession: Boolean(s.hasSession),
        sessionAgeSec: s.sessionAgeSec || 0,
        error: s.error
      });
      return;
    }

    if (msg.type === "FOLLONE_CLASSIFY_BATCH") {
      const requestId = makeId();
      const batch = Array.isArray(msg.batch) ? msg.batch : [];
      const topicList = Array.isArray(msg.topicList) ? msg.topicList : [];

      // Keep the message channel open.
      const timer = setTimeout(() => {
        const p = pending.get(requestId);
        if (!p) return;
        pending.delete(requestId);
        p.sendResponse({ ok: false, status: "timeout", availability: "unknown", results: [], error: "timeout" });
      }, 25000);

      pending.set(requestId, { sendResponse, timer });
      await forwardClassify(requestId, batch, topicList, msg.priority);
      return;
    }

    if (msg.type === "FOLLONE_GET_XP") {
      const cur = await chrome.storage.local.get(["follone_xp"]);
      sendResponse({ ok: true, xp: cur.follone_xp || 0 });
      return;
    }

    if (msg.type === "FOLLONE_ADD_XP") {
      const add = Number(msg.amount || 0);
      const cur = await chrome.storage.local.get(["follone_xp"]);
      const next = Math.max(0, (cur.follone_xp || 0) + add);
      await chrome.storage.local.set({ follone_xp: next });
      sendResponse({ ok: true, xp: next });
      return;
    }

    if (msg.type === "FOLLONE_OPEN_OPTIONS") {
      try {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }

    sendResponse({ ok: false });
  })().catch((e) => {
    log("error", "message handler error", String(e));
    try { sendResponse({ ok: false, error: String(e) }); } catch (_) {}
  });
  return true;
});
