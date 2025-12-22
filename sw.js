'use strict';

// Service worker:
// - ensures offscreen document exists
// - forwards classify/status/warmup messages to offscreen
// - manages XP storage
// - opens options page

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const OFFSCREEN_REASON = (chrome.offscreen?.Reason?.DOM_PARSER) ?? 'DOM_PARSER';

let ensuringOffscreenPromise = null;

async function hasOffscreenDoc() {
  try {
    if (chrome.offscreen?.hasDocument) return await chrome.offscreen.hasDocument();
  } catch (_) {}

  // Fallback: runtime.getContexts (Chrome 121+)
  try {
    if (chrome.runtime?.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return Array.isArray(ctxs) && ctxs.length > 0;
    }
  } catch (_) {}

  return false;
}

async function ensureOffscreen() {
  if (!chrome.offscreen?.createDocument) return { ok: false, error: 'offscreen_api_unavailable' };
  if (ensuringOffscreenPromise) return ensuringOffscreenPromise;

  ensuringOffscreenPromise = (async () => {
    const exists = await hasOffscreenDoc();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [OFFSCREEN_REASON],
        justification: 'Run Prompt API (LanguageModel) and JSON parsing.'
      });
    }
    return { ok: true };
  })().finally(() => {
    ensuringOffscreenPromise = null;
  });

  return ensuringOffscreenPromise;
}

const XP_KEY = 'follone_xp';

async function getXP() {
  const obj = await chrome.storage.local.get(XP_KEY);
  return Number(obj[XP_KEY] || 0);
}

async function addXP(delta) {
  const cur = await getXP();
  const next = Math.max(0, cur + Number(delta || 0));
  await chrome.storage.local.set({ [XP_KEY]: next });
  return next;
}

async function forwardToOffscreen(payload) {
  const ensured = await ensureOffscreen();
  if (!ensured.ok) return ensured;

  // Offscreen listens for messages with {to:'offscreen'}.
  return await chrome.runtime.sendMessage({ ...payload, to: 'offscreen' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages explicitly addressed to offscreen should be handled by the offscreen document,
  // not by the service worker. Returning false keeps the response channel free.
  if (msg && typeof msg === 'object' && msg.to === 'offscreen') {
    return false;
  }

  (async () => {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'FOLLONE_PING':
        sendResponse({ ok: true, where: 'sw', ts: Date.now() });
        return;

      case 'FOLLONE_GET_XP': {
        const xp = await getXP();
        sendResponse({ ok: true, xp });
        return;
      }

      case 'FOLLONE_ADD_XP': {
        // Backward/forward compatibility: some content scripts send {amount}, others send {delta}.
        const delta = (typeof msg.delta === 'number') ? msg.delta : msg.amount;
        const xp = await addXP(delta);
        sendResponse({ ok: true, xp });
        return;
      }

      case 'FOLLONE_OPEN_OPTIONS': {
        try {
          if (chrome.runtime.openOptionsPage) {
            chrome.runtime.openOptionsPage();
            sendResponse({ ok: true });
          } else {
            const url = chrome.runtime.getURL('options.html');
            await chrome.tabs.create({ url });
            sendResponse({ ok: true });
          }
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      case 'FOLLONE_BACKEND_STATUS':
      case 'FOLLONE_BACKEND_WARMUP':
      case 'FOLLONE_CLASSIFY_BATCH': {
        const t0 = Date.now();
        const resp = await forwardToOffscreen(msg);
        const t1 = Date.now();
        if (resp && typeof resp === 'object') resp.latencyMs = t1 - t0;
        sendResponse(resp);
        return;
      }

      default:
        sendResponse({ ok: false, error: 'unknown_message_type', type: msg.type });
        return;
    }
  })().catch((e) => {
    try { sendResponse({ ok: false, error: String(e) }); } catch (_) {}
  });

  return true; // async
});

// Best-effort: create offscreen when the extension starts.
chrome.runtime.onStartup?.addListener(() => { ensureOffscreen().catch(() => {}); });
chrome.runtime.onInstalled?.addListener(() => { ensureOffscreen().catch(() => {}); });
