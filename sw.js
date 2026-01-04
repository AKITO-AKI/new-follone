// follone service worker (MV3) v0.4.36
let _offscreenCreating = null;
let _classifyQueue = Promise.resolve();
let _offscreenResetting = false;

function enqueueSerial(fn) {
  const run = async () => {
    try {
      return await fn();
    } catch (e) {
      return { ok: false, status: "error", availability: "error", errorCode: "EXCEPTION", error: String(e) };
    }
  };
  const p = _classifyQueue.then(run, run);
  // Keep the chain alive even if a job fails.
  _classifyQueue = p.catch(() => undefined);
  return p;
}

async function resetOffscreen(reason) {
  if (_offscreenResetting) return;
  _offscreenResetting = true;
  try {
    log("warn", "resetOffscreen", { reason });
    if (chrome.offscreen && chrome.offscreen.closeDocument) {
      try { await chrome.offscreen.closeDocument(); } catch (_e) {}
    }
  } finally {
    _offscreenCreating = null;
    _offscreenResetting = false;
  }
}

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
  follone_xp: 0,

  // M3: leveling / rewards
  follone_level: 1,
  follone_ownedHead: [],
  follone_equippedHead: "",
  follone_ownedFx: [],
  follone_equippedFx: "",
  follone_quest: null,

  // Dev: simulate Prompt API not installed / unavailable
  follone_simulateNoLM: false,

  // user-facing presets
  follone_characterId: "forone", // forone | likoris
  follone_riskPreset: "normal",  // low | normal | hard
  follone_bubblePopup: true,     // show filter-bubble popup

};

// ---------------------------------
// M3: Leveling / Quests / Rewards
// ---------------------------------
// Keep in sync with content.js (XP_LEVELS). This is only used for unlock logic.
const XP_LEVELS = [0, 10, 25, 45, 70, 100, 140, 190, 250, 320, 400, 500, 620, 760, 920, 1100];

// Head accessories are the primary reward (unlock cadence: every 5 levels).
// IDs must match pet/data/accessories/accessories.json
const HEAD_REWARD_ORDER = [
  "bandage",
  "red ribbon",
  "blue ribbon",
  "gauze",
  "glasses",
  "round glasses",
  "mikan",
  "headphone",
  "earphone",
  "crown"
];

// FX accessories unlock (same cadence: every 5 levels)
const FX_REWARD_ORDER = [
  "キラキラ",
  "ハート",
  "汗",
  "Zzz",
  "音符",
  "湯気",
  "集中線",
  "桜",
  "虹",
  "シャボン玉"
];

function xpToLevel(xp) {
  const x = Math.max(0, Number(xp) || 0);
  let lv = 1;
  for (let i = 1; i < XP_LEVELS.length; i++) {
    if (x >= XP_LEVELS[i]) lv = i + 1;
    else break;
  }
  return lv;
}

function todayKeyJST() {
  // Service worker runs in browser timezone (expected JST for your use case)
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function weekKeyJST() {
  // ISO-ish week key: YYYY-Www
  const d = new Date();
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Thursday in current week decides the year.
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function defaultQuestState() {
  return {
    daily: {
      key: todayKeyJST(),
      // Daily 3
      items: [
        // Safer SNS habits: (1) notice & reflect, (2) diversify viewpoints, (3) step back from heat
        { id: "analyze", label: "危険投稿を見分ける（分析3回）", cur: 0, goal: 3 },
        { id: "search", label: "別視点を検索（1回）", cur: 0, goal: 1 },
        { id: "pause", label: "いったん距離を取る（1回）", cur: 0, goal: 1 }
      ]
    },
    weekly: {
      key: weekKeyJST(),
      // Weekly 1 (aggregate safety actions)
      item: { id: "safe", label: "安全行動を5回", cur: 0, goal: 5 },
      // (optional) guard: count a max of N actions per day, avoid farming
      lastDayKey: "",
      todayCount: 0
    }
  };
}

async function loadProgressState() {
  const keys = [
    "follone_xp",
    "follone_level",
    "follone_ownedHead",
    "follone_equippedHead",
    "follone_ownedFx",
    "follone_equippedFx",
    "follone_quest"
  ];
  const cur = await chrome.storage.local.get(keys);
  const xp = Number(cur.follone_xp || 0);
  const level = Number(cur.follone_level || xpToLevel(xp));
  const ownedHead = Array.isArray(cur.follone_ownedHead) ? cur.follone_ownedHead.map(String) : [];
  const equippedHead = cur.follone_equippedHead ? String(cur.follone_equippedHead) : "";
  let quest = cur.follone_quest && typeof cur.follone_quest === "object" ? cur.follone_quest : defaultQuestState();

  // rollover daily/weekly keys
  const today = todayKeyJST();
  if (!quest.daily || quest.daily.key !== today) {
    const fresh = defaultQuestState();
    quest.daily = fresh.daily;
    // keep weekly as-is
  }
  const wk = weekKeyJST();
  if (!quest.weekly || quest.weekly.key !== wk) {
    const fresh = defaultQuestState();
    quest.weekly = fresh.weekly;
  }

  const ownedFx = Array.isArray(cur.follone_ownedFx) ? cur.follone_ownedFx.map(String) : [];
  const equippedFx = String(cur.follone_equippedFx || "");

  return { xp, level, ownedHead, equippedHead, ownedFx, equippedFx, quest };
}

async function saveProgressState(state) {
  await chrome.storage.local.set({
    follone_xp: state.xp,
    follone_level: state.level,
    follone_ownedHead: state.ownedHead,
    follone_equippedHead: state.equippedHead,
    follone_ownedFx: state.ownedFx,
    follone_equippedFx: state.equippedFx,
    follone_quest: state.quest
  });
}

function rewardIndexForLevel(lv) {
  // Lv5 -> 0, Lv10 -> 1 ...
  if (lv < 5) return -1;
  return Math.floor((lv - 5) / 5);
}

function computeRewardUnlocks(level, ownedHead) {
  const maxIdx = rewardIndexForLevel(level);
  if (maxIdx < 0) return ownedHead;
  const next = new Set(Array.isArray(ownedHead) ? ownedHead : []);
  for (let i = 0; i <= maxIdx && i < HEAD_REWARD_ORDER.length; i++) {
    next.add(HEAD_REWARD_ORDER[i]);
  }
  return Array.from(next);
}

function computeRewardUnlocksFx(level, ownedFx) {
  const maxIdx = rewardIndexForLevel(level);
  if (maxIdx < 0) return ownedFx;
  const next = new Set(Array.isArray(ownedFx) ? ownedFx : []);
  for (let i = 0; i <= maxIdx && i < FX_REWARD_ORDER.length; i++) {
    next.add(FX_REWARD_ORDER[i]);
  }
  return Array.from(next);
}

// -----------------------------
// Runtime metrics (dev-facing)
// -----------------------------
const _metrics = {
  count: 0,
  sumLatencyMs: 0,
  lastLatencyMs: 0,
  samples: [] // last ~30
};

function recordLatency(ms) {
  const v = Math.max(0, Number(ms || 0));
  _metrics.count += 1;
  _metrics.sumLatencyMs += v;
  _metrics.lastLatencyMs = v;
  _metrics.samples.push(v);
  if (_metrics.samples.length > 30) _metrics.samples.shift();
}

async function getSimulateNoLM() {
  try {
    const r = await chrome.storage.local.get(["follone_simulateNoLM"]);
    return Boolean(r.follone_simulateNoLM);
  } catch (_) {
    return false;
  }
}

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

function makeId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return String(Date.now()) + "_" + Math.random().toString(16).slice(2);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sendMessageP(message, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, errorCode: "TIMEOUT", error: "timeout" });
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, errorCode: "RUNTIME_ERROR", error: err.message });
        else resolve(resp);
      });
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ ok: false, errorCode: "SEND_FAILED", error: String(e) });
    }
  });
}

async function sendMessagePRetry(message, { attempts = 3, timeoutMs = 4000, backoffMs = 200 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const resp = await sendMessageP(message, { timeoutMs });
    // Some responses don't include "ok"; treat that as a valid payload.
    if (resp && (resp.ok === true || resp.ok === undefined)) return resp;
    last = resp;
    await sleep(backoffMs * (i + 1));
  }
  return last || { ok: false, errorCode: "NO_RESPONSE", error: "no_response" };
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
    return { ok: false, errorCode: "OFFSCREEN_API_MISSING", error: "chrome.offscreen.createDocument is not available" };
  }

  // If someone calls ensureOffscreen() many times quickly, avoid racing.
  if (_offscreenCreating) return _offscreenCreating;

  _offscreenCreating = (async () => {
    try {
      if (await hasOffscreen()) return { ok: true };
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS", "DOM_PARSER"],
        justification: "Run built-in Prompt API (LanguageModel) in extension origin."
      });
      return { ok: true };
    } catch (e) {
      // Chrome throws if an offscreen document already exists (including ours).
      const msg = String(e?.message || e);
      const already =
        msg.includes("Only one offscreen") ||
        msg.includes("Only a single offscreen") ||
        msg.includes("Only a single offscreen document") ||
        msg.includes("Only one offscreen document");
      if (already) return { ok: true, note: "already_exists" };
      return { ok: false, errorCode: "OFFSCREEN_CREATE_FAILED", error: msg };
    } finally {
      // allow new attempts later
      _offscreenCreating = null;
    }
  })();

  return _offscreenCreating;
}

async function ensureOffscreenReady() {
  const ensured = await ensureOffscreen();
  if (!ensured.ok) return ensured;

  // Wait for offscreen to attach its runtime.onMessage listener.
  // Cold-start can be flaky, so we probe multiple times with short timeouts.
  const probe = { target: "offscreen", type: "FOLLONE_OFFSCREEN_STATUS" };
  for (let i = 0; i < 12; i++) {
    const resp = await sendMessageP(probe, { timeoutMs: 1200 });
    if (resp && resp.ok) {
      return {
        ok: true,
        status: resp.status,
        availability: resp.availability,
        hasSession: !!resp.hasSession,
        sessionAgeSec: resp.sessionAgeSec || 0
      };
    }
    await sleep(150 + i * 60);
  }
  return { ok: false, errorCode: "OFFSCREEN_NO_RESPONSE", error: "offscreen did not respond" };
}

async function getBackendStatus() {
  if (await getSimulateNoLM()) {
    return { ok: false, status: "unavailable", availability: "simulated_unavailable", hasSession: false, sessionAgeSec: 0 };
  }
  const ready = await ensureOffscreenReady();
  if (!ready.ok) {
    return { ok: false, status: "unavailable", availability: "no_offscreen", errorCode: ready.errorCode || "OFFSCREEN_NOT_READY", error: ready.error || "offscreen not ready" };
  }

  // We already pinged STATUS inside ensureOffscreenReady(), but return a consistent object.
  return { ok: true, status: ready.status || "ready", availability: ready.availability || "available", hasSession: !!ready.hasSession, sessionAgeSec: ready.sessionAgeSec || 0 };
}

async function forwardClassify(requestId, batch, topicList, prefs) {
  const ensured = await ensureOffscreen();
  if (!ensured.ok) {
    chrome.runtime.sendMessage({
      target: "sw",
      type: "FOLLONE_OFFSCREEN_RESULT",
      requestId,
      ok: false,
      engine: "none",
      latencyMs: 0,
      status: "unavailable",
      availability: "no_offscreen",
      error: ensured.error,
      results: []
    });
    return;
  }

  // Fire-and-forget; offscreen posts result back to SW via runtime message.
  // Legacy async path (not currently used by content.js). Keep aligned with offscreen direct handler.
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "FOLLONE_OFFSCREEN_CLASSIFY_DIRECT",
    requestId,
    batch,
    topicList,
    prefs: (prefs && typeof prefs === "object") ? prefs : undefined
  }, () => {
    // ignore ack; lastError here is not actionable; timeout will cover it.
  });
}


async function classifyViaOffscreen(batch, topicList, prefs) {
  if (await getSimulateNoLM()) {
    recordLatency(0);
    return {
      ok: false,
      backend: "offscreen",
      status: "unavailable",
      availability: "simulated_unavailable",
      engine: "none",
      latencyMs: 0,
      results: [],
      errorCode: "SIMULATED_UNAVAILABLE",
      error: "simulateNoLM"
    };
  }
  const ready = await ensureOffscreenReady();
  if (!ready.ok) {
    recordLatency(0);
    return {
      ok: false,
      backend: "offscreen",
      status: "unavailable",
      availability: "no_offscreen",
      engine: "none",
      latencyMs: 0,
      results: [],
      errorCode: ready.errorCode || "OFFSCREEN_NOT_READY",
      error: ready.error || "offscreen not ready"
    };
  }

  // If the offscreen document is up but the LanguageModel session is not created yet,
  // the first classify call can become very slow and hit our timeout.
  // Do a lightweight warmup here to stabilize cold-start across tabs.
  if (!ready.hasSession) {
    const w = await sendMessagePRetry(
      { target: "offscreen", type: "FOLLONE_OFFSCREEN_WARMUP" },
      { attempts: 1, timeoutMs: 30000 }
    );
    if (w && w.ok) {
      ready.hasSession = true;
    }
  }

  const t0 = Date.now();
  // Prompt API can take longer on cold start; keep a generous timeout.
  // DO NOT retry here to avoid duplicate, overlapping requests.
  const resp = await sendMessagePRetry({
    target: "offscreen",
    type: "FOLLONE_OFFSCREEN_CLASSIFY",
    batch,
    topicList,
    prefs
  }, { attempts: 1, timeoutMs: 60000 });
  const dt = Date.now() - t0;

  if (!resp) {
    recordLatency(dt);
    return {
      ok: false,
      backend: "offscreen",
      status: "error",
      availability: "error",
      engine: "none",
      latencyMs: dt,
      results: [],
      errorCode: "NO_RESPONSE",
      error: "no_response"
    };
  }

  if (!resp.ok) {
    recordLatency(resp.latencyMs || dt);
    // If the offscreen bridge timed out, it is often stuck. Reset it to recover.
    if (resp.errorCode === "TIMEOUT" || resp.error === "timeout") {
      resetOffscreen("classify_timeout");
    }
    return {
      ok: false,
      backend: "offscreen",
      status: resp.status || "error",
      availability: resp.availability || "error",
      engine: resp.engine || "none",
      latencyMs: resp.latencyMs || dt,
      results: [],
      errorCode: resp.errorCode || resp.error || "BACKEND_NOT_OK",
      error: resp.detail || resp.error || "backend_not_ok"
    };
  }

  const rawResults = Array.isArray(resp.results) ? resp.results : [];
  const results = rawResults.map((r) => {
    // Normalize shapes across versions
    const id = String(r?.id || "");
    const riskScore = Number((r && (r.riskScore ?? r.score)) || 0);
    const riskCategory = String((r && (r.riskCategory ?? r.kind)) || "その他");
    const topicCategory = String((r && (r.topicCategory ?? r.topic)) || "その他");
    const reasons = Array.isArray(r?.reasons) ? r.reasons.slice(0, 2).map(String) : [];
    return { id, riskScore, riskCategory, topicCategory, reasons };
  });

  recordLatency(resp.latencyMs || dt);
  return {
    ok: true,
    backend: "offscreen",
    status: resp.status || "ready",
    availability: resp.availability || ready.availability || "available",
    engine: resp.engine || "prompt_api",
    latencyMs: resp.latencyMs || dt,
    results
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === "offscreen") return false;
  (async () => {
    if (!msg || typeof msg.type !== "string") {
      sendResponse({ ok: false });
      return;
    }

    if (msg.type === "FOLLONE_PING") {
      sendResponse({ ok: true, sw: "ok", sender: sender?.url || "" });
      return;
    }

    // Utility: open the options page (used by onboarding from content script).
    if (msg.type === "FOLLONE_OPEN_OPTIONS") {
      try {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, errorCode: "OPEN_OPTIONS_FAILED", error: String(e) });
      }
      return;
    }

    // Onboarding: trigger Prompt API model setup (best-effort, with progress polling).
    if (msg.type === "FOLLONE_AI_SETUP_START") {
      if (await getSimulateNoLM()) {
        sendResponse({ ok: false, status: "unavailable", availability: "simulated_unavailable", errorCode: "SIMULATED_UNAVAILABLE", error: "simulateNoLM" });
        return;
      }
      const ready = await ensureOffscreenReady();
      if (!ready.ok) {
        sendResponse({ ok: false, status: "unavailable", availability: "no_offscreen", errorCode: ready.errorCode || "OFFSCREEN_NOT_READY", error: ready.error || "offscreen not ready" });
        return;
      }
      const resp = await sendMessagePRetry({ target: "offscreen", type: "FOLLONE_OFFSCREEN_AI_SETUP_START" }, { attempts: 1, timeoutMs: 60000 });
      if (resp && resp.ok && resp.status === "ready") {
        await chrome.storage.local.set({ follone_ai_ready: true });
      }
      sendResponse(resp || { ok: false, status: "error", availability: "error", errorCode: "NO_RESPONSE", error: "no_response" });
      return;
    }

    if (msg.type === "FOLLONE_AI_SETUP_STATUS") {
      if (await getSimulateNoLM()) {
        sendResponse({ ok: false, status: "unavailable", availability: "simulated_unavailable", errorCode: "SIMULATED_UNAVAILABLE", error: "simulateNoLM" });
        return;
      }
      const ready = await ensureOffscreenReady();
      if (!ready.ok) {
        sendResponse({ ok: false, status: "unavailable", availability: "no_offscreen", errorCode: ready.errorCode || "OFFSCREEN_NOT_READY", error: ready.error || "offscreen not ready" });
        return;
      }
      const resp = await sendMessagePRetry({ target: "offscreen", type: "FOLLONE_OFFSCREEN_AI_SETUP_STATUS" }, { attempts: 1, timeoutMs: 10000 });
      sendResponse(resp || { ok: false, status: "error", availability: "error", errorCode: "NO_RESPONSE", error: "no_response" });
      return;
    }

    
    if (msg.type === "FOLLONE_BACKEND_WARMUP") {
      if (await getSimulateNoLM()) {
        sendResponse({ ok: false, status: "unavailable", availability: "simulated_unavailable", errorCode: "SIMULATED_UNAVAILABLE", error: "simulateNoLM" });
        return;
      }
      const ready = await ensureOffscreenReady();
      if (!ready.ok) {
        sendResponse({
          ok: false,
          status: "unavailable",
          availability: "no_offscreen",
          errorCode: ready.errorCode || "OFFSCREEN_NOT_READY",
          error: ready.error || "offscreen not ready"
        });
        return;
      }
      const resp = await sendMessagePRetry({ target: "offscreen", type: "FOLLONE_OFFSCREEN_WARMUP" }, { attempts: 2, timeoutMs: 20000 });
      if (!resp) {
        sendResponse({ ok: false, status: "error", availability: "error", errorCode: "NO_RESPONSE", error: "no_response" });
        return;
      }
      if (!resp.ok) {
        sendResponse({
          ok: false,
          status: resp.status || "unavailable",
          availability: resp.availability || "error",
          errorCode: resp.errorCode || "BACKEND_NOT_OK",
          error: resp.detail || resp.error || "backend_not_ok"
        });
        return;
      }
      sendResponse({
        ok: true,
        status: resp.status || "ready",
        availability: resp.availability || "available",
        hasSession: Boolean(resp.hasSession),
        sessionAgeSec: resp.sessionAgeSec || 0
      });
      return;
    }

    if (msg.type === "FOLLONE_BACKEND_STATUS") {
      const s = await getBackendStatus();
      sendResponse({
        ok: Boolean(s.ok),
        status: s.status || "unavailable",
        availability: s.availability || "unavailable",
        hasSession: Boolean(s.hasSession),
        sessionAgeSec: s.sessionAgeSec || 0,
        errorCode: s.errorCode,
        error: s.error
      });
      return;
    }

    if (msg.type === "FOLLONE_CLASSIFY_BATCH") {
      const batch = Array.isArray(msg.batch) ? msg.batch : [];
      const topicList = Array.isArray(msg.topicList) ? msg.topicList : [];
      const prefs = (msg.prefs && typeof msg.prefs === "object") ? msg.prefs : undefined;
      const resp = await enqueueSerial(() => classifyViaOffscreen(batch, topicList, prefs));
      sendResponse(resp);
      return;
    }

    if (msg.type === "FOLLONE_GET_XP") {
      const cur = await chrome.storage.local.get(["follone_xp"]);
      sendResponse({ ok: true, xp: cur.follone_xp || 0 });
      return;
    }

    if (msg.type === "FOLLONE_ADD_XP") {
      const add = Number(msg.amount || 0);
      const st = await loadProgressState();
      const nextXp = Math.max(0, (st.xp || 0) + add);
      const prevLv = Number(st.level || 1);
      const nextLv = xpToLevel(nextXp);

      const nextOwned = computeRewardUnlocks(nextLv, st.ownedHead);
      const nextOwnedFx = computeRewardUnlocksFx(nextLv, st.ownedFx);
      // Auto-equip first unlocked item if none equipped.
      let equip = st.equippedHead || "";
      if (!equip && nextOwned.length) equip = String(nextOwned[0]);
      let equipFx = st.equippedFx || "";
      if (!equipFx && nextOwnedFx.length) equipFx = String(nextOwnedFx[0]);

      const nextState = {
        ...st,
        xp: nextXp,
        level: nextLv,
        ownedHead: nextOwned,
        equippedHead: equip,
        ownedFx: nextOwnedFx,
        equippedFx: equipFx
      };
      await saveProgressState(nextState);

      sendResponse({ ok: true, xp: nextXp, level: nextLv, leveledUp: nextLv > prevLv, unlockedHead: nextOwned, unlockedFx: nextOwnedFx, equippedFx: nextState.equippedFx });
      return;
    }

    // M3: progress + quests + inventory
    if (msg.type === "FOLLONE_GET_PROGRESS") {
      const st = await loadProgressState();
      // Ensure rewards match current XP in case XP was migrated.
      const fixedLv = xpToLevel(st.xp);
      const fixedOwned = computeRewardUnlocks(fixedLv, st.ownedHead);
      const fixedEquip = fixedOwned.includes(st.equippedHead) ? st.equippedHead : (fixedOwned[0] || "");
      const fixedOwnedFx = computeRewardUnlocksFx(fixedLv, st.ownedFx);
      const fixedEquipFx = fixedOwnedFx.includes(st.equippedFx) ? st.equippedFx : (fixedOwnedFx[0] || "");
      const nextState = { ...st, level: fixedLv, ownedHead: fixedOwned, equippedHead: fixedEquip, ownedFx: fixedOwnedFx, equippedFx: fixedEquipFx };
      await saveProgressState(nextState);
      sendResponse({ ok: true, ...nextState });
      return;
    }

    if (msg.type === "FOLLONE_EQUIP_HEAD") {
      const id = String(msg.id || "");
      const st = await loadProgressState();
      const ok = id === "" || (Array.isArray(st.ownedHead) && st.ownedHead.includes(id));
      if (!ok) {
        sendResponse({ ok: false, error: "not_owned" });
        return;
      }
      const nextState = { ...st, equippedHead: id };
      await saveProgressState(nextState);
      sendResponse({ ok: true, equippedHead: id });

if (msg.type === "FOLLONE_EQUIP_FX") {
  const id = String(msg.id || "");
  const st = await loadProgressState();
  const ok = id === "" || (Array.isArray(st.ownedFx) && st.ownedFx.includes(id));
  if (!ok) {
    sendResponse({ ok: false, error: "not_owned" });
    return;
  }
  const nextState = { ...st, equippedFx: id };
  await saveProgressState(nextState);
  sendResponse({ ok: true, equippedFx: id });
  return;
}

      return;
    }

    if (msg.type === "FOLLONE_RECORD_EVENT") {
      const kind = String(msg.kind || "");
      const st = await loadProgressState();
      const today = todayKeyJST();

      // Convenience helpers
      const bumpDaily = (id, n = 1) => {
        const items = Array.isArray(st.quest?.daily?.items) ? st.quest.daily.items : [];
        for (const it of items) {
          if (it.id === id) {
            it.cur = Math.min(it.goal, (Number(it.cur || 0) + n));
          }
        }
      };
      const bumpWeeklySafe = (n = 1) => {
        const w = st.quest?.weekly;
        if (!w || !w.item || w.item.id !== "safe") return;
        // Soft anti-farm: count at most 3 safety actions per day.
        if (w.lastDayKey !== today) {
          w.lastDayKey = today;
          w.todayCount = 0;
        }
        const cap = 3;
        const allowed = Math.max(0, cap - Number(w.todayCount || 0));
        const inc = Math.min(allowed, Math.max(0, n));
        if (inc <= 0) return;
        w.todayCount = Number(w.todayCount || 0) + inc;
        w.item.cur = Math.min(w.item.goal, Number(w.item.cur || 0) + inc);
      };

      // Daily quests (safety-oriented)
      if (kind === "analysis_done") { bumpDaily("analyze", 1); bumpWeeklySafe(1); }
      if (kind === "search_open") { bumpDaily("search", 1); bumpWeeklySafe(1); }
      if (kind === "safety_pause") { bumpDaily("pause", 1); bumpWeeklySafe(1); }

      // Optional: count opening settings as a weekly safety action (no daily slot)
      if (kind === "settings_open") bumpWeeklySafe(1);

      await saveProgressState(st);
      sendResponse({ ok: true, quest: st.quest });
      return;
    }

    // -----------------------------
    // Dev utilities
    // -----------------------------
    if (msg.type === "FOLLONE_GET_METRICS") {
      const avg = _metrics.count ? (_metrics.sumLatencyMs / _metrics.count) : 0;
      sendResponse({ ok: true, count: _metrics.count, avgLatencyMs: avg, lastLatencyMs: _metrics.lastLatencyMs });
      return;
    }

    if (msg.type === "FOLLONE_SIMULATE_NOLM_GET") {
      const value = await getSimulateNoLM();
      sendResponse({ ok: true, value });
      return;
    }

    if (msg.type === "FOLLONE_SIMULATE_NOLM_SET") {
      const value = Boolean(msg.value);
      await chrome.storage.local.set({ follone_simulateNoLM: value });
      // If turning on simulation, kill offscreen to avoid background warmups.
      if (value) resetOffscreen("simulate_no_lm");
      sendResponse({ ok: true, value });
      return;
    }

    if (msg.type === "FOLLONE_FACTORY_RESET") {
      try {
        // Clear all local data, then restore DEFAULTS to mimic fresh install.
        await chrome.storage.local.clear();
        await chrome.storage.local.set({ ...DEFAULTS });
        resetOffscreen("factory_reset");
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
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

    if (msg.type === "FOLLONE_CHAT") {
      if (await getSimulateNoLM()) {
        sendResponse({ ok: false, status: "unavailable", availability: "simulated_unavailable", errorCode: "SIMULATED_UNAVAILABLE", error: "simulateNoLM" });
        return;
      }
      const text = String(msg.text || "").slice(0, 240);
      const cur = await chrome.storage.local.get(["follone_characterId"]);
      const prefs = { characterId: cur.follone_characterId || "forone" };

      const ready = await ensureOffscreenReady();
      if (!ready.ok) {
        sendResponse({ ok: false, status: "unavailable", availability: "no_offscreen", errorCode: ready.errorCode || "OFFSCREEN_NOT_READY", error: ready.error || "offscreen not ready" });
        return;
      }
      const resp = await sendMessagePRetry({ target: "offscreen", type: "FOLLONE_OFFSCREEN_CHAT", text, prefs }, { attempts: 1, timeoutMs: 20000 });
      if (!resp) { sendResponse({ ok: false, status: "error", availability: "error", errorCode: "NO_RESPONSE", error: "no_response" }); return; }
      if (!resp.ok) { sendResponse({ ok: false, status: resp.status || "error", availability: resp.availability || "error", errorCode: resp.errorCode || resp.error || "BACKEND_NOT_OK", error: resp.detail || resp.error || "backend_not_ok" }); return; }
      sendResponse({ ok: true, text: String(resp.text || "") });
      return;
    }


    sendResponse({ ok: false });
  })().catch((e) => {
    log("error", "message handler error", String(e));
    try { sendResponse({ ok: false, error: String(e) }); } catch (_) {}
  });
  return true;
});
