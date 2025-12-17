const DEFAULTS = {
  follone_enabled: true,

  // --- Risk / classification ---
  follone_riskThresholdSoft: 65,     // highlight only
  follone_riskThresholdHard: 80,     // scroll lock + overlay

  // batching / performance
  follone_batchSize: 3,
  follone_idleMs: 700,
  follone_maxQueue: 30,

  // --- Filter bubble ---
  follone_topicWindow: 40,
  follone_bubbleDominance: 0.58,     // top category ratio
  follone_bubbleEntropy: 0.55,       // normalized entropy (0..1). lower -> more concentrated
  follone_bubbleMinSamples: 18,
  follone_bubbleCooldownMs: 10 * 60 * 1000,
  follone_bubbleUseLLMSuggest: true,

  // --- Session / report ---
  follone_sessionMinSec: 60,
  follone_inactiveSec: 180,
  follone_reportCooldownSec: 600,
  follone_autoReportSuggest: true,

  // --- Persona / tone ---
  follone_personaLazyKind: true,
  follone_explainMode: true,

  // --- Progress ---
  follone_xp: 0,
  follone_level: 1,
};

const LEVELING = {
  // very light progression curve
  xpPerLevel: 60,
  maxLevel: 25
};

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (cur[k] === undefined) toSet[k] = v;
  }
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
});

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

async function addXp(amount) {
  const add = clamp(amount, 0, 9999);
  const cur = await chrome.storage.local.get(["follone_xp", "follone_level"]);
  const xp = (cur.follone_xp || 0) + add;
  let level = cur.follone_level || 1;

  while (level < LEVELING.maxLevel && xp >= level * LEVELING.xpPerLevel) {
    level += 1;
  }
  await chrome.storage.local.set({ follone_xp: xp, follone_level: level });
  return { xp, level };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "FOLLONE_ADD_XP") {
      const r = await addXp(msg.amount || 0);
      sendResponse({ ok: true, ...r });
      return;
    }
    if (msg?.type === "FOLLONE_GET_PROGRESS") {
      const cur = await chrome.storage.local.get(["follone_xp", "follone_level"]);
      sendResponse({ ok: true, xp: cur.follone_xp || 0, level: cur.follone_level || 1 });
      return;
    }
    if (msg?.type === "FOLLONE_OPEN_OPTIONS") {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false });
      return;
    }
    sendResponse({ ok: false });
  })();
  return true;
});
