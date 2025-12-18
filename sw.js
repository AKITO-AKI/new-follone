// follone service worker (MV3) v0.4.7
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== "string") {
      sendResponse({ ok: false });
      return;
    }

    if (msg.type === "FOLLONE_PING") {
      sendResponse({ ok: true, sw: "ok", sender: sender?.url || "" });
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
