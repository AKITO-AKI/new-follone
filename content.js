// follone content script (v0.4.6)
// - Prompt API (Gemini Nano) が利用できない環境でも "mock" で動くようにする。
// - This file avoids invisible/invalid characters.

(() => {
  "use strict";

  // Compatibility: legacy sprite animator hook (no-op in PetEngine era)
  function ensureSpriteAnim() {}

  const host = location.hostname.toLowerCase();
  const isX = host.endsWith("x.com") || host.endsWith("twitter.com");
  if (!isX) return;

  // -----------------------------
  // Constants
  // -----------------------------
  const RISK_ENUM = ["誹謗中傷", "政治", "偏見", "差別", "詐欺", "成人向け", "なし"];


  const REASON_ENUM = ["攻撃的な言い回し", "個人への非難", "煽り/扇動", "属性の一般化", "差別的表現", "政治的煽動", "誤情報の可能性", "金銭/誘導", "詐欺の可能性", "性的示唆", "露骨な表現", "スパム/宣伝", "過度な断定", "低情報量", "画像のみ", "絵文字のみ"];

  // Bias/Topic buckets (12): designed to reduce "その他" while keeping explanations simple.
  // NOTE: "国際" is merged into "社会" to make room for "イラスト/漫画".
  const FALLBACK_TOPICS = [
    "社会",
    "政治",
    "経済",
    "テック",
    "科学",
    "教育",
    "健康",
    "スポーツ",
    "エンタメ",
    "イラスト/漫画",
    "趣味/生活",
    "その他"
  ];

  // Prompt API language options
  const LM_OPTIONS = {
    expectedInputs: [{ type: "text", languages: ["ja", "en"] }],
    expectedOutputs: [{ type: "text", languages: ["ja"] }]
  };

  // -----------------------------
  // Settings
  // -----------------------------
  const settings = {
    enabled: true,
    characterId: "forone", // forone | likoris
    riskPreset: "normal", // low | normal | hard
    bubblePopup: true,
    debug: true,
    uiMode: "user", // user | dev
    fastMode: true,
    useConstraint: true,
    forceLLM: false,
    showPostIds: false,
    logLevel: "info", // debug | info | warn | error
    aiMode: "auto", // auto | off (mock disabled)
    fastMode: true,            // speed-optimized prompt
    useConstraint: false,      // use responseConstraint (slower)
    forceLLM: false,           // ignore hash-cache hits (dev)
    showPostIds: false,        // show mapping tag on timeline (dev)
    uiMode: "user",            // user | dev (options UI only)
    riskSoft: 60,
    riskHard: 75,
    batchSize: 3,
    idleMs: 650,
    // Prompt API input guard (keeps cold-start stable)
    // NOTE: This is an upper bound; most timeline posts are far shorter.
    maxTextChars: 500,

    topicWindow: 30,
    bubbleDominance: 0.62,
    bubbleEntropy: 0.55,
    bubbleCooldownMs: 10 * 60 * 1000,
    bubbleMinSamples: 16,
    bubbleUseLLM: true,

    reportMinSeconds: 60,
    inactiveSuggestSeconds: 180,
    inactiveCooldownMs: 10 * 60 * 1000,

    topics: FALLBACK_TOPICS.slice(),

    // v0.4.11 performance knobs
    cacheMax: 900,
    cachePersistMs: 700,
    skipMediaOnly: true,
    skipEmojiOnly: true
  };

  async function loadSettings() {
    // Read all known keys (missing keys fall back to defaults)
    const keys = [
      "follone_enabled",
      "follone_aiMode",
      "follone_riskSoftThreshold",
      "follone_riskHardThreshold",
      "follone_batchSize",
      "follone_idleMs",
      "follone_topics",
      "follone_topicWindow",
      "follone_bubbleDominance",
      "follone_bubbleEntropy",
      "follone_bubbleCooldownMs",
      "follone_bubbleMinSamples",
      "follone_bubbleUseLLM",
      "follone_reportMinSeconds",
      "follone_inactiveSuggestSeconds",
      "follone_inactiveCooldownMs",
      "follone_debug",
      "follone_logLevel",
      "follone_uiMode",
      "follone_fastMode",
      "follone_useConstraint",
      "follone_forceLLM",
      "follone_showPostIds",
      "follone_characterId",
      "follone_riskPreset",
      "follone_bubblePopup"
    ];

    const cur = await chrome.storage.local.get(keys);

    settings.enabled = cur.follone_enabled ?? settings.enabled;
    settings.aiMode = cur.follone_aiMode ?? settings.aiMode;
    settings.riskSoft = Number(cur.follone_riskSoftThreshold ?? settings.riskSoft);
    settings.riskHard = Number(cur.follone_riskHardThreshold ?? settings.riskHard);
    settings.batchSize = Number(cur.follone_batchSize ?? settings.batchSize);
    settings.idleMs = Number(cur.follone_idleMs ?? settings.idleMs);

    if (Array.isArray(cur.follone_topics)) settings.topics = cur.follone_topics.map(String);
    // M6 bias v2: migrate legacy 20-topic defaults -> 12-topic defaults (coarser buckets reduce "その他")
    const legacyTopics = [
      "社会","政治","経済","国際","テック","科学","教育","健康",
      "スポーツ","エンタメ","音楽","映画/アニメ","ゲーム","趣味",
      "創作","生活","旅行","歴史","ビジネス","その他"
    ];
    try {
      const t = settings.topics;
      const isLegacy = Array.isArray(t) && t.length === legacyTopics.length && t.every((v,i) => String(v) === legacyTopics[i]);
      if (isLegacy) settings.topics = FALLBACK_TOPICS.slice();
    } catch (_) {}

    // M6 bias v2.1: migrate previous 12-topic defaults (with "国際") -> new 12 topics ("イラスト/漫画" added)
    const prev12 = [
      "社会","政治","経済","国際","テック","科学","教育","健康","スポーツ","エンタメ","趣味/生活","その他"
    ];
    try {
      const t = settings.topics;
      const isPrev12 = Array.isArray(t) && t.length === prev12.length && t.every((v,i) => String(v) === prev12[i]);
      if (isPrev12) settings.topics = FALLBACK_TOPICS.slice();
    } catch (_) {}


    settings.topicWindow = Number(cur.follone_topicWindow ?? settings.topicWindow);
    settings.bubbleDominance = Number(cur.follone_bubbleDominance ?? settings.bubbleDominance);
    settings.bubbleEntropy = Number(cur.follone_bubbleEntropy ?? settings.bubbleEntropy);
    settings.bubbleCooldownMs = Number(cur.follone_bubbleCooldownMs ?? settings.bubbleCooldownMs);
    settings.bubbleMinSamples = Number(cur.follone_bubbleMinSamples ?? settings.bubbleMinSamples);
    settings.bubbleUseLLM = Boolean(cur.follone_bubbleUseLLM ?? settings.bubbleUseLLM);

    settings.reportMinSeconds = Number(cur.follone_reportMinSeconds ?? settings.reportMinSeconds);
    settings.inactiveSuggestSeconds = Number(cur.follone_inactiveSuggestSeconds ?? settings.inactiveSuggestSeconds);
    settings.inactiveCooldownMs = Number(cur.follone_inactiveCooldownMs ?? settings.inactiveCooldownMs);

    settings.debug = Boolean(cur.follone_debug ?? settings.debug);
    settings.logLevel = String(cur.follone_logLevel ?? settings.logLevel);

    settings.uiMode = String(cur.follone_uiMode ?? settings.uiMode);
    settings.fastMode = Boolean(cur.follone_fastMode ?? settings.fastMode);
    settings.useConstraint = Boolean(cur.follone_useConstraint ?? settings.useConstraint);
    settings.forceLLM = Boolean(cur.follone_forceLLM ?? settings.forceLLM);
    settings.showPostIds = Boolean(cur.follone_showPostIds ?? settings.showPostIds);

    settings.characterId = String(cur.follone_characterId ?? settings.characterId);
    settings.riskPreset = String(cur.follone_riskPreset ?? settings.riskPreset);
    settings.bubblePopup = Boolean(cur.follone_bubblePopup ?? settings.bubblePopup);

    // Apply presets (user-mode simple tuning)
    if (settings.riskPreset === "low") {
      settings.riskSoft = 70;
      settings.riskHard = 85;
    } else if (settings.riskPreset === "hard") {
      settings.riskSoft = 50;
      settings.riskHard = 65;
    }

    log("info","[SETTINGS] loaded", { enabled: settings.enabled, aiMode: settings.aiMode, preset: settings.riskPreset, char: settings.characterId, debug: settings.debug, logLevel: settings.logLevel, batchSize: settings.batchSize });
  }

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    session: null,
    sessionStatus: "not_ready", // not_ready | downloading | ready | unavailable | mock | off
    inFlight: false,
    lastScrollTs: Date.now(),
    lastUserActivityTs: Date.now(),
    lastInactiveSuggestTs: 0,

    _lastTabNavTs: 0,

    // Intervention arming / smoothness
    bootTs: Date.now(),
    userInteracted: false,
    firstInteractionTs: 0,
    interveneHold: new Map(), // id -> { stage: 'centered', since }

    processed: new WeakSet(),
    queue: [],
    riskCache: new Map(),
    elemById: new Map(),

    // Highlight / intervention gating
    pendingInterventions: new Map(), // id -> { elem, res, ctx, ts }
    highlightFlushTimer: 0,



    // v0.4.10 pre-analysis pipeline
    sentForAnalysis: new Set(),
    intervenedIds: new Set(),
    analyzeHigh: [],
    analyzeLow: [],
    discoverQueue: [],
    discoverScheduled: false,
    analyzeScheduled: false,
    analyzingVisible: new Set(),

    // v0.4.12: queue upgrade/dedupe helpers
    pendingPriority: new Map(),
    enqSeq: 0,
    seqById: new Map(),
    canceledIds: new Set(),

    // v0.4.12: hash caches
    hashById: new Map(),
    hashCache: new Map(),

    // persistent cache shadow
    persistentCache: null,

    // Topic stats (rolling window)
    topicHistory: [],
    topicNewFlags: [],      // 1 if the topic was "new" when observed (session-first)
    topicSeen: new Set(),   // session-first detection
    topicCounts: new Map(),
    lastBubbleTs: 0,

    // Bias dashboard (v2: Focus/Variety/Explore)
    dashFocusPct: 0,
    dashVarietyVal: 0,
    dashVarietyPct: 0,
    dashExplorePct: 0,
    dashTopTopic: null,
    dashQueries: [],
    dashQueryIndex: 0,

    // Bias aggregation for Options dashboard (calendar buckets)
    biasAgg: null,          // { tz, topics, day:{}, updatedAt }
    biasAggDirty: false,
    biasAggFlushTimer: 0,
    biasDayKey: "",
    biasDaySeen: new Set(),

    riskCount: 0,

    // v0.4.32: spotlight intervention runtime
    spotlightOpen: false,
    spotlightId: null,
    spotlightElem: null,
    spotlightRestore: null,
    spotlightLayoutTimer: 0
  };

  // -----------------------------
  // PetEngine (Canvas) - Overlay avatar rendering
  // -----------------------------
  const petUI = {
    charId: null,
    char: null,
    accessories: null,
    loading: false,
    engines: new Map() // key: containerId -> PetEngine instance
  };

  function normalizeCharId(id){
    if (!id) return "follone";
    return (id === "forone") ? "follone" : id;
  }

  function ensurePetCanvas(containerId){
    const box = document.getElementById(containerId);
    if (!box) return null;
    // Already mounted
    const existing = box.querySelector("canvas");
    if (existing) return existing;

    box.textContent = "";
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    canvas.style.width = "64px";
    canvas.style.height = "64px";
    canvas.style.imageRendering = "pixelated";
    box.appendChild(canvas);

    try {
      if (window.PetEngine) {
        const eng = new window.PetEngine({ canvas });
        petUI.engines.set(containerId, eng);
      }
    } catch (e) {
      log("warn","[PET]","PetEngine init failed", String(e));
    }
    return canvas;
  }

  async function ensurePetAssets(){
    const desired = normalizeCharId(settings.characterId);
    if (petUI.loading) return;
    if (petUI.char && petUI.accessories && petUI.charId === desired) return;

    petUI.loading = true;
    try {
      const base = "pet/data";
      const charURL = chrome.runtime.getURL(`${base}/characters/${desired}.json`);
      const accURL  = chrome.runtime.getURL(`${base}/accessories/accessories.json`);

      const resChar = await fetch(charURL, { cache: "no-store" });
      if (!resChar.ok) throw new Error(`char fetch failed ${resChar.status}`);
      petUI.char = await resChar.json();

      const resAcc = await fetch(accURL, { cache: "no-store" });
      if (!resAcc.ok) throw new Error(`acc fetch failed ${resAcc.status}`);
      petUI.accessories = await resAcc.json();

      petUI.charId = desired;
    } catch (e) {
      log("warn","[PET]","assets load failed", String(e));
    } finally {
      petUI.loading = false;
    }
  }

  async function renderPetAvatars(){
    // Mount canvases if containers exist
    ensurePetCanvas("follone-avatar");
    ensurePetCanvas("follone-ov-avatar");
    ensurePetCanvas("follone-sp-avatar");

    await ensurePetAssets();

    if (!petUI.char) return;

    for (const [containerId, eng] of petUI.engines.entries()) {
      try {
        eng.renderPet({
          char: petUI.char,
          accessories: petUI.accessories,
          eyesVariant: "normal",
          mouthVariant: "idle",
          equip: { head: state.equippedHead || null, fx: state.equippedFx || null }
        });
      } catch (e) {
        // Don't break the UI
      }
    }
  }





  // -----------------------------
  // Logging
  // -----------------------------
  const LOG_PREFIX = "[follone]";
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const ring = [];
  const RING_MAX = 80;

  function shouldLog(level) {
    if (!settings.debug) return false;
    const cur = LEVELS[settings.logLevel] ?? 20;
    const want = LEVELS[level] ?? 20;
    return want >= cur;
  }

  function pushRing(line) {
    ring.push(line);
    if (ring.length > RING_MAX) ring.shift();
    const box = document.getElementById("follone-logbox");
    if (box) {
      box.textContent = ring.slice(-10).join("\n");
    }
  }

  function log(level, tag, ...args) {
    if (!shouldLog(level)) return;
    const t = new Date().toISOString().slice(11, 19);
    const head = `${LOG_PREFIX} ${t} ${tag}`;
    const fn = console[level] || console.log;
    fn.call(console, head, ...args);
    try {
      const line = [head, ...args.map(a => (typeof a === "string" ? a : JSON.stringify(a)))].join(" ");
      pushRing(line.length > 400 ? line.slice(0, 400) + "…" : line);
    } catch (_e) {
      log("error","[BACKEND]","create() failed -> mock", String(_e));
      pushRing(head + " (unserializable)");
    }
  }



  // -----------------------------
  // Extension context guards (prevents noisy "Extension context invalidated" crashes after reload/update)
  // -----------------------------
  function isContextInvalidated(err) {
    const s = String(err && (err.message || err) || "");
    return (
      s.includes("Extension context invalidated") ||
      s.includes("context invalidated") ||
      s.includes("message channel closed") ||
      s.includes("The message port closed") ||
      s.includes("A listener indicated an asynchronous response")
    );
  }

  
  // ---------------------------------
  // Extension context invalidation UX
  // ---------------------------------
  function showCtxBanner() {
    try {
      const existing = document.getElementById("follone-ctx-banner");
      if (existing) return;

      const d = document.createElement("div");
      d.id = "follone-ctx-banner";
      d.innerHTML = `
        <div class="ctxCard">
          <div class="ctxTitle">follone が更新されたみたい</div>
          <div class="ctxBody" id="follone-ctx-body">ページを再読み込みすると再接続できるよ。</div>
          <div class="ctxRow">
            <button id="follone-ctx-reload">再読み込み</button>
            <button id="follone-ctx-dismiss" class="ghost">閉じる</button>
          </div>
        </div>`;
      document.documentElement.appendChild(d);

      let cancelled = false;
      let n = 3;
      const body = d.querySelector("#follone-ctx-body");
      const tick = () => {
        if (cancelled) return;
        if (body) body.textContent = `再接続のため、${n}秒後に自動で再読み込みするよ。`;
        if (n <= 0) {
          try { location.reload(); } catch (_) {}
          return;
        }
        n--;
        setTimeout(tick, 1000);
      };
      setTimeout(tick, 0);

      d.querySelector("#follone-ctx-reload")?.addEventListener("click", () => {
        cancelled = true;
        location.reload();
      });
      d.querySelector("#follone-ctx-dismiss")?.addEventListener("click", () => {
        cancelled = true;
        d.remove();
      });
    } catch (_) {}
  }

function onContextInvalidated(err) {
    if (state.contextInvalidated) return;
    state.contextInvalidated = true;
    state.sessionStatus = "off";
    log("warn", "[CTX]", "Extension context invalidated. Reload the page to reattach the extension.", String(err));
    try { hideLoader(); } catch (_) {}
    try { renderWidget(); } catch (_) {}
    try { showCtxBanner(); } catch (_) {}
  }

  async function sendMessageSafe(msg) {
    if (state.contextInvalidated) return null;
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (isContextInvalidated(e)) {
        onContextInvalidated(e);
        return null;
      }
      throw e;
    }
  }

  
  async function sendMessageSafeRetry(msg, { attempts = 3, timeoutMs = 2500, backoffMs = 200 } = {}) {
    if (state.contextInvalidated) return null;
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const p = chrome.runtime.sendMessage(msg);
        const resp = await Promise.race([
          p,
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))
        ]);
        return resp;
      } catch (e) {
        if (isContextInvalidated(e)) {
          onContextInvalidated(e);
          return null;
        }
        lastErr = e;
        // Retry only for transient channel issues / timeouts.
        const msgStr = String(e && (e.message || e));
        const transient =
          msgStr.includes("timeout") ||
          msgStr.includes("message channel closed") ||
          msgStr.includes("The message port closed") ||
          msgStr.includes("Receiving end does not exist") ||
          msgStr.includes("Could not establish connection");
        if (!transient) throw e;
        await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
      }
    }
    // Give up: report null and let callers degrade gracefully.
    log("warn", "[MSG]", "sendMessageSafeRetry failed", { type: msg?.type, error: String(lastErr) });
    return null;
  }

async function storageGetSafe(keys) {
    if (state.contextInvalidated) return {};
    try {
      return await chrome.storage.local.get(keys);
    } catch (e) {
      if (isContextInvalidated(e)) {
        onContextInvalidated(e);
        return {};
      }
      throw e;
    }
  }

  async function storageSetSafe(obj) {
    if (state.contextInvalidated) return false;
    try {
      await chrome.storage.local.set(obj);
      return true;
    } catch (e) {
      if (isContextInvalidated(e)) {
        onContextInvalidated(e);
        return false;
      }
      throw e;
    }
  }

  // -----------------------------
  // Persistent result cache (v0.4.11)
  // -----------------------------
  const RESULT_CACHE_KEY_V2 = "follone_resultCache_v2";
  const RESULT_CACHE_KEY_V1 = "follone_resultCache_v1";

  function fnv1a32(str) {
    let h = 0x811c9dc5;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(16);
  }

  function normalizeForHash(text) {
    let t = String(text || "");
    if (!t) return "";
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
    t = t.toLowerCase();
    t = t.replace(/https?:\/\/\S+/g, "<url>");
    t = t.replace(/([!！?？])\1{1,}/g, "$1$1");
    if (t.length > 600) t = t.slice(0, 450) + " … " + t.slice(-120);
    return t;
  }

  function ensurePersistentCache() {
    // Validate existing cache object
    const pc0 = state.persistentCache;
    if (pc0 && pc0.version === 2) {
      if (!pc0.ids) pc0.ids = { order: [], map: Object.create(null) };
      if (!pc0.hashes) pc0.hashes = { order: [], map: Object.create(null) };
      if (!pc0.id2h) pc0.id2h = Object.create(null);

      if (!Array.isArray(pc0.ids.order)) pc0.ids.order = [];
      if (!pc0.ids.map || typeof pc0.ids.map !== "object") pc0.ids.map = Object.create(null);

      if (!Array.isArray(pc0.hashes.order)) pc0.hashes.order = [];
      if (!pc0.hashes.map || typeof pc0.hashes.map !== "object") pc0.hashes.map = Object.create(null);

      return pc0;
    }

    state.persistentCache = {
      version: 2,
      ids: { order: [], map: Object.create(null) },
      hashes: { order: [], map: Object.create(null) },
      id2h: Object.create(null)
    };
    return state.persistentCache;
  }

  function touchCacheBucket(bucket, key, value, maxN) {
    if (!bucket || typeof bucket !== "object") return;
    if (!key || !value) return;

    if (!Array.isArray(bucket.order)) bucket.order = [];
    if (!bucket.map || typeof bucket.map !== "object") bucket.map = {};

    const order = bucket.order;
    const map = bucket.map;

    const idx = order.indexOf(key);
    if (idx >= 0) order.splice(idx, 1);
    order.push(key);
    map[key] = value;

    const cap = Number.isFinite(Number(maxN)) ? Math.max(1, Math.trunc(maxN)) : 200;
    while (order.length > cap) {
      const drop = order.shift();
      if (drop) delete map[drop];
    }
  }

  function setIdHash(id, h) {
    if (!id || !h) return;
    const pc = ensurePersistentCache();
    pc.id2h[id] = h;
    state.hashById.set(id, h);
  }

  function getHashForId(id) {
    if (!id) return "";
    const h = state.hashById.get(id);
    if (h) return h;
    const pc = ensurePersistentCache();
    const hh = pc && pc.id2h ? pc.id2h[id] : "";
    if (hh) state.hashById.set(id, hh);
    return hh || "";
  }

  let cacheLoaded = false;


  function ensureRuntimeMaps() {
    // Defensive: avoid crashes if any runtime containers were lost due to partial reload / navigation churn.
    if (!state.riskCache || typeof state.riskCache.get !== "function") state.riskCache = new Map();
    if (!state.elemById || typeof state.elemById.get !== "function") state.elemById = new Map();

    if (!state.sentForAnalysis || typeof state.sentForAnalysis.has !== "function") state.sentForAnalysis = new Set();
    if (!state.intervenedIds || typeof state.intervenedIds.has !== "function") state.intervenedIds = new Set();
    if (!state.analyzingVisible || typeof state.analyzingVisible.has !== "function") state.analyzingVisible = new Set();

    if (!Array.isArray(state.analyzeHigh)) state.analyzeHigh = [];
    if (!Array.isArray(state.analyzeLow)) state.analyzeLow = [];
    if (!Array.isArray(state.discoverQueue)) state.discoverQueue = [];

    if (typeof state.discoverScheduled !== "boolean") state.discoverScheduled = false;
    if (typeof state.analyzeScheduled !== "boolean") state.analyzeScheduled = false;

    if (!state.pendingPriority || typeof state.pendingPriority.get !== "function") state.pendingPriority = new Map();
    if (!state.seqById || typeof state.seqById.get !== "function") state.seqById = new Map();
    if (!state.hashById || typeof state.hashById.get !== "function") state.hashById = new Map();
    if (!state.hashCache || typeof state.hashCache.get !== "function") state.hashCache = new Map();
    if (!state.topicCounts || typeof state.topicCounts.get !== "function") state.topicCounts = new Map();
  }

  let cacheDirty = false;
  let cachePersistTimer = 0;

  async function loadResultCache() {
    // M6 (session-only cache): do not restore from chrome.storage.
    // This keeps behavior predictable across school PCs and avoids stale results.
    log("info", "[CACHE]", "session-only (no persistent restore)");
    return;
  }

  function touchPersistentCache(id, value, textHash) {
    // M6 (session-only cache): keep only in-memory hash cache for this session.
    if (!id || !value) return;
    const h = String(textHash || "");
    if (h) {
      state.hashCache.set(h, value);
      state.hashById.set(id, h);
    }
    // no storage writes
  }

  function schedulePersistCache() {
    // M6: persistent cache disabled
    return;
  }

  function shrinkResultForCache(r) {
    if (!r) return null;
    const reasons = Array.isArray(r.reasons) ? r.reasons.slice(0, 2).map(x => String(x)) : [];
    return {
      id: String(r.id || ""),
      riskScore: Number(r.riskScore || 0),
      riskCategory: String(r.riskCategory || "なし"),
      topicCategory: String(r.topicCategory || "その他"),
      reasons,
      _source: r._source || "ai",
      _ts: Date.now()
    };
  }

// -----------------------------
  // Utils
  // -----------------------------
  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }
  function clampFloat(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }
  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  
  // ---------------------------------
  // EXP (XP) helpers
  // ---------------------------------
  const XP_LEVELS = [0, 10, 25, 45, 70, 100, 140, 190, 250, 320, 400, 500, 620, 760, 920, 1100];

  function xpToLevel(xp) {
    const x = Math.max(0, Number(xp) || 0);
    let lv = 1;
    for (let i = 1; i < XP_LEVELS.length; i++) {
      if (x >= XP_LEVELS[i]) lv = i + 1;
      else break;
    }
    const prev = XP_LEVELS[Math.min(lv - 1, XP_LEVELS.length - 1)];
    const next = XP_LEVELS[Math.min(lv, XP_LEVELS.length - 1)] ?? (prev + 200);
    const prog = next > prev ? (x - prev) / (next - prev) : 1;
    return { lv, prev, next, prog: Math.max(0, Math.min(1, prog)), xp: x };
  }

  async function loadXp() {
    try {
      const resp = await sendMessageSafe({ type: "FOLLONE_GET_XP" });
      if (!resp) { return false; }
      if (resp && resp.ok) {
        state.xp = Number(resp.xp || 0);
      }
    } catch (_) {}
  }

  async function loadProgress() {
    try {
      const resp = await sendMessageSafe({ type: "FOLLONE_GET_PROGRESS" });
      if (!resp || !resp.ok) return false;
      state.xp = Number(resp.xp || 0);
      state.level = Number(resp.level || xpToLevel(state.xp).lv || 1);
      state.ownedHead = Array.isArray(resp.ownedHead) ? resp.ownedHead.map(String) : [];
      state.equippedHead = resp.equippedHead ? String(resp.equippedHead) : "";
      state.quest = (resp.quest && typeof resp.quest === "object") ? resp.quest : null;
      return true;
    } catch (_) {
      return false;
    }
  }

  function recordEvent(kind) {
    try {
      return sendMessageSafe({ type: "FOLLONE_RECORD_EVENT", kind: String(kind || "") }).then((res) => {
        if (res && res.ok && res.quest && typeof res.quest === "object") {
          state.quest = res.quest;
          renderWidget();
        }
        return res;
      });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function addXp(amount) {
    sendMessageSafe({ type: "FOLLONE_ADD_XP", amount: Number(amount) || 0 }).then((res) => {
      if (res && res.ok) {
        state.xp = Number(res.xp || state.xp || 0);
        if (res.level != null) state.level = Number(res.level || state.level || 1);
        if (Array.isArray(res.unlockedHead)) state.ownedHead = res.unlockedHead.map(String);
        // Keep equippedHead in sync
        loadProgress().then(() => { renderWidget(); renderPetAvatars().catch(() => {}); }).catch(() => renderWidget());
      }
    });
  }
  async function openOptions() {
    if (state.contextInvalidated) {
      showCtxBanner();
      return;
    }
    try {
      const res = await sendMessageSafe({ type: "FOLLONE_OPEN_OPTIONS" });
      if (state.contextInvalidated) {
        showCtxBanner();
        return;
      }
      if (!res || !res.ok) {
        try {
          const url = chrome.runtime.getURL("options.html");
          window.open(url, "_blank", "noopener,noreferrer");
        } catch (e) {
          if (isContextInvalidated(e)) onContextInvalidated(e);
        }
      }
    } catch (e) {
      if (isContextInvalidated(e)) onContextInvalidated(e);
    }
  }
  
  // ---------------------------------
  // "Opposite" (good-content) search suggestions (global)
  // ---------------------------------
  const OPPOSITE_POOLS_GLOBAL = {
    "誹謗中傷": ["やさしい言葉 例", "癒し 音楽", "猫 かわいい", "良いニュース", "心が落ち着く 呼吸法"],
    "政治": ["科学 ニュース", "宇宙 写真", "歴史 文化", "絶景 旅行", "学び まとめ"],
    "偏見": ["多様性 学び", "文化 交流", "インクルーシブデザイン", "人権 教育", "やさしい解説"],
    "差別": ["共生 取り組み", "多様性 学び", "文化 交流", "優しさ エピソード", "インクルーシブデザイン"],
    "詐欺": ["情報リテラシー", "フィッシング 見分け方", "セキュリティ 基礎", "安心できる買い物 コツ", "生活の豆知識"],
    "成人向け": ["アート 写真", "映画 レビュー", "料理 レシピ", "散歩 風景", "猫 かわいい"],
    "なし": ["猫 かわいい", "良いニュース", "音楽 おすすめ", "科学 ニュース", "絶景 旅行"],
    "その他": ["猫 かわいい", "良いニュース", "音楽 おすすめ", "科学 ニュース", "絶景 旅行"],
    "問題なし": ["猫 かわいい", "良いニュース", "音楽 おすすめ", "科学 ニュース", "絶景 旅行"]
  };

  function pickOppositeQueries(riskCategory, n = 3) {
    const cat = String(riskCategory || "なし");
    const pool = OPPOSITE_POOLS_GLOBAL[cat] || OPPOSITE_POOLS_GLOBAL["なし"];
    const seed = Date.now() % 997;
    const arr = pool.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (seed + i * 17) % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, Math.max(1, Math.min(5, n)));
  }

function openXSearch(q) {
  const url = `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=top`;
  try { recordEvent("search_open"); } catch (_) {}
  window.open(url, "_blank", "noopener,noreferrer");
}

  // -----------------------------
  // Bias dashboard search helpers
  // -----------------------------
  // Keep queries broad so they don't collapse into "その他".
  // These are not used for classification, only for user-facing exploration prompts.
  const BIAS_TOPIC_QUERY_HINTS = {
    "社会": ["社会 課題", "地域 ニュース", "福祉 取り組み"],
    "政治": ["政策 解説", "国会 質疑", "選挙 仕組み"],
    "経済": ["物価 指標", "家計 節約", "企業 決算"],
    "テック": ["プログラミング", "セキュリティ", "AI 活用"],
    "科学": ["科学 ニュース", "宇宙", "研究 解説"],
    "教育": ["勉強法", "教育 取り組み", "学習 まとめ"],
    "健康": ["睡眠", "運動", "メンタルケア"],
    "スポーツ": ["試合 ハイライト", "戦術 解説", "トレーニング"],
    "エンタメ": ["映画 レビュー", "アニメ", "ドラマ"],
    "イラスト/漫画": ["イラスト", "漫画", "創作"],
    "趣味/生活": ["料理 レシピ", "散歩", "日常 便利"],
    "その他": ["良いニュース", "学び", "風景"],
  };

  function pickFrom(arr, seed) {
    if (!Array.isArray(arr) || !arr.length) return null;
    const i = Math.abs(seed) % arr.length;
    return arr[i];
  }

  function buildBiasSearchQuery() {
    // Rotate through suggested topics; if absent, use a safe default.
    const qs = Array.isArray(state.dashQueries) && state.dashQueries.length ? state.dashQueries : ["良いニュース"];
    const idx = Math.max(0, Number(state.dashQueryIndex || 0)) % qs.length;
    const topic = String(qs[idx] || qs[0] || "良いニュース");
    state.dashQueryIndex = (idx + 1) % Math.max(1, qs.length);

    // Add a light hint to widen results and avoid overly narrow searches.
    const hintPool = BIAS_TOPIC_QUERY_HINTS[topic] || BIAS_TOPIC_QUERY_HINTS["その他"];
    const hint = pickFrom(hintPool, Date.now());
    // If the hint already includes the topic, just use hint; otherwise combine.
    if (hint && hint.includes(topic)) return hint;
    if (hint) return `${topic} ${hint}`;
    return topic;
  }
  // NOTE: X (x.com) uses nested scroll containers. Locking <html>/<body> overflow can
  // unexpectedly reset the app's internal scroll position. We therefore lock the
  // nearest scrollable ancestor of the target post.
  function findScrollContainer(fromElem) {
    let el = fromElem;
    while (el && el !== document.body && el !== document.documentElement) {
      try {
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        const isScrollable = (oy === "auto" || oy === "scroll" || oy === "overlay") &&
          (el.scrollHeight > el.clientHeight + 8);
        if (isScrollable) return el;
      } catch (_) {}
      el = el.parentElement;
    }
    const se = document.scrollingElement;
    try {
      if (se && se.scrollHeight > se.clientHeight + 8) return se;
    } catch (_) {}
    return null;
  }

  function lockScroll(lock, anchorElem) {
    if (lock) {
      if (state.scrollLock && state.scrollLock.locked) return;

      const scroller = findScrollContainer(anchorElem || state.spotlightElem);
      if (scroller) {
        const snap = {
          locked: true,
          el: scroller,
          scrollTop: 0,
          prev: {
            overflow: scroller.style.overflow || "",
            overflowY: scroller.style.overflowY || "",
            overscrollBehavior: scroller.style.overscrollBehavior || ""
          }
        };
        try { snap.scrollTop = scroller.scrollTop; } catch (_) { snap.scrollTop = 0; }
        state.scrollLock = snap;

        // Freeze this container only.
        try {
          scroller.style.overscrollBehavior = "contain";
          scroller.style.overflowY = "hidden";
          scroller.style.overflow = "hidden";
          // Keep position stable.
          scroller.scrollTop = snap.scrollTop;
        } catch (_) {}
        return;
      }

      // Fallback: do not touch overflow (avoid unexpected jumps). Wheel/keydown capture
      // handlers still prevent user scrolling during spotlight.
      state.scrollLock = { locked: true, el: null, scrollTop: 0, prev: null, fallback: true };
      return;
    }

    const snap = state.scrollLock;
    state.scrollLock = null;
    if (!snap || !snap.locked) return;
    if (snap.el && snap.prev) {
      try {
        snap.el.style.overflow = snap.prev.overflow;
        snap.el.style.overflowY = snap.prev.overflowY;
        snap.el.style.overscrollBehavior = snap.prev.overscrollBehavior;
      } catch (_) {}
      try { snap.el.scrollTop = snap.scrollTop; } catch (_) {}
    }
  }

  // -----------------------------
  // Spotlight intervention (v0.4.32)
  // -----------------------------
  function scheduleSpotlightLayout() {
    if (!state.spotlightOpen) return;
    if (state.spotlightLayoutTimer) return;
    state.spotlightLayoutTimer = window.setTimeout(() => {
      state.spotlightLayoutTimer = 0;
      try {
        if (state.spotlightOpen && state.spotlightElem) layoutSpotlight(state.spotlightElem);
      } catch (_) {}
    }, 60);
  }

  function layoutSpotlight(targetElem) {
    const sp = document.getElementById("follone-spotlight");
    if (!sp || !targetElem) return;
    const top = document.getElementById("follone-sp-top");
    const left = document.getElementById("follone-sp-left");
    const right = document.getElementById("follone-sp-right");
    const bottom = document.getElementById("follone-sp-bottom");
    const pop = document.getElementById("follone-sp-pop");
    if (!top || !left || !right || !bottom || !pop) return;

    const r = targetElem.getBoundingClientRect();
    const pad = 10;
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);

    // Clamp the "hole" to viewport.
    const holeL = Math.max(8, Math.min(vw - 8, Math.floor(r.left - pad)));
    const holeT = Math.max(8, Math.min(vh - 8, Math.floor(r.top - pad)));
    const holeR = Math.max(8, Math.min(vw - 8, Math.ceil(r.right + pad)));
    const holeB = Math.max(8, Math.min(vh - 8, Math.ceil(r.bottom + pad)));
    const holeW = Math.max(1, holeR - holeL);
    const holeH = Math.max(1, holeB - holeT);

    // Veils around the hole
    top.style.left = "0px";
    top.style.top = "0px";
    top.style.width = "100vw";
    top.style.height = `${holeT}px`;

    bottom.style.left = "0px";
    bottom.style.top = `${holeB}px`;
    bottom.style.width = "100vw";
    bottom.style.height = `${Math.max(0, vh - holeB)}px`;

    left.style.left = "0px";
    left.style.top = `${holeT}px`;
    left.style.width = `${holeL}px`;
    left.style.height = `${holeH}px`;

    right.style.left = `${holeR}px`;
    right.style.top = `${holeT}px`;
    right.style.width = `${Math.max(0, vw - holeR)}px`;
    right.style.height = `${holeH}px`;

    // Popover placement: try to avoid overlapping the always-on widget.
    const margin = 14;
    const widget = document.getElementById("follone-widget");
    const wr = widget ? widget.getBoundingClientRect() : null;

    const hasRoomRight = (vw - holeR) > 340;
    const hasRoomLeft = holeL > 340;

    // Prefer the side opposite to the widget (better readability).
    const widgetOnRight = wr ? (wr.left > vw * 0.55) : true;
    const preferRight = widgetOnRight ? false : true;
    const preferLeft = widgetOnRight ? true : false;

    let popLeft = margin;
    let popTop = Math.max(margin, holeT);

    const placeRight = () => {
      popLeft = Math.min(vw - margin - pop.offsetWidth, holeR + margin);
      popTop = Math.min(vh - margin - pop.offsetHeight, Math.max(margin, holeT));
    };
    const placeLeft = () => {
      popLeft = Math.max(margin, holeL - margin - pop.offsetWidth);
      popTop = Math.min(vh - margin - pop.offsetHeight, Math.max(margin, holeT));
    };
    const placeBottom = () => {
      popLeft = Math.min(vw - margin - pop.offsetWidth, Math.max(margin, holeL));
      popTop = Math.min(vh - margin - pop.offsetHeight, holeB + margin);
    };
    const placeTop = () => {
      popLeft = Math.min(vw - margin - pop.offsetWidth, Math.max(margin, holeL));
      popTop = Math.max(margin, holeT - margin - pop.offsetHeight);
    };

    if (preferRight && hasRoomRight) placeRight();
    else if (preferLeft && hasRoomLeft) placeLeft();
    else if (hasRoomRight) placeRight();
    else if (hasRoomLeft) placeLeft();
    else placeBottom();

    // If overlapping widget, move above it, otherwise try the other side.
    if (wr) {
      const pr = { left: popLeft, top: popTop, right: popLeft + pop.offsetWidth, bottom: popTop + pop.offsetHeight };
      const overlap = !(pr.right < wr.left || pr.left > wr.right || pr.bottom < wr.top || pr.top > wr.bottom);
      if (overlap) {
        // first: above widget
        popLeft = Math.min(vw - margin - pop.offsetWidth, Math.max(margin, wr.left));
        popTop = Math.max(margin, wr.top - margin - pop.offsetHeight);
        // if still bad (no space), flip side
        if (popTop <= margin + 2) {
          if (hasRoomLeft) placeLeft();
          else if (hasRoomRight) placeRight();
          else placeTop();
        }
      }
    }

    pop.style.left = `${Math.max(margin, popLeft)}px`;
    pop.style.top = `${Math.max(margin, popTop)}px`;
  }

  function closeSpotlight(reason) {
    const restoreTask = state._preSpotTask || "stand-by";
    if (!state.spotlightOpen) return;
    try { log("info","[SPOTLIGHT]","close", { reason, id: state.spotlightId }); } catch (_) {}

    const restore = state.spotlightRestore;

    // Cleanup listeners
    try { if (restore && typeof restore.cleanup === "function") restore.cleanup(); } catch (_) {}

    // Restore target
    try {
      if (state.spotlightElem) {
        state.spotlightElem.classList.remove("follone-spotlight-target");
        const b = state.spotlightElem.querySelector(".follone-target-badge");
        if (b) b.remove();
      }
    } catch (_) {}
    try { if (restore && typeof restore.targetRestore === "function") restore.targetRestore(); } catch (_) {}

    // UI hide
    try {
      const sp = document.getElementById("follone-spotlight");
      if (sp) {
        sp.classList.remove("show");
    try { setTask(restoreTask); } catch (_) {}
        sp.onclick = null;
      }
    } catch (_) {}

    // Restore widget state (spotlight emphasis)
    try {
      const w = document.getElementById("follone-widget");
      if (w) {
        const prev = state._prevWidgetState;
        if (typeof prev === "string") {
          if (prev) w.setAttribute("data-state", prev);
          else w.removeAttribute("data-state");
        }
        w.removeAttribute("data-alert");
      }
    } catch (_) {}
    state._prevWidgetState = null;

    // Unlock scroll
    try { lockScroll(false); } catch (_) {}

    state.spotlightRestore = null;
    state.spotlightOpen = false;
    state.spotlightId = null;
    state.spotlightElem = null;
    try { updateSpriteFromTask(); } catch (_) {}
  }

  function openSpotlight(opts) {
    // Remember previous UI task label so we can restore after spotlight
    state._preSpotTask = state.taskLabel || "stand-by";
    const { elem, id, severity, badgeText, subText, html, muted, searches, cat, score } = opts || {};
    const sp = document.getElementById("follone-spotlight");
    const pop = document.getElementById("follone-sp-pop");
    if (!sp || !pop || !elem) {
      return false;
    }

    // Close any existing spotlight
    try { closeSpotlight("reopen"); } catch (_) {}

    setTask("highlighting");
    try { scrollElementToCenter(elem, { behavior: "smooth" }); } catch (_) {}
    state.spotlightOpen = true;
    state.spotlightId = String(id || "");
    state.spotlightElem = elem;
    try { updateSpriteFromTask(); } catch (_) {}

    // Fill popover
    try {
      const t = document.getElementById("follone-sp-text");
      const m = document.getElementById("follone-sp-muted");
      const b = document.getElementById("follone-sp-badge");
      const s = document.getElementById("follone-sp-sub");
      if (t) t.innerHTML = html || "";
      if (m) m.textContent = muted || "";
      if (b) b.textContent = badgeText || "注意";
      if (s) s.textContent = subText || "介入";
    } catch (_) {}

    // Target emphasis + interaction disable
    const prev = {
      pointerEvents: elem.style.pointerEvents,
      position: elem.style.position,
      zIndex: elem.style.zIndex
    };
    elem.classList.add("follone-spotlight-target");
    elem.style.pointerEvents = "none";
    if (!prev.position) {
      // allow absolute badge positioning without overriding existing layout
      elem.style.position = "relative";
    }

    // Small badge on the post itself (helps identify which post triggered)
    try {
      const bb = document.createElement("div");
      bb.className = "follone-target-badge";
      bb.textContent = `${String(cat || "")}${cat ? " / " : ""}${String(score ?? "")}`.trim();
      if (bb.textContent) elem.appendChild(bb);
    } catch (_) {}

    // Show overlay
    const sevKey = (() => {
      const v = String(severity || "").toLowerCase();
      if (v === "hard" || v === "high" || v === "3") return "3";
      if (v === "normal" || v === "mid" || v === "2") return "2";
      if (v === "low" || v === "1") return "1";
      return v;
    })();
    try {
      sp.setAttribute("data-severity", sevKey);
      sp.setAttribute("data-category", String(cat || ""));
    } catch (_) {}
    sp.classList.add("show");
    try { setTask("spotlight", "ALRT ケイコク"); } catch (_) {}

    // Emphasize widget ticker while spotlight is open (visual state)
    try {
      const w = document.getElementById("follone-widget");
      if (w) {
        state._prevWidgetState = w.getAttribute("data-state") || "";
        w.setAttribute("data-state", "spotlight");
        w.setAttribute("data-alert", sevKey);
      }
    } catch (_) {}

    // Stop scroll (double guard)
    lockScroll(true, elem);
    const wheelBlock = (e) => {
      if (!state.spotlightOpen) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const keyBlock = (e) => {
      if (!state.spotlightOpen) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeSpotlight("esc");
        return;
      }
      const keys = ["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "];
      if (keys.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("wheel", wheelBlock, { passive: false, capture: true });
    window.addEventListener("touchmove", wheelBlock, { passive: false, capture: true });
    window.addEventListener("keydown", keyBlock, true);
    window.addEventListener("resize", scheduleSpotlightLayout, true);
    window.addEventListener("scroll", scheduleSpotlightLayout, true);

    // Veil click closes
    sp.onclick = (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains("veil")) {
        closeSpotlight("veil");
      }
    };

    // Buttons
    const btnBack = document.getElementById("follone-sp-back");
    const btnSearch = document.getElementById("follone-sp-search");
    const btnSettings = document.getElementById("follone-sp-settings");
    const btnCont = document.getElementById("follone-sp-continue");
    if (btnBack) btnBack.onclick = () => {
      // Safety habit: step back from heated content
      recordEvent("safety_pause");
      closeSpotlight("back");
      try {
        // keep the risky post de-emphasized after user chooses to step back
        elem.style.filter = "blur(8px)";
        elem.style.pointerEvents = "none";
      } catch (_) {}
      try { addXp(xpForIntervention(severity)); } catch (_) {}
      window.scrollBy({ top: -Math.min(900, window.innerHeight), behavior: "smooth" });
    };
    if (btnSearch) btnSearch.onclick = () => {
      // Safety habit: broaden perspective
      const list = Array.isArray(searches) ? searches : [];
      const q = list[0] || "良いニュース";
      try { openXSearch(q); } catch (_) {}
      closeSpotlight("search");
      try { addXp(xpForIntervention(severity) + 2); } catch (_) {}
    };
    if (btnSettings) btnSettings.onclick = () => {
      // Safety habit: adjust settings / learn how the system works
      recordEvent("settings_open");
      closeSpotlight("settings");
      try { addXp(2); } catch (_) {}
      try { openOptions(); } catch (_) {}
    };
    if (btnCont) btnCont.onclick = () => {
      // Neutral action (no quest credit)
      closeSpotlight("continue");
      try { addXp(1); } catch (_) {}
    };

    // Layout now + after next frame (popover dimensions stabilize)
    try { layoutSpotlight(elem); } catch (_) {}
    try { requestAnimationFrame(() => { if (state.spotlightOpen) layoutSpotlight(elem); }); } catch (_) {}

    // Cleanup hook
    state.spotlightRestore = {
      targetRestore: () => {
        try {
          elem.style.pointerEvents = prev.pointerEvents;
          elem.style.position = prev.position;
          elem.style.zIndex = prev.zIndex;
        } catch (_) {}
      },
      cleanup: () => {
        try {
          window.removeEventListener("wheel", wheelBlock, true);
          window.removeEventListener("touchmove", wheelBlock, true);
          window.removeEventListener("keydown", keyBlock, true);
          window.removeEventListener("resize", scheduleSpotlightLayout, true);
          window.removeEventListener("scroll", scheduleSpotlightLayout, true);
        } catch (_) {}
      }
    };

    try { log("warn","[SPOTLIGHT]","open", { id: state.spotlightId, severity, cat, score }); } catch (_) {}
    return true;
  }

  // -----------------------------
  // Loader (startup / navigation)
  // -----------------------------
  const loader = {
    shown: false,
    kind: "boot", // boot | nav
    progress: 0,
    raf: 0,
    pageToken: 0,
    timer: 0,
    hideTimer: 0,
    durationMs: 1200,
    minDone: false,
    gateToken: 0,
    gateDeadlineTs: 0,
    waiting: false,
    _resolveAny: null,
    _resolvePrompt: null,
    anyReady: null,
    promptReady: null,
    _resolveBackend: null,
    backendReady: null,
    // Gate: first classify attempt finished (used to hide loader after cold-start)
    _resolveFirstClassify: null,
    firstClassifyDone: null,
    startTs: 0
  };

  function setLoaderBrand(text) {
    const brand = document.getElementById("follone-loader-brand");
    if (!brand) return;
    // Brand letter-by-letter
    if (loader.kind === "boot") {
      const chars = String(text).split("");
      brand.innerHTML = chars.map((ch, idx) => `<span class="ch" style="animation-delay:${idx * 80}ms">${escapeHtml(ch)}</span>`).join("");
    } else {
      brand.textContent = text;
    }
  }

  function setLoaderSubtitle(text) {
    const el = document.getElementById("follone-loader-sub");
    if (!el) return;
    el.textContent = String(text || "");
  }

  function setLoaderQuote(text) {
    const el = document.getElementById("follone-loader-quote");
    if (!el) return;
    el.textContent = String(text || "");
  }



  
  function showLoader(kind, metaLeft) {
    let el = document.getElementById("follone-loader");
    if (!el) {
      try { mountUI(); } catch (_) {}
      el = document.getElementById("follone-loader");
    }
    if (!el) return;

    loader.kind = kind === "nav" ? "nav" : "boot";
    loader.shown = true;
    loader.waiting = false;
    loader.minDone = false;

    // Time-based minimum duration (ms)
    loader.durationMs = 5000;
    loader.startTs = Date.now();

    // Reset timers/raf
    if (loader.raf) cancelAnimationFrame(loader.raf);
    if (loader.timer) clearTimeout(loader.timer);
    loader.timer = 0;

    // Cancel pending hide animation (prevents instant hide on rapid nav)
    if (loader.hideTimer) { clearTimeout(loader.hideTimer); loader.hideTimer = 0; }

    el.classList.add("show");
    lockScroll(true, document.querySelector("main") || document.querySelector("[role='main']") || document.body.firstElementChild);
    setLoaderBrand(loader.kind === "boot" ? getChar().label : "Now analyzing");
    setLoaderSubtitle(loader.kind === "boot" ? "起動中" : "Now analyzing");
    setLoaderQuote(loader.kind === "boot" ? "少しだけ…待ってて。" : "ちょい待ち。分析するね。");

    const left = document.getElementById("follone-loader-meta-left");
    if (left) left.textContent = metaLeft || (loader.kind === "boot" ? "startup" : "loading");

    // 0% -> 100% in durationMs
    setLoaderProgress(0);

    const tick = () => {
      if (!loader.shown) return;
      const elapsed = Date.now() - loader.startTs;
      const p = Math.max(0, Math.min(1, (elapsed / loader.durationMs)));
      setLoaderProgress(p);

      if (p >= 1 && !loader.minDone) {
        loader.minDone = true;
        // After minimum time, stay visible until gate is released (or max wait reached)
        loader.waiting = true;
        setLoaderSubtitle("初回解析中…");
        setLoaderQuote("できるだけ早く返すね。");
        // Stop animating at 100% to avoid wasting CPU
        if (loader.raf) cancelAnimationFrame(loader.raf);
        loader.raf = 0;
        return;
      }
      loader.raf = requestAnimationFrame(tick);
    };

    tick();
  }
function setLoaderProgress(progress) {
    const bar = document.getElementById("follone-loader-bar");
    const right = document.getElementById("follone-loader-meta-right");
    const pct = Math.max(0, Math.min(100, Math.round(Number(progress || 0) * 100)));
    if (bar) bar.style.width = `${pct}%`;
    if (right) right.textContent = `${pct}%`;
  }

  
  function hideLoader() {
    const el = document.getElementById("follone-loader");
    if (!el) return;
    if (!loader.shown) return;
    loader.shown = false;
    loader.waiting = false;
    loader.minDone = false;
    if (loader.raf) cancelAnimationFrame(loader.raf);
    if (loader.timer) clearTimeout(loader.timer);
    loader.timer = 0;
    // reset for next time
    setLoaderProgress(0);
    if (loader.hideTimer) clearTimeout(loader.hideTimer);
    loader.hideTimer = setTimeout(() => {
      el.classList.remove("show");
      lockScroll(false);
      loader.hideTimer = 0;
    }, 260);
  }

  function resetLoaderGates() {
    loader.gateToken = loader.pageToken;
    loader.gateDeadlineTs = 0;

    loader.anyReady = new Promise(res => { loader._resolveAny = res; });
    loader.promptReady = new Promise(res => { loader._resolvePrompt = res; });
    loader.backendReady = new Promise(res => { loader._resolveBackend = res; });
    loader.firstClassifyDone = new Promise(res => { loader._resolveFirstClassify = res; });
  }

  function signalAnyResult(payload) {
    try { loader._resolveAny && loader._resolveAny(payload || true); } catch {}
    loader._resolveAny = null;
  }
  function signalPromptResult(payload) {
    try { loader._resolvePrompt && loader._resolvePrompt(payload || true); } catch {}
    loader._resolvePrompt = null;
  }
  function signalBackendReady(payload) {
    try { loader._resolveBackend && loader._resolveBackend(payload || true); } catch {}
    loader._resolveBackend = null;
  }

  function signalFirstClassifyDone(payload) {
    try { loader._resolveFirstClassify && loader._resolveFirstClassify(payload || true); } catch {}
    loader._resolveFirstClassify = null;
  }

  async function runLoaderGate(kind, metaLeft, opts) {
    // Loader policy:
    // - Always show at least `minMs` (visual satisfaction)
    // - Then keep showing until the first classify attempt completes, so cold-start is hidden.
    // - Never block forever: hard timeout = minMs + maxExtraMs.
    const o = Object.assign({ minMs: 5000, maxExtraMs: 45000, preferPrompt: true }, (opts || {}));
    bumpPageToken();
    resetLoaderGates();

    showLoader(kind, metaLeft);

    const token = loader.pageToken;
    const start = Date.now();
    loader.gateDeadlineTs = start + o.minMs + o.maxExtraMs;

    // Kick warmup early to hide cold-start latency behind loader.
    // Avoid re-warmup spam when we are already ready.
    if (settings.enabled && settings.aiMode === "auto" && state.sessionStatus !== "ready") {
      ensureBackend(true).then(ok => {
        if (ok) signalBackendReady({ ok: true });
      }).catch(() => {});
    }

    // Head start: discover + analyze immediately
    scheduleDiscovery(0);
    scheduleAnalyze(0);

    // While the loader gate is waiting, X often hasn't rendered timeline articles yet (SPA + hydration).
    // Pump discovery/analyze periodically until the FIRST classify attempt completes (or we timeout),
    // so the loader truly ends on "first classify finished" instead of a hard timeout.
    const _pump = setInterval(() => {
      try {
        if (loader.pageToken != token) { clearInterval(_pump); return; }
        if (!loader._resolveFirstClassify) { clearInterval(_pump); return; } // already resolved
        scheduleDiscovery(0);
        scheduleAnalyze(0);
      } catch (_) {}
    }, 700);

    // Minimum time: always wait o.minMs
    await new Promise(r => setTimeout(r, o.minMs));
    if (loader.pageToken != token) { try { clearInterval(_pump); } catch {} return; } // navigated away

    // After minMs: wait for first classify completion (preferred), but never block forever.
    const remaining = Math.max(0, loader.gateDeadlineTs - Date.now());
    const timeout = new Promise(res => setTimeout(() => res({ timeout: true }), remaining));

    // Keep the loader up until first classify finishes.
    // (We still collect prompt/any results for logging/telemetry.)
    let winner;
    try { Promise.race([loader.promptReady, loader.anyReady]).then(w => { winner = w; }).catch(()=>{}); } catch (_) {}
    const ready = await Promise.race([loader.firstClassifyDone, timeout]);
    if (!winner) winner = ready;

    if (loader.pageToken != token) { try { clearInterval(_pump); } catch {} return; }
    try { clearInterval(_pump); } catch {}
    hideLoader();
    setTask("stand-by");
    scheduleHighlightFlush(0);
    log("info","[LOADER]","gate release", { kind, winner, waitedMs: Date.now() - start });
  }

/* v0.4.15: loader is time-based (no markFirstAnalysisDone) */


  function bumpPageToken() {
    loader.pageToken += 1;
    log("info", "[NAV]", "pageToken", loader.pageToken, location.pathname);
  }

  function installNavHooks() {
    // Guard: content scripts may re-run mountUI on SPA transitions.
    if (state._navHooked) return;
    state._navHooked = true;
    const emit = () => window.dispatchEvent(new Event("follone:navigate"));
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function(...args){ const r = origPush.apply(this, args); emit(); return r; };
    history.replaceState = function(...args){ const r = origReplace.apply(this, args); emit(); return r; };
    window.addEventListener("popstate", emit);

    window.addEventListener("follone:navigate", () => {
      // Skip explore pages
      if (location.pathname.startsWith("/explore")) return;
      // If a spotlight was open, always close it when navigating.
      // (Otherwise the side panel can remain stuck on the edge.)
      try { if (state.spotlightOpen) closeSpotlight("navigate"); } catch (_) {}
      // New page context
      state.intervenedIds = new Set();
      // Loader for every timeline navigation; prefer first AI recv (with bounded extra wait)
      setTask("loading");
      runLoaderGate("nav", `mode:${settings.aiMode}`, { minMs: 1200, maxExtraMs: 1800, preferPrompt: true });
    });

  }

  // Some X "timeline" switches (e.g., Home: おすすめ↔フォロー中) do not always
  // change location.pathname. In that case our history hook won't fire, so the
  // loader appears only on the very first timeline. This lightweight watcher
  // detects timeline tab changes and re-runs the nav loader gate.
  let _timelineKey = "";
  let _timelineTimer = 0;

  function isTimelineLikePage() {
    // Skip known non-timeline routes.
    const p = location.pathname || "";
    if (p.startsWith("/explore")) return false;
    if (p.startsWith("/settings")) return false;
    if (p.startsWith("/i/flow")) return false;
    // Search behaves like a timeline (results list) even before <article> mounts.
    if (p.startsWith("/search")) return true;
    // Home is always timeline-like even before <article> nodes are mounted.
    if (p === "/home" || p === "/") return true;
    // Most pages with a stream of posts have at least one <article>.
    return !!document.querySelector("article");
  }

  function getSelectedTabLabel() {
    // Home tab switch may not touch URL; rely on aria-selected tabs.
    const sel = document.querySelector('[role="tab"][aria-selected="true"], a[role="tab"][aria-selected="true"]');
    if (!sel) return "";
    const t = (sel.textContent || "").trim();
    return t.slice(0, 40);
  }

  function computeTimelineKey() {
    const tab = getSelectedTabLabel();
    // /search can change results without updating aria-selected; include the live input value.
    let q = "";
    try {
      const p = location.pathname || "";
      if (p.startsWith("/search")) {
        const inp = document.querySelector('input[data-testid="SearchBox_Search_Input"], input[aria-label*="検索"], input[type="search"]');
        q = (inp && inp.value) ? String(inp.value).trim().slice(0, 120) : "";
      }
    } catch (_) {}
    return `${location.pathname}|${location.search}|${tab}|${q}`;
  }

  function installTimelineWatcher() {
    if (_timelineTimer) return;
    _timelineKey = computeTimelineKey();

    const tick = () => {
      try {
        if (!document.getElementById("follone-widget")) {
          _timelineTimer = window.setTimeout(tick, 700);
          return;
        }
        if (!isTimelineLikePage()) {
          _timelineKey = computeTimelineKey();
          _timelineTimer = window.setTimeout(tick, 700);
          return;
        }

        const k = computeTimelineKey();
        if (k && k !== _timelineKey) {
          _timelineKey = k;
          // New page context
          state.intervenedIds = new Set();
          setTask("loading");
          runLoaderGate("nav", `mode:${settings.aiMode}`, { minMs: 1100, maxExtraMs: 1600, preferPrompt: true });
        }
      } catch (_) {}
      _timelineTimer = window.setTimeout(tick, 700);
    };

    _timelineTimer = window.setTimeout(tick, 700);
  }

// Immediate loader on Home tab click (おすすめ↔フォロー中 etc.)
// Some transitions don't update aria-selected quickly enough for the watcher tick.
function installTimelineClickHook() {
  if (state._timelineClickHooked) return;
  state._timelineClickHooked = true;

  const shouldTrigger = (el) => {
    if (!el) return false;
    const tab = el.closest && el.closest('[role="tab"], a[role="tab"], [data-testid="ScrollSnap-List"] [role="tab"]');
    if (!tab) return false;
    if (!isTimelineLikePage()) return false;
    return true;
  };

  document.addEventListener('click', (ev) => {
    try {
      const t = ev.target;
      if (!shouldTrigger(t)) return;
      const now = Date.now();
      if (state._lastTabNavTs && (now - state._lastTabNavTs) < 900) return;
      state._lastTabNavTs = now;

      state.intervenedIds = new Set();
      setTask('loading');
      runLoaderGate('nav', `mode:${settings.aiMode}`, { minMs: 1100, maxExtraMs: 1600, preferPrompt: true });
    } catch (_) {}
  }, true);
}


// Search page loader:
// - /search transitions sometimes don't trigger the tab click hook
// - the search box can update results via client state (URL doesn't always change)
// We hook Enter/submit events to re-run the nav loader gate.
function installSearchLoaderHook() {
  if (state._searchLoaderHooked) return;
  state._searchLoaderHooked = true;

  const isSearchPage = () => (location.pathname || "").startsWith("/search");
  const findInput = () => document.querySelector('input[data-testid="SearchBox_Search_Input"], input[type="search"], input[aria-label*="検索"]');

  const trigger = (reason) => {
    try {
      if (!isSearchPage()) return;
      if (!isTimelineLikePage()) return;
      const now = Date.now();
      if (state._lastSearchNavTs && (now - state._lastSearchNavTs) < 900) return;
      state._lastSearchNavTs = now;

      state.intervenedIds = new Set();
      setTask('loading');
      runLoaderGate('nav', `mode:${settings.aiMode}`, { minMs: 1100, maxExtraMs: 1800, preferPrompt: true });
    } catch (_) {}
  };

  // Enter key in search box
  document.addEventListener('keydown', (ev) => {
    try {
      if (ev.key !== 'Enter') return;
      const t = ev.target;
      const inp = findInput();
      if (!inp) return;
      if (t !== inp) return;
      trigger('enter');
    } catch (_) {}
  }, true);

  // Form submit fallback (some layouts wrap input in a form)
  document.addEventListener('submit', (ev) => {
    try {
      if (!isSearchPage()) return;
      const inp = findInput();
      if (!inp) return;
      if (!ev.target || !ev.target.contains || !ev.target.contains(inp)) return;
      trigger('submit');
    } catch (_) {}
  }, true);
}




  // -----------------------------
  // UI
  // -----------------------------
  function mountUI() {
    log("info","[UI]","mountUI");
    if (document.getElementById("follone-widget")) return;

    const w = document.createElement("div");
    w.id = "follone-widget";
    w.innerHTML = `
      <div class="device">
        <div class="deviceBody">
          <div class="deviceInset" id="follone-body">

            <!-- Stage (character is the main actor) -->
            <div class="stage">
              <div class="petWrap">
                <div class="avatar" id="follone-avatar"></div>
              </div>
              <div class="stageMeta">
                <div class="name" id="follone-title">follone</div>
                <div class="state" id="follone-sub">stand-by</div>
                <div class="miniRow">
                  <button class="miniBtn" id="follone-toggle" title="ON/OFF">PWR</button>
                  <button class="miniBtn" id="follone-options" title="設定">SET</button>
                </div>
              </div>
            </div>

            <!-- Meters (no labels; read as instruments) -->
            <div class="meters" id="follone-dash" aria-label="視野メーター">
              <div class="meterRow" data-k="F" title="Focus">
                <div class="meterIcon">●</div>
                <div class="meterTrack"><div class="meterFill" id="follone-bias-focus-bar"></div></div>
                <div class="meterVal" id="follone-bias-focus-score">--</div>
              </div>
              <div class="meterRow" data-k="V" title="Variety">
                <div class="meterIcon">≡</div>
                <div class="meterTrack"><div class="meterFill" id="follone-bias-variety-bar"></div></div>
                <div class="meterVal" id="follone-bias-variety-score">--</div>
              </div>
              <div class="meterRow" data-k="E" title="Explore">
                <div class="meterIcon">＋</div>
                <div class="meterTrack"><div class="meterFill" id="follone-bias-explore-bar"></div></div>
                <div class="meterVal" id="follone-bias-explore-score">--</div>
              </div>

              <!-- kept for logic; visually hidden in overlay.css -->
              <div class="dashInfo" id="follone-bias-top">top: —</div>
              <div class="dashInfo" id="follone-bias-suggest">おすすめ: —</div>
            </div>

            <!-- Ticker (dot board; the only place where text is the hero) -->
            <div class="ticker" id="follone-taskbar" aria-live="polite">
              <div class="tickerTop" id="follone-status-top">STBY スタンバイ</div>
              <div class="tickerBot" id="follone-status-bot">idle</div>
            </div>

            <!-- Actions (one primary action + tiny XP line) -->
            <div class="actions">
              <div class="xpLine" id="follone-exp">
                <div class="xpLabel" id="follone-exp-label">LV 1</div>
                <div class="xpNext" id="follone-exp-next">0/10</div>
                <div class="xpBarWrap"><div class="xpBar" id="follone-exp-bar"></div></div>
              </div>
              <button class="actionBtn" id="follone-bias-search" title="X内検索を開きます">検索で視野を広げる</button>
            </div>

            <div class="muted" id="follone-meta"></div>

            <!-- quests stay in Options (overlay should not be text-heavy) -->
            <div class="quests" id="follone-quests" aria-hidden="true"></div>

          </div>

          <!-- Glass / CRT layer -->
          <div class="glassLayer" aria-hidden="true"></div>
          <!-- Accent glow / FX layer -->
          <div class="fxLayer" aria-hidden="true"></div>
        </div>
      </div>
    `;    document.documentElement.appendChild(w);

    // Boot sequence: make meters "light up" once on mount (purely visual).
    try {
      w.classList.add("booting");
      setTimeout(() => { try { w.classList.remove("booting"); } catch {} }, 950);
    } catch (_) {}

    const ov = document.createElement("div");
    ov.id = "follone-overlay";
    ov.innerHTML = `
      <div class="card">
        <div class="cardHeader">
          <div class="avatar" id="follone-ov-avatar"></div>
          <div class="headText">
            <div class="title" id="follone-ov-title">follone</div>
            <div class="sub" id="follone-ov-sub">介入</div>
          </div>
          <div class="badge" id="follone-ov-badge">注意</div>
        </div>
        <div class="cardBody">
          <div id="follone-ov-text"></div>
          <div class="muted" id="follone-ov-muted" style="margin-top:10px;"></div>
        </div>
        <div class="actions">
          <button id="follone-ov-back">戻る</button>
          <button id="follone-ov-search">検索へ</button>
          <button id="follone-ov-continue">表示する</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(ov);

    // Spotlight intervention overlay (veil + side popover)
    if (!document.getElementById("follone-spotlight")) {
      const sp = document.createElement("div");
      sp.id = "follone-spotlight";
      sp.innerHTML = `
        <div class="veil" id="follone-sp-top"></div>
        <div class="veil" id="follone-sp-left"></div>
        <div class="veil" id="follone-sp-right"></div>
        <div class="veil" id="follone-sp-bottom"></div>
        <div class="popover" id="follone-sp-pop">
          <div class="ph">
            <div class="avatar" id="follone-sp-avatar"></div>
            <div class="headText">
              <div class="title" id="follone-sp-title">follone</div>
              <div class="sub" id="follone-sp-sub">介入</div>
            </div>
            <div class="badge" id="follone-sp-badge">注意</div>
          </div>
          <div class="pb">
            <div id="follone-sp-text"></div>
            <div class="muted" id="follone-sp-muted" style="margin-top:10px; opacity:0.85;"></div>
          </div>
          <div class="actions">
            <button id="follone-sp-back">戻る</button>
            <button id="follone-sp-search">検索へ</button>
            <button id="follone-sp-settings">設定へ</button>
            <button id="follone-sp-continue">続ける</button>
          </div>
        </div>`;
      document.documentElement.appendChild(sp);
    }

    // Fullscreen loader (startup / navigation)
    if (!document.getElementById("follone-loader")) {
      const ld = document.createElement("div");
      ld.id = "follone-loader";
      ld.innerHTML = `
        <div class="box">
          <div class="brand" id="follone-loader-brand"></div>
          <div class="subtitle" id="follone-loader-sub"></div>
          <div class="quote" id="follone-loader-quote"></div>
          <div class="progressWrap"><div class="progressBar" id="follone-loader-bar"></div></div>
          <div class="meta">
            <div class="pill" id="follone-loader-meta-left">offline AI</div>
            <div class="pill" id="follone-loader-meta-right">0%</div>
          </div>
        </div>`;
      document.documentElement.appendChild(ld);
    }

    // Navigation / timeline watchers (needed for loader on every timeline).
    try { installNavHooks(); } catch (_) {}
    try { installTimelineWatcher(); } catch (_) {}
    try { installTimelineClickHook(); } catch (_) {}
    try { installSearchLoaderHook(); } catch (_) {}

    w.querySelector("#follone-toggle").addEventListener("click", async () => {
      settings.enabled = !settings.enabled;
      await chrome.storage.local.set({ follone_enabled: settings.enabled });
      renderWidget();
    });

    w.querySelector("#follone-options").addEventListener("click", () => openOptions());

    // Dashboard action: widen perspective via X search
    // Policy: keep it one-click. Pick 1 suggested topic (rotating) and open an X search.
    w.querySelector("#follone-bias-search")?.addEventListener("click", () => {
      const q = buildBiasSearchQuery();
      openXSearch(q);
      addXp(1);
    });


    // ensureSpriteAnim was removed in the PetEngine migration.
    if (typeof ensureSpriteAnim === "function") ensureSpriteAnim();
    applyCharacterTheme();
    updateSpriteFromTask();
    renderWidget();
  }

  function setSub(text) {
    const el = document.getElementById("follone-sub");
    if (el) el.textContent = text;
  }

  // -----------------------------
  // Character theme + dot animation (6 frames)
  // -----------------------------
  const CHAR_DB = {
    forone: {
      id: "forone",
      label: "Forone",
      displayName: "follone",
      accent: "#A873FF"
    },
    likoris: {
      id: "likoris",
      label: "Likoris",
      displayName: "likoris",
      accent: "#FD6B98"
    }
  };

  function getChar() {
    return CHAR_DB[settings.characterId] || CHAR_DB.forone;
  }

  function applyCharacterTheme() {
    const ch = getChar();
    // Titles
    const titleIds = ["follone-title","follone-ov-title","follone-sp-title"];
    for (const id of titleIds) {
      const el = document.getElementById(id);
      if (el) el.textContent = ch.displayName;
    }
    // Accent color via CSS variable (overlay.css uses it)
    try { document.documentElement.style.setProperty("--follone-accent", ch.accent); } catch (_) {}

    // Skin attribute for token-based theming (latte base + character accent)
    try {
      const widget = document.getElementById("follone-widget");
      if (widget) widget.setAttribute("data-skin", ch.id);
    } catch (_) {}

    // Loader brand text animation label
    try { setLoaderBrand(ch.label); } catch (_) {}

    // Sync avatar state (if animator exists)
    try { if (spriteAnim) spriteAnim.setCharacter(ch.id); } catch (_) {}
  }

  class SpriteAnimator {
    constructor() {
      this.characterId = getChar().id;
      this.state = "idle"; // idle | walk | warn
      this.frame = 0;
      this.timer = 0;
      this.msPerFrame = 150;
      this.targets = new Set();
      this._cache = new Map(); // url -> "ok"|"loading"|"bad"
      this._disabled = false;

    }

    addTarget(el) {
      if (!el) return;
      this.targets.add(el);
      // pixel crisp
      el.style.imageRendering = "pixelated";
      this.render();
    }

    setCharacter(id) {
      const next = CHAR_DB[id] ? id : "forone";
      if (next === this.characterId) return;
      this.characterId = next;
      this.frame = 0;
      this.render();
    }

    setState(state) {
      const s = (state === "warn" || state === "walk") ? state : "idle";
      if (s === this.state) return;
      this.state = s;
      this.frame = 0;
      this.render();
      this.start();
    }

    start() {
      if (this.timer) return;
      this.timer = window.setInterval(() => {
        // warn should loop while spotlight is open
        if (this.state === "warn" && !state.spotlightOpen) this.state = "idle";
        this.frame = (this.frame + 1) % 6;
        this.render();
      }, this.msPerFrame);
    }

    stop() {
      if (this.timer) {
        window.clearInterval(this.timer);
        this.timer = 0;
      }
    }

    getFrameUrl() {
      const base = `assets/chars/${this.characterId}/${this.state}_${this.frame}.png`;
      return chrome.runtime.getURL(base);
    }

    render() {
      if (this._disabled) return;
      const url = this.getFrameUrl();

      const st = this._cache.get(url);
      if (st === "bad") return;

      if (st !== "ok") {
        // Preload once to avoid spamming console with missing asset GETs.
        if (st !== "loading") {
          this._cache.set(url, "loading");
          const img = new Image();
          img.onload = () => {
            this._cache.set(url, "ok");
            this.render();
          };
          img.onerror = () => {
            this._cache.set(url, "bad");
            this._disabled = true;
            try {
              log("warn","[SPRITE]","asset missing; disabling sprite animation", url);
            } catch (_) {}
          };
          img.src = url;
        }
        return;
      }

      for (const el of this.targets) {
        try {
          el.style.backgroundImage = `url("${url}")`;
          el.style.backgroundSize = "cover";
          el.style.backgroundRepeat = "no-repeat";
          el.style.backgroundPosition = "center";
        } catch (_) {}
      }
    }
  }

  // --- Sprite PNG animation: disabled (canvas-only PetEngine is the canonical renderer) ---
  function updateSpriteFromTask() {
    // PetEngine avatar (non-blocking)
    try { renderPetAvatars(); } catch (_e) {}
  }

  // -----------------------------
  // Task ticker (small, game-like)
  // -----------------------------
  function setTask(label, detail) {
    // label: internal state keyword (stand-by/loading/classify/spotlight/error/cooldown...)
    state.taskLabel = String(label || "stand-by");

    // Normalize to stable UI states for animation hooks
    const raw = state.taskLabel.toLowerCase();
    let uiState = "standby";
    if (raw.includes("load")) uiState = "loading";
    else if (raw.includes("collect") || raw.includes("scan")) uiState = "collecting";
    else if (raw.includes("class") || raw.includes("judge") || raw.includes("ai")) uiState = "classifying";
    else if (raw.includes("spot")) uiState = "spotlight";
    else if (raw.includes("cool")) uiState = "cooldown";
    else if (raw.includes("err") || raw.includes("fail") || raw.includes("crash")) uiState = "error";
    else if (raw.includes("stand") || raw.includes("idle")) uiState = "standby";

    const widget = document.getElementById("follone-widget");
    if (widget) widget.setAttribute("data-state", uiState);

    // 2-line ticker: CODE + カタカナ, then details
    const topMap = {
      standby:    ["STBY", "スタンバイ"],
      loading:    ["LOAD", "ロード"],
      collecting: ["SCAN", "スキャン"],
      classifying:["AI",   "カイセキ"],
      spotlight:  ["SPOT", "スポット"],
      cooldown:   ["COOL", "クール"],
      error:      ["ERR",  "エラー"],
    };
    const pair = topMap[uiState] || ["SYS", "システム"];
    const topText = `${pair[0]} ${pair[1]}`;

    const d = (detail == null) ? "" : String(detail);
    const botText = d ? d : raw;

    const wrap = document.getElementById("follone-taskbar");
    if (!wrap) return;

    const topEl = document.getElementById("follone-status-top");
    const botEl = document.getElementById("follone-status-bot");

    if (topEl && botEl) {
      // Glitch pulse: toggle a class briefly for dot-noise transition
      wrap.classList.remove("glitch");
      // next frame
      requestAnimationFrame(() => {
        wrap.classList.add("glitch");
        setTimeout(() => wrap.classList.remove("glitch"), 240);
      });

      topEl.textContent = topText;
      botEl.textContent = botText;
    } else {
      // fallback (older DOM)
      wrap.textContent = `SYS: ${state.taskLabel}${d ? ` ${d}` : ""}`;
    }

    try { updateSpriteFromTask(); } catch (_) {}
  }


  function setError(code, detail) {
    state.lastErrorCode = code ? String(code) : "";
    state.lastErrorDetail = detail ? String(detail) : "";
    if (state.lastErrorCode) {
      setTask("ERROR", state.lastErrorCode);
    }
  }

  function clearError() {
    state.lastErrorCode = "";
    state.lastErrorDetail = "";
  }

  // Dev helper: show a small post-id tag near the article (for mapping logs -> UI)
  function maybeAttachIdTag(article, id) {
    if (!settings.showPostIds) return;
    if (!article || !id) return;
    if (article.querySelector?.('.follone-idtag')) return;
    const tag = document.createElement("div");
    tag.className = "follone-idtag";
    tag.textContent = id;
    // Do not disturb layout: overlay inside article
    try { article.style.position = article.style.position || "relative"; } catch (_) {}
    tag.style.position = "absolute";
    tag.style.right = "6px";
    tag.style.bottom = "6px";
    tag.style.zIndex = "9999";
    article.appendChild(tag);
  }


  function renderWidget() {
    const meta = document.getElementById("follone-meta");
    const enabled = settings.enabled ? "ON" : "OFF";
    const sec = Math.floor((Date.now() - state.sessionStartMs) / 1000);

    let backendLabel = state.sessionStatus;
    if (state.sessionStatus === "ready") backendLabel = "PromptAPI";
        if (state.sessionStatus === "off") backendLabel = "OFF";
    if (state.sessionStatus === "unavailable") backendLabel = "利用不可";
    if (state.sessionStatus === "downloadable") backendLabel = "DL待ち";
    if (state.sessionStatus === "downloading") backendLabel = "DL中";

    let sub = `${enabled} / AI:${backendLabel}`;
    if (state.lastErrorCode) sub += ` / ERROR:${state.lastErrorCode}`;
    setSub(sub);

    if (meta) {
      const err = state.lastErrorCode ? ` / ${state.lastErrorCode}` : "";
      let hint = "";
      if (state.lastErrorCode === "WARMUP_REQUIRED") hint = " / 設定→Backend→WARMUP";
      else if (state.lastErrorCode === "MODEL_DOWNLOADING") hint = " / モデルDL中…";
      else if (state.lastErrorCode === "PROMPT_UNAVAILABLE") hint = " / Prompt API未使用(Chrome設定確認)";
      meta.textContent = `batch:${settings.batchSize} / idle:${settings.idleMs}ms / session:${sec}s${err}${hint}`;
    }

    // EXP
    const expLabel = document.getElementById("follone-exp-label");
    const expNext = document.getElementById("follone-exp-next");
    const expBar = document.getElementById("follone-exp-bar");
    if (expLabel && expNext && expBar) {
      const info = xpToLevel(state.xp || 0);
      expLabel.textContent = `EXP Lv ${info.lv}`;
      expNext.textContent = `${info.xp}/${info.next}`;
      expBar.style.width = `${Math.round(info.prog * 100)}%`;
    }

    // Quests (Daily 3 / Weekly 1)
    const qEl = document.getElementById("follone-quests");
    if (qEl) {
      const q = state.quest;
      const daily = Array.isArray(q?.daily?.items) ? q.daily.items : [];
      const weekly = q?.weekly?.item;
      const dText = daily.length
        ? daily.map(it => `${it.label} ${Number(it.cur||0)}/${Number(it.goal||0)}`).join(" / ")
        : "Daily: --";
      const wText = weekly
        ? `${weekly.label} ${Number(weekly.cur||0)}/${Number(weekly.goal||0)}`
        : "Weekly: --";
      qEl.textContent = `${dText}  |  ${wText}`;
    }

    // Dashboard (bias 3-axis)
    const focusScoreEl = document.getElementById("follone-bias-focus-score");
    const varietyScoreEl = document.getElementById("follone-bias-variety-score");
    const exploreScoreEl = document.getElementById("follone-bias-explore-score");
    const focusBarEl = document.getElementById("follone-bias-focus-bar");
    const varietyBarEl = document.getElementById("follone-bias-variety-bar");
    const exploreBarEl = document.getElementById("follone-bias-explore-bar");
    const topEl = document.getElementById("follone-bias-top");
    const sugEl = document.getElementById("follone-bias-suggest");
    const searchBtn = document.getElementById("follone-bias-search");

    const focusPct = Number(state.dashFocusPct || 0);
    const varietyVal = Number(state.dashVarietyVal || 0);
    const varietyPct = Number(state.dashVarietyPct || 0);
    const explorePct = Number(state.dashExplorePct || 0);
    const top = state.dashTopTopic || "—";
    const qs = Array.isArray(state.dashQueries) ? state.dashQueries : [];

    if (focusScoreEl) focusScoreEl.textContent = `${Math.round(focusPct)}%`;
    if (varietyScoreEl) varietyScoreEl.textContent = `${varietyVal ? varietyVal.toFixed(1) : "--"}`;
    if (exploreScoreEl) exploreScoreEl.textContent = `${Math.round(explorePct)}%`;

    if (focusBarEl) focusBarEl.style.width = `${Math.max(0, Math.min(100, focusPct))}%`;
    if (varietyBarEl) varietyBarEl.style.width = `${Math.max(0, Math.min(100, varietyPct))}%`;
    if (exploreBarEl) exploreBarEl.style.width = `${Math.max(0, Math.min(100, explorePct))}%`;

    if (topEl) topEl.textContent = `top: ${top}`;
    if (sugEl) sugEl.textContent = `おすすめ: ${qs.length ? qs.map(q => `「${q}」`).join("、") : "—"}`;
    // Hint the next one-click search target (rotates each click)
    if (searchBtn) {
      const idx = Math.max(0, Number(state.dashQueryIndex || 0)) % Math.max(1, qs.length || 1);
      const nextTopic = qs.length ? String(qs[idx] || qs[0]) : "良いニュース";
      searchBtn.title = `おすすめ: ${nextTopic}（X内検索を開きます）`;
    }
  }

  // -----------------------------
  // Backend selection
  // -----------------------------
  async function ensureBackend(userInitiated) {
    log("debug","[BACKEND]","ensureBackend", { userInitiated, aiMode: settings.aiMode, status: state.sessionStatus });

    if (!settings.enabled || settings.aiMode === "off") {
      state.sessionStatus = "off";
      return false;
    }
    // If user explicitly asked to start AI, warm up the backend session.
    if (userInitiated) {
      setTask("warm up");
      try {
        const w = await sendMessageSafeRetry({ type: "FOLLONE_BACKEND_WARMUP" }, { attempts: 3, timeoutMs: 20000 });
        if (w && w.ok) {
          state.sessionStatus = "ready";
          clearError();
          log("info","[BACKEND]","warmup complete", w);
          signalBackendReady(w);
          return true;
        } else if (w) {
          state.sessionStatus = String(w.status || "unavailable");
          log("warn","[BACKEND]","warmup failed", w);
          // fall through to status check
        }
      } catch (e) {
        log("warn","[BACKEND]","warmup error", String(e));
      }
    }



    // Circuit breaker: if backend is known-unavailable recently, don't spam.
    if (!userInitiated && state.backendRetryAfter && Date.now() < state.backendRetryAfter) {
      return false;
    }

    // auto: Ask SW/offscreen backend (extension origin) for status.
    try {
      const resp = await sendMessageSafeRetry({ type: "FOLLONE_BACKEND_STATUS" }, { attempts: 3, timeoutMs: 3000 });
      if (resp && resp.ok) {
        // Map backend states into UI states
        const a = String(resp.availability || "");
        const s = String(resp.status || "");
        if (a === "available" && (s === "ready" || resp.hasSession)) {
          // If offscreen is up but hasSession=false, first classification can be very slow.
          // Do a single lightweight warmup automatically (throttled).
          if (!resp.hasSession) {
            const now = Date.now();
            const cool = 30 * 1000;
            if (!state.autoWarmupTs || (now - state.autoWarmupTs) > cool) {
              state.autoWarmupTs = now;
              try {
                setTask("warm up");
                log("info","[BACKEND]","auto warmup (no session)", resp);
                const w = await sendMessageSafeRetry({ type: "FOLLONE_BACKEND_WARMUP" }, { attempts: 2, timeoutMs: 30000 });
                if (w && w.ok) {
                  state.sessionStatus = "ready";
                  clearError();
                  signalBackendReady(w);
                  setTask("stand-by");
                  return true;
                }
                // If warmup fails, fall through and keep status for UX.
                log("warn","[BACKEND]","auto warmup failed", w);
              } catch (e) {
                log("warn","[BACKEND]","auto warmup error", String(e));
              }
            }
          }

          state.sessionStatus = "ready";
          clearError();
          log("info","[BACKEND]","sw/offscreen ready", resp);
          signalBackendReady(resp);
          return true;
        }
        if (a === "downloadable" || a === "downloading" || s === "downloadable" || s === "downloading") {
          state.sessionStatus = a || s;
          setError("PROMPT_NEEDS_DOWNLOAD", String(a || s));
          log("warn","[BACKEND]","model not ready (needs download)", resp);
          // Not ready => do not run classification loop.
          return false;
        }
        if (a === "unavailable" || s === "unavailable") {
          state.sessionStatus = "unavailable";
          setError("PROMPT_UNAVAILABLE", "unavailable");
          // Backoff to avoid repeatedly crashing the model process.
          state.backendRetryAfter = Date.now() + 60 * 1000;
          log("warn","[BACKEND]","Prompt API unavailable", resp);
          return false;
        }
      } else if (resp) {
        log("warn","[BACKEND]","backend status not ok", resp);
      }

    } catch (e) {
      log("warn","[BACKEND]","backend status failed", String(e));
    }

    // Fallback
    state.sessionStatus = "mock";
    return false;
  }

  
  function truncateText(s, maxChars) {
    const t = String(s || "");
    const n = Math.max(0, Number(maxChars || 0));
    if (!n || t.length <= n) return t;
    return t.slice(0, n) + "…";
  }

  // Normalize tweet text before sending to backend.
  // - Reduce whitespace/newlines
  // - Mask long URLs to keep prompts small
  // - Remove zero-width chars that sometimes appear in DOM
  function normalizePostText(input) {
    let s = String(input || "");
    // Remove zero-width chars
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
    // Collapse URLs (keep a hint that a URL existed)
    s = s.replace(/https?:\/\/\S+/gi, "[URL]");
    // Normalize spaces/newlines
    s = s.replace(/\r\n?/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    s = s.replace(/[ \t]{2,}/g, " ");
    return s.trim();
  }

// -----------------------------
  // Tweet extraction
  // -----------------------------
  function findTweetArticles() {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"], article'));
  }

  function extractPostFromArticle(article) {
    const anchors = Array.from(article.querySelectorAll('a[href*="/status/"]'));
    const a = anchors.find(x => /\/status\/\d+/.test(x.getAttribute("href") || "")) || anchors[0];
    if (!a) return null;

    const href = a.getAttribute("href") || "";
    const m = href.match(/\/status\/(\d+)/);
    if (!m) return null;
    const id = m[1];

    const textNodes = Array.from(article.querySelectorAll('div[data-testid="tweetText"]'));
    let text = "";
    if (textNodes.length) {
      const parts = textNodes.slice(0, 2).map((n, i) => {
        const t = (n.innerText || "").trim();
        if (!t) return "";
        if (textNodes.length >= 2) return (i === 0 ? t : `[引用] ${t}`);
        return t;
      }).filter(Boolean);
      text = parts.join("\n");
    } else {
      const imgs = Array.from(article.querySelectorAll("img[alt]"))
        .map(x => (x.getAttribute("alt") || "").trim())
        .filter(Boolean);
      if (imgs.length) text = `【画像】${imgs.slice(0, 2).join(" / ")}`;
      else text = "【本文なし（メディア投稿の可能性）】";
    }

    let handle = "";
    const userNameEl = article.querySelector('div[data-testid="User-Name"] a[href^="/"]');
    if (userNameEl) handle = (userNameEl.getAttribute("href") || "").replace("/", "").trim();
    const meta = `@${handle || "unknown"}`;

    text = truncateText(normalizePostText(text), settings.maxTextChars);

    return { id, text, meta, elem: article };
  }

  // -----------------------------
  // Low-risk skip heuristics (reverse filter) v0.4.11
  // - Do NOT try to detect "bad words". We only skip posts that are very unlikely to be risky:
  //   (1) no visible text (media-only), (2) emoji-only / symbol-only.
  // - We are conservative to avoid missing short but harmful text.
  function analyzeSignals(post) {
    const raw = String(post?.text || "");
    const s = raw.replace(/\s+/g, " ").trim();
    const alphaNum = (s.match(/[\p{L}\p{N}]/gu) || []).length; // letters/numbers
    const hasUrl = /https?:\/\/|t\.co\/|x\.com\//i.test(s);
    const hasMention = /@[A-Za-z0-9_]{1,20}/.test(s);
    const hasHash = /#[^\s#]{1,40}/.test(s);
    const hasVisibleText = !!post?._hasVisibleText;
    const isMediaOnly = !hasVisibleText && (raw.startsWith("【画像】") || raw.startsWith("【本文なし"));
    const isEmojiOnly = alphaNum === 0 && !hasUrl && !hasMention && !hasHash && s.length > 0;
    return { s, alphaNum, hasUrl, hasMention, hasHash, hasVisibleText, isMediaOnly, isEmojiOnly };
  }

  function shouldSkipAnalysis(post) {
    const sig = analyzeSignals(post);
    if (settings.skipMediaOnly && sig.isMediaOnly) return { skip: true, reason: "media-only" };
    if (settings.skipEmojiOnly && sig.isEmojiOnly) return { skip: true, reason: "emoji-only" };
    return { skip: false, reason: "" };
  }

  function makeSkipResult(id, reason) {
    const tag = (reason === "media-only") ? "画像のみ"
      : (reason === "short-text") ? "低情報量"
      : (reason === "emoji-only") ? "絵文字のみ"
      : "低情報量";
    // Reduce "その他": media-only posts are routed to illustration/manga bucket.
    const topic = (reason === "media-only") ? "イラスト/漫画" : "その他";
    return {
      id: String(id || ""),
      riskScore: 0,
      riskCategory: "なし",
      topicCategory: topic,
      reasons: [tag],
      _source: "skip"
    };
  }



  // -----------------------------
  // Classification: Prompt API
  // -----------------------------
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
              reasons: { type: "array", maxItems: 2, items: { type: "string", enum: REASON_ENUM } }
            },
            required: ["id", "riskScore", "riskCategory", "topicCategory", "reasons"],
            additionalProperties: false
          }
        }
      },
      required: ["results"],
      additionalProperties: false
    };
  }

  function buildClassifyPrompt(batch, topicList) {
    const persona = "あなたは「ふぉろね（follone）」です。少し気怠そうだがユーザーには優しく、介入時は説明重視。";
    const rules = [
      "次のX投稿（複数）について「危険カテゴリ」「危険度」「トピックカテゴリ」を判定し、理由タグ（最大2つ）を選ぶ。",
      `危険カテゴリ: ${RISK_ENUM.join(" / ")}`,
      "危険度: 0〜100（高いほど危険）",
      `トピックカテゴリ: ${topicList.join(" / ")}`,
      `理由タグ: ${REASON_ENUM.join(" / ")}（この中から最大2つ。自由記述は禁止）`,
      "制約: 出力はJSONのみ（responseConstraintに合致）。余計な文は出さない。",
      "注意: 差別語/露骨な性的表現/誹謗中傷の文言は再掲しない。タグで表現する。"
    ].join("\n");

    const payload = batch.map(p => `ID:${p.id}\nTEXT:${p.text}\nMETA:${p.meta}`).join("\n\n---\n\n");
    return `${persona}\n${rules}\n\n${payload}`;
  }

  async function classifyBatchPromptAPI(batch) {
    if (!state.session) return [];
    const topicList = settings.topics.length ? settings.topics : FALLBACK_TOPICS;
    const schema = buildSchema(topicList);
    const prompt = buildClassifyPrompt(batch, topicList);
    const raw = await state.session.prompt(prompt, { responseConstraint: schema });
    try {
      const obj = JSON.parse(raw);
      return Array.isArray(obj && obj.results) ? obj.results : [];
    } catch (_e) {
      log("error","[BACKEND]","create() failed -> mock", String(_e));
      return [];
    }
  }

  // -----------------------------
  // Classification: Mock (no cost, always available)
  // -----------------------------
  const MOCK = {
    // Keep lists conservative (no slurs). This is for broad detection only.
    harassment: ["死ね", "消えろ", "バカ", "黙れ", "無能", "ゴミ"],
    politics: ["選挙", "政党", "国会", "首相", "議員", "投票", "与党", "野党"],
    bias: ["差別", "偏見", "ヘイト", "排除"],
    fraud: ["当選", "無料", "プレゼント", "DMして", "リンク", "限定", "儲かる", "副業", "投資", "詐欺"],
    adult: ["18禁", "アダルト", "R18", "性的", "露出"],
  };

  const TOPIC_HINTS = [
    { topic: "政治", keys: ["選挙","政党","国会","議員","政策","外交"] },
    { topic: "経済", keys: ["株","為替","物価","景気","企業","決算","雇用"] },
    { topic: "国際", keys: ["海外","国連","外交","紛争","条約","大使館"] },
    { topic: "テック", keys: ["AI","Chrome","iPhone","Android","GPU","プログラミング","アップデート"] },
    { topic: "科学", keys: ["研究","論文","宇宙","物理","化学","生物"] },
    { topic: "教育", keys: ["学校","授業","受験","学習","先生","高校","大学"] },
    { topic: "健康", keys: ["健康","睡眠","運動","病院","医療","メンタル"] },
    { topic: "スポーツ", keys: ["試合","選手","優勝","リーグ","野球","サッカー","バスケ"] },
    { topic: "エンタメ", keys: ["芸能","ドラマ","配信","ライブ","イベント"] },
    { topic: "音楽", keys: ["曲","アルバム","ライブ","歌","演奏"] },
    { topic: "映画/アニメ", keys: ["映画","アニメ","声優","監督","上映"] },
    { topic: "ゲーム", keys: ["ゲーム","Switch","PS","攻略","ガチャ"] },
    { topic: "趣味", keys: ["模型","ガンプラ","カメラ","釣り","料理","DIY"] },
    { topic: "創作", keys: ["創作","イラスト","漫画","小説","制作"] },
    { topic: "生活", keys: ["生活","家事","節約","買い物","家族"] },
    { topic: "旅行", keys: ["旅行","観光","ホテル","空港","温泉"] },
    { topic: "歴史", keys: ["歴史","戦国","近代","古代","史料"] },
    { topic: "ビジネス", keys: ["ビジネス","起業","マーケ","営業","採用"] },
  ];

  function sanitizeForSummary(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "（本文が短い/少ない投稿）";
    return t.slice(0, 80) + (t.length > 80 ? "…" : "");
  }

  function countHits(text, keys) {
    let n = 0;
    for (const k of keys) if (text.includes(k)) n += 1;
    return n;
  }

  function mockClassifyOne(post) {
    const t = String(post.text || "");
    let riskCategory = "なし";
    let score = 0;

    const h = countHits(t, MOCK.harassment);
    const p = countHits(t, MOCK.politics);
    const b = countHits(t, MOCK.bias);
    const f = countHits(t, MOCK.fraud);
    const a = countHits(t, MOCK.adult);

    const max = Math.max(h, p, b, f, a);
    if (max > 0) {
      if (max === h) riskCategory = "誹謗中傷";
      else if (max === p) riskCategory = "政治";
      else if (max === b) riskCategory = (t.includes("差別") ? "差別" : "偏見");
      else if (max === f) riskCategory = "詐欺";
      else if (max === a) riskCategory = "成人向け";

      // conservative scoring
      score = Math.min(100, 40 + max * 18);
    }

    // Topic
    let topic = "その他";
    for (const rule of TOPIC_HINTS) {
      if (rule.keys.some(k => t.includes(k))) { topic = rule.topic; break; }
    }
    if (!settings.topics.includes(topic)) {
      // If user's topic list differs, try to map to an existing one, else keep "その他"
      if (settings.topics.includes("その他")) topic = "その他";
      else topic = settings.topics[0] || "その他";
    }

        const reasons = [];
    if (riskCategory === "誹謗中傷") reasons.push("攻撃的な言い回し", "個人への非難");
    else if (riskCategory === "政治") reasons.push("政治的煽動");
    else if (riskCategory === "偏見") reasons.push("属性の一般化");
    else if (riskCategory === "差別") reasons.push("差別的表現");
    else if (riskCategory === "詐欺") reasons.push("金銭/誘導", "詐欺の可能性");
    else if (riskCategory === "成人向け") reasons.push("性的示唆");
    return {
      id: String(post.id),
      riskScore: score,
      riskCategory,
      topicCategory: topic,
      reasons: reasons.slice(0, 2)
    };
  }

  function buildMockSearches(riskCategory) {
    // Always return safe, neutral queries.
    if (riskCategory === "詐欺") return ["詐欺 注意喚起", "公式発表 確認", "手口 事例"];
    if (riskCategory === "政治") return ["別視点 ニュース", "ファクトチェック", "政策 解説"];
    if (riskCategory === "誹謗中傷") return ["ネットリテラシー", "健全な話題", "言葉の暴力 対策"];
    if (riskCategory === "差別" || riskCategory === "偏見") return ["差別 啓発", "多様性 基礎", "ヘイトスピーチ 仕組み"];
    if (riskCategory === "成人向け") return ["安全な話題", "年齢制限 ルール", "健全なコンテンツ"];
    return ["別視点", "一次情報", "関連キーワード"];
  }

  async function classifyBatchMock(batch) {
    return batch.map(mockClassifyOne);
  }

  async function classifyBatch(batch) {
    if (settings.aiMode === "off") return [];

    // Try offscreen Prompt API backend first (extension origin).
    if (settings.aiMode === "auto") {
      try {
        const t0 = performance.now();
        setTask("classing");
        // NOTE: FIFO queue: no per-batch priority.
        log("debug", "[AI]", "send->sw", { backend: "offscreen", n: batch.length, chars: batch.reduce((acc, p) => acc + String(p?.text || "").length, 0) });
        // NOTE: SW->offscreen Prompt API can occasionally take >20s on cold start.
        // Use a longer timeout and DO NOT retry to avoid duplicate classifications.
        const resp = await sendMessageSafeRetry({
          type: "FOLLONE_CLASSIFY_BATCH",
          batch,
          topicList: settings.topics,
          prefs: { fastMode: settings.fastMode, useConstraint: settings.useConstraint, characterId: normalizeCharId(settings.characterId) },
        }, { attempts: 1, timeoutMs: 65000 });
const dt = Math.round(performance.now() - t0);
        if (!resp) {
          // Timeout / channel issue. Do NOT mislabel as context invalidated.
          setError("BACKEND_TIMEOUT", "no response");
          log("warn", "[AI]", "backend timeout -> empty", { backend: "offscreen", timeoutMs: 65000 });
          setTask("stand-by");
          signalAnyResult({ engine: "none", error: "timeout" });
          signalFirstClassifyDone({ ok: false, engine: "none", error: "timeout" });
          return [];
        }
        if (resp && resp.ok && Array.isArray(resp.results)) {
          state.sessionStatus = "ready";
          clearError();
          log("info", "[AI]", "recv", { backend: resp.backend || "offscreen", engine: resp.engine || "prompt_api", status: resp.status, availability: resp.availability, latencyMs: resp.latencyMs || dt, n: resp.results.length });

          state.lastLatencyMs = Number(resp.latencyMs || dt);
          state.lastEngine = resp.engine || "prompt_api";
          clearError();
          setTask("stand-by");
          signalAnyResult({ engine: state.lastEngine, latencyMs: state.lastLatencyMs });
          if ((resp.engine || "prompt_api") === "prompt_api") signalPromptResult({ latencyMs: state.lastLatencyMs });
          signalFirstClassifyDone({ ok: true, engine: state.lastEngine, latencyMs: state.lastLatencyMs });
          return resp.results;
        } else if (resp) {
          setError("BACKEND_NOT_OK", String(resp?.status || resp?.availability || "unknown"));
          log("warn","[AI]","backend not ok -> empty", { status: resp.status, availability: resp.availability, engine: resp.engine, error: resp.error });

          // If Chrome reports repeated model crashes, cool down harder to let it recover.
          const errText = String(resp?.error || resp?.errorCode || "");
          if (/crashed too many times/i.test(errText) || /The model process crashed/i.test(errText)) {
            state.backendRetryAfter = Date.now() + 10 * 60 * 1000;
          } else {
            state.backendRetryAfter = Date.now() + 30 * 1000;
          }
        }

        // If backend reports not-ready/unavailable, keep sessionStatus for UX, then fall back to mock.
        if (resp && resp.status) {
          state.sessionStatus = String(resp.status);
        }
        // If backend responded but isn't ready/unavailable yet, do NOT release loader gate.
        // We want the loader to end after the first *successful* classify (or hard timeout).
      } catch (e) {
        setError("SW_CLASSIFY_FAILED", String(e));
        log("warn","[CLASSIFY]","SW classify failed -> empty", String(e));
        // Do not release loader gate on transient failures.
      }
    }

    // No mock fallback: Prompt API must be available. If not, return empty.
    signalAnyResult({ engine: "none", error: "backend_unavailable" });
    // Do not release loader gate when backend is unavailable.
    return [];
  }

  // -----------------------------
  // Bubble detection + bias aggregation (v2)
  // -----------------------------
  const BIAS_TZ = "Asia/Tokyo";
  const BIAS_STORAGE_KEY = "follone_biasAgg_v2";
  const BIAS_TOPICS = [
    "社会",
    "政治",
    "経済",
    "テック",
    "科学",
    "教育",
    "健康",
    "スポーツ",
    "エンタメ",
    "イラスト/漫画",
    "趣味/生活",
    "その他"
  ];
  const LEGACY_DEFAULT_TOPICS = [
    "社会","政治","経済","国際","テック","科学","教育","健康",
    "スポーツ","エンタメ","音楽","映画/アニメ","ゲーム","趣味",
    "創作","生活","旅行","歴史","ビジネス","その他"
  ];

  function isLegacyDefaultTopics(arr) {
    try {
      if (!Array.isArray(arr) || arr.length !== LEGACY_DEFAULT_TOPICS.length) return false;
      for (let i = 0; i < LEGACY_DEFAULT_TOPICS.length; i++) if (String(arr[i]) !== LEGACY_DEFAULT_TOPICS[i]) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function mapTopicToBias(raw) {
    const t = String(raw || "その他");
    // Map older 20-topic set into 12 buckets.
    if (t === "社会" || t === "国際") return "社会";
    if (t === "政治") return "政治";
    if (t === "経済") return "経済";
    if (t === "テック" || t === "ビジネス") return "テック";
    if (t === "科学") return "科学";
    if (t === "教育") return "教育";
    if (t === "健康") return "健康";
    if (t === "スポーツ") return "スポーツ";
    // Illustration / manga (incl. image-only posts)
    if (t === "イラスト/漫画") return "イラスト/漫画";
    if (t === "映画/アニメ" || t === "創作") return "イラスト/漫画";
    // Entertainment
    if (t === "エンタメ" || t === "音楽") return "エンタメ";
    // Hobbies & daily life
    if (t === "ゲーム" || t === "趣味" || t === "生活" || t === "旅行" || t === "歴史") return "趣味/生活";
    return "その他";
  }

  function tokyoDayKey(ts) {
    try {
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: BIAS_TZ, year: "numeric", month: "2-digit", day: "2-digit"
      });
      return fmt.format(new Date(ts)); // YYYY-MM-DD
    } catch (_) {
      // Fallback: local date
      const d = new Date(ts);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const da = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${da}`;
    }
  }

  async function loadBiasAgg() {
    try {
      const obj = await chrome.storage.local.get([BIAS_STORAGE_KEY]);
      const cur = obj ? obj[BIAS_STORAGE_KEY] : null;
      if (cur && typeof cur === "object" && cur.day && typeof cur.day === "object") {
        state.biasAgg = cur;
      } else {
        state.biasAgg = { tz: BIAS_TZ, topics: BIAS_TOPICS.slice(), day: {}, updatedAt: Date.now() };
      }
      // Ensure topics list is present (for future-proof)
      if (!Array.isArray(state.biasAgg.topics) || !state.biasAgg.topics.length) state.biasAgg.topics = BIAS_TOPICS.slice();

      // M6 bias v2.1 migration:
      // - merge legacy "国際" into "社会"
      // - prefer new topics list (includes "イラスト/漫画")
      try {
        state.biasAgg.topics = BIAS_TOPICS.slice();
        const day = state.biasAgg.day || {};
        for (const k of Object.keys(day)) {
          const d = day[k];
          if (!d || typeof d !== "object") continue;
          const c = d.counts || {};
          if (c["国際"]) {
            c["社会"] = Number(c["社会"] || 0) + Number(c["国際"] || 0);
            delete c["国際"];
          }
        }
      } catch (_) {}
      // Day cache init
      state.biasDayKey = tokyoDayKey(Date.now());
      state.biasDaySeen = new Set();
    } catch (_) {
      state.biasAgg = { tz: BIAS_TZ, topics: BIAS_TOPICS.slice(), day: {}, updatedAt: Date.now() };
    }
  }

  function scheduleBiasAggFlush() {
    if (!state.biasAgg || !state.biasAggDirty) return;
    if (state.biasAggFlushTimer) return;
    state.biasAggFlushTimer = setTimeout(async () => {
      state.biasAggFlushTimer = 0;
      if (!state.biasAggDirty || !state.biasAgg) return;
      state.biasAggDirty = false;
      state.biasAgg.updatedAt = Date.now();
      try {
        await chrome.storage.local.set({ [BIAS_STORAGE_KEY]: state.biasAgg });
      } catch (_) {
        // keep silent
      }
    }, 900);
  }

  function pruneBiasDays(maxDays = 420) {
    if (!state.biasAgg || !state.biasAgg.day) return;
    const keys = Object.keys(state.biasAgg.day).sort();
    if (keys.length <= maxDays) return;
    const drop = keys.slice(0, Math.max(0, keys.length - maxDays));
    for (const k of drop) delete state.biasAgg.day[k];
  }

  function bumpBiasAgg(topic) {
    if (!state.biasAgg) return;
    const dayKey = tokyoDayKey(Date.now());
    if (dayKey !== state.biasDayKey) {
      state.biasDayKey = dayKey;
      state.biasDaySeen = new Set();
    }
    const t = mapTopicToBias(topic);
    const day = state.biasAgg.day[dayKey] || (state.biasAgg.day[dayKey] = { counts: {}, total: 0, newCount: 0 });
    day.total = Number(day.total || 0) + 1;
    day.counts[t] = Number(day.counts[t] || 0) + 1;
    if (!state.biasDaySeen.has(t)) {
      state.biasDaySeen.add(t);
      day.newCount = Number(day.newCount || 0) + 1;
    }
    state.biasAggDirty = true;
    pruneBiasDays(420);
    scheduleBiasAggFlush();
  }

  function normalizedEntropyFromMap(countsMap, total, nAll) {
    const n = Math.max(2, Number(nAll || 0) || countsMap.size || 2);
    if (total <= 0) return 0;
    let h = 0;
    for (const v of countsMap.values()) {
      const p = v / total;
      if (p > 0) h += -p * Math.log(p);
    }
    const hMax = Math.log(n);
    return hMax > 0 ? (h / hMax) : 0;
  }

  function updateTopicStats(topic) {
    const t = mapTopicToBias(topic);
    // rolling window
    state.topicHistory.push(t);
    const isNew = !state.topicSeen.has(t);
    if (isNew) state.topicSeen.add(t);
    state.topicNewFlags.push(isNew ? 1 : 0);

    while (state.topicHistory.length > settings.topicWindow) state.topicHistory.shift();
    while (state.topicNewFlags.length > settings.topicWindow) state.topicNewFlags.shift();

    state.topicCounts.set(t, (state.topicCounts.get(t) || 0) + 1);

    // calendar aggregation (Options dashboard)
    bumpBiasAgg(t);
  }

  function pickUnderrepresentedTopics(n) {
    const seen = new Map();
    for (const t of state.topicHistory) seen.set(t, (seen.get(t) || 0) + 1);
    const scored = BIAS_TOPICS.map(t => ({ t, c: seen.get(t) || 0 })).sort((a,b) => a.c - b.c);
    return scored.slice(0, n).map(x => x.t);
  }

  async function maybeShowFilterBubble() {
    const now = Date.now();

    const hist = state.topicHistory;
    const flags = state.topicNewFlags;

    // Always refresh the 3-axis dashboard, even with a small number of samples.
    // The popup (bubble) still requires enough samples to avoid noisy suggestions.
    if (!hist.length) {
      state.dashFocusPct = 0;
      state.dashVarietyVal = 0;
      state.dashVarietyPct = 0;
      state.dashExplorePct = 0;
      state.dashTopTopic = "—";
      state.dashQueries = [];
      renderWidget();
      return;
    }

    // Count distribution
    const countsMap = new Map();
    for (const c of hist) countsMap.set(c, (countsMap.get(c) || 0) + 1);

    let topCat = null;
    let topN = 0;
    let total = 0;
    for (const [k, v] of countsMap.entries()) {
      total += v;
      if (v > topN) { topN = v; topCat = k; }
    }

    const focus = total > 0 ? (topN / total) : 0; // 0..1 (top-1 share)
    // Effective topics (Variety): exp(H) is intuitive ("実質◯種類")
    let h = 0;
    for (const v of countsMap.values()) {
      const p = v / Math.max(1, total);
      if (p > 0) h += -p * Math.log(p);
    }
    const varietyVal = Math.exp(h); // 1..K
    const varietyPct = (varietyVal / Math.max(1, BIAS_TOPICS.length)) * 100;

    // For the popup thresholds, keep the normalized entropy (stable across K)
    const entN = normalizedEntropyFromMap(countsMap, total, BIAS_TOPICS.length); // 0..1

    const explore = total > 0 ? (flags.reduce((a,b)=>a+(b?1:0),0) / Math.max(1, flags.length)) : 0;

    const focusPct = Math.round(focus * 100);
    const explorePct = Math.round(explore * 100);

    const qs = pickUnderrepresentedTopics(3);

    // Always-visible dashboard refresh
    state.dashFocusPct = focusPct;
    state.dashVarietyVal = varietyVal;
    state.dashVarietyPct = Math.max(0, Math.min(100, varietyPct));
    state.dashExplorePct = explorePct;
    state.dashTopTopic = topCat || "その他";
    state.dashQueries = qs;
    renderWidget();

    // Optional popup (cooldown) - still based on "Focus high + Variety low"
    const enoughSamples = hist.length >= settings.bubbleMinSamples;
    const canNotify =
      enoughSamples &&
      settings.bubblePopup &&
      (now - state.lastBubbleTs >= settings.bubbleCooldownMs) &&
      focus >= settings.bubbleDominance &&
      entN <= settings.bubbleEntropy;

    if (canNotify) {
      state.lastBubbleTs = now;
      try {
        showBubbleCard(state.dashTopTopic, focus, varietyVal, explore, qs.length ? qs : ["別の視点", "検証", "一次情報"]);
      } catch (_) {}
    }
  }

  async function suggestSearchesLLM(topCat, fallbackTopics) {
    try {
      const schema = {
        type: "object",
        properties: { queries: { type: "array", maxItems: 3, items: { type: "string" } } },
        required: ["queries"],
        additionalProperties: false
      };
      const prompt = [
        "あなたは「ふぉろね（follone）」です。説明重視だが短く。",
        "X内検索に使う、偏りをほぐすための安全で中立な検索語句を3つ提案してください。",
        `偏りが強いカテゴリ: ${topCat}`,
        `方向性（話題例）: ${fallbackTopics.join(" / ")}`,
        "制約: 誹謗中傷や差別を助長する語は避ける。成人向けの露骨語も避ける。学習/検証/別視点を促す。",
        "出力はJSONのみ。"
      ].join("\n");
      const raw = await state.session.prompt(prompt, { responseConstraint: schema });
      const obj = JSON.parse(raw);
      const qs = Array.isArray(obj && obj.queries) ? obj.queries : [];
      const cleaned = qs.map(s => String(s).trim()).filter(Boolean).slice(0, 3);
      return cleaned.length ? cleaned : fallbackTopics;
    } catch (_e) {
      log("error","[BACKEND]","create() failed -> mock", String(_e));
      return fallbackTopics;
    }
  }

  function showBubbleCard(topCat, focus01, varietyVal, explore01, suggestions) {
    // B: separate toast popup (not inside the widget)
    const old = document.getElementById("follone-toast");
    if (old) old.remove();

    const host = document.body || document.documentElement;
    if (!host) return;

    const sug = (Array.isArray(suggestions) ? suggestions : []).slice(0, 3).map(s => String(s || "").trim()).filter(Boolean);
    while (sug.length < 3) sug.push("別の視点");

    const toast = document.createElement("div");
    toast.id = "follone-toast";
    toast.className = "follone-toast";
    toast.innerHTML = `
      <div class="ft-head">
        <div class="ft-title">視野が偏り気味</div>
        <button class="ft-close" type="button" aria-label="close">×</button>
      </div>
      <div class="ft-body">
        <div class="ft-line">最近「${escapeHtml(topCat)}」が続いてるかも。</div>
        <div class="ft-sub">別の視点を少し混ぜると、判断が安定するよ。</div>
        <div class="ft-btns">
          <button class="ft-btn" type="button" data-q="${escapeHtml(sug[0])}">${escapeHtml(sug[0])}</button>
          <button class="ft-btn" type="button" data-q="${escapeHtml(sug[1])}">${escapeHtml(sug[1])}</button>
          <button class="ft-btn" type="button" data-q="${escapeHtml(sug[2])}">${escapeHtml(sug[2])}</button>
        </div>
        <div class="ft-meta">focus:${Math.round(Number(focus01||0)*100)}% / variety:${Number(varietyVal||0).toFixed(1)} / explore:${Math.round(Number(explore01||0)*100)}%</div>
      </div>
    `;

    host.appendChild(toast);

    // Wire events
    toast.querySelector(".ft-close")?.addEventListener("click", () => toast.remove());
    toast.querySelectorAll("button[data-q]").forEach((btn) => {
      btn.addEventListener("click", () => {
        addXp(4);
        openXSearch(btn.getAttribute("data-q") || "別の視点");
        toast.remove();
      });
    });

    // Auto close
    window.setTimeout(() => { if (toast && toast.isConnected) toast.remove(); }, 12000);
  }

// -----------------------------
  // Interventions
  // -----------------------------
  function severityFor(score) {
    if (score >= settings.riskHard) return "hard";
    if (score >= settings.riskSoft) return "soft";
    return "none";
  }

  function xpForIntervention(sev) {
    return sev === "hard" ? 10 : 6;
  }

  function showIntervention(elem, res) {
    mountUI();

    const score = Number(res?.riskScore || 0);
    const cat = String(res?.riskCategory || "なし");
    const sev = severityFor(score);

    const searches = pickOppositeQueries(cat, 3);
    const searchLine = searches.length ? `検索候補: ${searches.map(s => `「${s}」`).join("、")}` : "検索候補:（なし）";

    const reasons = Array.isArray(res?.reasons) ? res.reasons.slice(0, 2).map(x => String(x)) : [];
    const reasonLine = reasons.length ? `理由: ${reasons.join(" / ")}` : "理由:（省略）";

    const catNorm = (() => {
      const c = String(cat || "");
      if (c.startsWith("政治")) return "政治";
      if (c.startsWith("詐欺")) return "詐欺";
      if (c.startsWith("暴力")) return "暴力・脅迫";
      if (c.startsWith("自傷")) return "自傷";
      if (c.startsWith("成人")) return "成人向け";
      if (c.startsWith("スパム")) return "スパム";
      if (c.startsWith("誹謗")) return "誹謗中傷";
      if (c.startsWith("差別")) return "差別";
      if (c.startsWith("偏見")) return "偏見";
      return c || "その他";
    })();

    const guide = (() => {
      switch (catNorm) {
        case "誹謗中傷": return "言葉が強い流れ。距離を取ってOK。";
        case "政治": return "熱くなりやすい。一次情報＋別視点を混ぜよう。";
        case "偏見": return "決めつけ注意。例外や文脈も見て判断。";
        case "差別": return "属性での断定・排除に注意。";
        case "詐欺": return "誘導や金銭の匂い。リンク/DM/個人情報は慎重に。";
        case "成人向け": return "年齢により不適切な可能性。必要なら回避。";
        case "暴力・脅迫": return "刺激強め。深呼吸して一旦距離。";
        case "自傷": return "気持ちが引っ張られる時は離れてOK。";
        default: return "刺激が強いかも。無理せず切り替えてね。";
      }
    })();

    const bullets = reasons.length
      ? `<ul class="follone-bullets">${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
      : `<div class="follone-muted">理由:（省略）</div>`;

    const html = `
      <div class="follone-int-title">…ちょい待って。</div>
      <div class="follone-int-kind">${escapeHtml(cat)} の可能性</div>
      ${bullets}
      <div class="follone-int-guide">${escapeHtml(guide)}</div>
    `;
    const muted = `${searchLine}（誘導先はX内検索）`;

    const ok = openSpotlight({
      elem,
      id: res?.id,
      severity: sev,
      badgeText: `${cat} / ${score}`,
      subText: `危険投稿の可能性（${sev === "hard" ? "強" : "中"}）`,
      html,
      muted,
      searches,
      cat,
      score
    });
    if (!ok) {
      // Fallback: legacy overlay
      const ov = document.getElementById("follone-overlay");
      const text = document.getElementById("follone-ov-text");
      const badge = document.getElementById("follone-ov-badge");
      const md = document.getElementById("follone-ov-muted");
      if (!ov || !text || !badge || !md) return;
      badge.textContent = `${cat} / ${score}`;
      text.innerHTML = html;
      md.textContent = muted;
      ov.style.display = "block";
      lockScroll(true, elem);
    }
  }

  // -----------------------------
  // Processing loop
  // -----------------------------
  function enqueueForAnalysis(post) {
    ensureRuntimeMaps();
    if (!post || !post.id) return;

    // If we already have a result, no need to analyze.
    if (!settings.forceLLM && state.riskCache.has(post.id)) return;

    // Stable ordering: top -> bottom (y asc), then enqueue sequence.
    let y = 0;
    try {
      const r = post.elem?.getBoundingClientRect?.();
      if (r) y = (window.scrollY || 0) + r.top;
    } catch (_) {}

    const norm = normalizeForHash(post.text || "");
    const textHash = norm ? fnv1a32(norm) : "";
    if (textHash) setIdHash(post.id, textHash);

    // Hash cache fast path (id-independent reuse) — disabled in dev forceLLM mode
    if (!settings.forceLLM && textHash && !state.riskCache.has(post.id)) {
      const cached = state.hashCache.get(textHash);
      if (cached) {
        const res = { ...cached, id: post.id };
        state.riskCache.set(post.id, res);
        state.elemById.set(post.id, post.elem);
        try { post.elem.dataset.folloneId = post.id; } catch (_) {}
        try { maybeAttachIdTag(post.elem, post.id); } catch (_) {}
        touchPersistentCache(post.id, shrinkResultForCache(res), textHash);
        log("debug", "[CACHE]", "hit(hash)", { id: post.id, h: textHash });
        return;
      }
    }

    const sk = shouldSkipAnalysis(post);
    if (sk.skip && !settings.forceLLM) {
      const res = makeSkipResult(post.id, sk.reason);
      state.riskCache.set(post.id, res);
      touchPersistentCache(post.id, shrinkResultForCache(res), textHash);
      state.elemById.set(post.id, post.elem);
      try { post.elem.dataset.folloneId = post.id; } catch (_) {}
      try { maybeAttachIdTag(post.elem, post.id); } catch (_) {}
      log("debug", "[SKIP]", sk.reason, { id: post.id });
      return;
    }

    // Already queued/sent: do not enqueue twice (avoids infinite re-analysis)
    if (state.sentForAnalysis.has(post.id)) {
      log("debug", "[QUEUE]", "skip(already_sent)", { id: post.id });
      return;
    }

    state.sentForAnalysis.add(post.id);

    const seq = ++state.enqSeq;
    state.seqById.set(post.id, seq);
    post.seq = seq;
    post.y = y;
    state.canceledIds.delete(post.id);
    state.elemById.set(post.id, post.elem);
    try { post.elem.dataset.folloneId = post.id; } catch (_) {}
    try { maybeAttachIdTag(post.elem, post.id); } catch (_) {}

    // Single FIFO queue (no priority)
    state.analyzeLow.push(post);
    state.analyzeHigh = [];

    log("debug", "[QUEUE]", "enqueueForAnalysis", { id: post.id, seq, y, q: state.analyzeLow.length });
  }


function choosePriorityBatch(maxN) {
    ensureRuntimeMaps();
    const max = Math.max(1, Number(maxN || 1));

    // Single queue, but prefer posts near the viewport first (better perceived latency).
    const q = state.analyzeLow;
    if (!q.length) return { batch: [] };

    const candidates = q.filter(p => p && p.id && !state.canceledIds.has(p.id));
    if (!candidates.length) return { batch: [] };

    const score = (p) => {
      // near viewport -> higher priority (lower score)
      const near = p?.elem ? (isNearViewport(p.elem) ? 0 : 1) : 1;
      const y = Number(p?.y || 0);
      const seq = Number(p?.seq || 0);
      return { near, y, seq };
    };

    const sorted = candidates.slice().sort((a, b) => {
      const sa = score(a), sb = score(b);
      if (sa.near !== sb.near) return sa.near - sb.near;
      if (sa.y !== sb.y) return sa.y - sb.y;
      return sa.seq - sb.seq;
    });

    const batch = [];
    const takeIds = new Set();
    for (const p of sorted) {
      if (batch.length >= max) break;
      batch.push(p);
      takeIds.add(p.id);
    }
    if (!batch.length) return { batch: [] };

    state.analyzeLow = q.filter(p => !takeIds.has(p?.id));
    state.analyzeHigh = [];

    return { batch };
  }
  function isNearViewport(elem) {
    try {
      const r = elem.getBoundingClientRect();
      const pad = Math.max(1200, window.innerHeight * 2);
      return r.top < window.innerHeight + pad && r.bottom > -pad;
    } catch (_) {
      return false;
    }
  }

  function scheduleAnalyze(delayMs) {
    if (state.analyzeScheduled) return;
    state.analyzeScheduled = true;
    const d = typeof delayMs === "number" ? delayMs : 120;
    setTimeout(analyzePump, Math.max(0, d));
  }

  async function analyzePump() {
    state.analyzeScheduled = false;
    ensureRuntimeMaps();
    if (!settings.enabled) return;
    if (state.inFlight) return;

    // Keep backend status fresh
    await ensureBackend(false);
    renderWidget();

    if (state.sessionStatus === "off") return;


    // During startup loader, prefer waiting for Prompt backend instead of burning mock calls.
    if (loader.shown && loader.kind === "boot" && settings.aiMode === "auto") {
      const now = Date.now();
      const canWait = (loader.gateDeadlineTs && now < loader.gateDeadlineTs);
      if (canWait && state.sessionStatus !== "ready") {
        log("debug","[AI]","waiting backend during loader", { status: state.sessionStatus });
        scheduleAnalyze(120);
        return;
      }
    }

    const backlog = state.analyzeLow.length;
    if (!backlog) return;

    // Dynamic batch sizing (M6-B):
    // - Keep it stable on school PCs: 3..5 is the sweet spot.
    // - If latency is low, increase batch to improve throughput.
    // - If latency spikes, fall back to smaller batches to keep UI responsive.
    const last = Number(state.lastLatencyMs || 0);
    const base = Math.max(3, Math.min(5, Number(settings.batchSize || 3)));
    let maxN = base;
    if (last && last > 9000) maxN = 1;
    else if (last && last > 6500) maxN = 2;
    else if (last && last > 4200) maxN = Math.min(base, 3);
    else if (last && last < 2600) maxN = Math.min(5, Math.max(base, backlog >= 5 ? 5 : 4));
    // When backend is not fully ready, avoid piling up.
    if (state.sessionStatus !== "ready") maxN = Math.min(maxN, 2);
    const { batch } = choosePriorityBatch(maxN);
    if (!batch.length) return;

    state.inFlight = true;
    try {
      log("info", "[CLASSIFY]", "batch", batch.map(x => x.id), { maxN, backlog });
      const results = await classifyBatch(batch);
      log("info", "[CLASSIFY]", "results", results.map(x => ({ id: x.id, risk: x.riskScore, cat: x.riskCategory, topic: x.topicCategory })));

      if (results.length) /* time-based loader */

      for (const r of results) {
        if (!r || !r.id) continue;
        state.riskCache.set(r.id, r);

        // Persist (id + text-hash)
        try {
          const h = getHashForId(r.id);
          touchPersistentCache(r.id, shrinkResultForCache(r), h);
        } catch (_e) {}


        const elem = state.elemById.get(r.id);
        if (!elem) continue;

        // M3 quest: count analyses (caps on SW side)
        recordEvent("analysis_done");

        // Update topic stats
        const topic = String(r.topicCategory || "その他");
        updateTopicStats(topic);

        // If this element is currently fully visible, apply decorations now
        if (isFullyVisible(elem)) {
          maybeApplyResultToElement(elem, r, { from: "analyzePump" });
        } else {
          // If it was marked analyzing, clear marker once we have a result
          elem.classList.remove("follone-analyzing");
        }
      }
      await maybeShowFilterBubble();
    } catch (e) {
      log("error", "[CLASSIFY]", "failed", String(e));
    } finally {
      state.inFlight = false;
      // Continue processing backlog
      if (state.analyzeHigh.length + state.analyzeLow.length) scheduleAnalyze(40);
    }
  }

  function isFullyVisible(elem) {
    try {
      const r = elem.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const eps = 1.5; // allow subpixel rounding
      // Strict "fully in view"
      if (r.top >= -eps && r.left >= -eps && r.bottom <= vh + eps && r.right <= vw + eps) return true;

      // If the element is taller than viewport, it can never be fully visible.
      // In that case, treat "fully visible" as "almost fully visible" (>= 0.98) to avoid dead states.
      const area = Math.max(1, r.width * r.height);
      const visibleH = Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
      const visibleW = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
      const visArea = visibleH * visibleW;
      return (visArea / area) >= 0.98;
    } catch (_) {
      return false;
    }

  }

  function isCenteredEnough(elem, topFrac = 0.18, bottomFrac = 0.82) {
    try {
      const r = elem.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const top = Math.max(0, r.top);
      const bottom = Math.min(vh, r.bottom);
      if (bottom <= top) return false;
      const mid = (top + bottom) / 2;
      // Use the visible slice's center so tall posts don't get unfairly rejected
      return mid >= vh * topFrac && mid <= vh * bottomFrac;
    } catch (_) {
      return false;
    }
  }

  function isInterveneVisible(elem) {
    try {
      const r = elem.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const vw = window.innerWidth || document.documentElement.clientWidth;

      const area = Math.max(1, r.width * r.height);
      const visibleH = Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
      const visibleW = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
      const visArea = visibleH * visibleW;
      const ratio = visArea / area;

      // Normal posts: near-full visibility
      if (r.height <= vh * 0.95) return ratio >= 0.90;

      // Tall posts: accept partial visibility (user can still be reading)
      return ratio >= 0.55 && visibleH >= vh * 0.55;
    } catch (_) {
      return false;
    }
  }

  function isSafeCategory(cat) {
    return cat === "なし" || cat === "問題なし";
  }

  function scheduleHighlightFlush(delayMs) {
    const d = Math.max(0, typeof delayMs === "number" ? delayMs : 0);
    if (state.highlightFlushTimer) clearTimeout(state.highlightFlushTimer);
    state.highlightFlushTimer = setTimeout(() => {
      state.highlightFlushTimer = 0;
      flushHighlightCandidates();
    }, d);
  }

  function scrollElementToCenter(elem, opts) {
    if (!elem || typeof elem.getBoundingClientRect !== "function") return;
    const o = Object.assign({ behavior: "smooth", maxAdjust: 2 }, (opts || {}));
    const doOnce = () => {
      const r = elem.getBoundingClientRect();
      const centerY = r.top + r.height / 2;
      const targetY = window.innerHeight / 2;
      const delta = centerY - targetY;
      if (Math.abs(delta) < 6) return false;
      try {
        window.scrollBy({ top: delta, behavior: o.behavior });
      } catch (_) {
        window.scrollTo(0, (window.scrollY || 0) + delta);
      }
      return true;
    };
    let n = 0;
    const step = () => {
      if (n >= o.maxAdjust) return;
      n++;
      const moved = doOnce();
      if (moved) requestAnimationFrame(() => setTimeout(step, 80));
    };
    requestAnimationFrame(step);
  }


  function flushHighlightCandidates() {
    // Wait until user stops scrolling for a short window
    if (Date.now() - state.lastScrollTs < 260) {
      scheduleHighlightFlush(260);
      return;
    }

    if (state.pendingInterventions.size) {
      log("info", "[HIGHLIGHT]", "flush", { pending: state.pendingInterventions.size, idleMs: Date.now() - state.lastScrollTs });
    }

    // 1) Apply any queued interventions that are now fully visible
    for (const [id, it] of Array.from(state.pendingInterventions.entries())) {
      const elem = it?.elem;
      const res = it?.res;
      if (!elem || !res || !document.contains(elem)) {
        state.pendingInterventions.delete(id);
        continue;
      }
      if (!isFullyVisible(elem)) continue;
      // Try applying again (now idle)
      applyInterventionIfNeeded(elem, res, it?.ctx || { from: "flush" });
      if (state.intervenedIds?.has?.(id)) state.pendingInterventions.delete(id);
    }

    // 2) Safety net: scan currently visible posts and apply highlights if needed
    try {
      const articles = findTweetArticles();
      for (const a of articles) {
        if (!isFullyVisible(a)) continue;
        const id = a.dataset.folloneId;
        if (!id) continue;
        const res = state.riskCache.get(id);
        if (!res) continue;
        applyInterventionIfNeeded(a, res, { from: "scanVisible" });
      }
    } catch (_e) {}
  }

  function applyInterventionIfNeeded(elem, res, ctx) {
    const id = String(res?.id || elem?.dataset?.folloneId || "");
    const score = Number(res?.riskScore || 0);
    const cat = String(res?.riskCategory || "なし");
    const sev = severityFor(score);

    if (!id) return;
    if (isSafeCategory(cat) || sev === "none") return;

    // Must be in-view to even consider
    if (!isInterveneVisible(elem)) {
      // Reset dwell state if it left the viewport
      try { state.interveneHold.delete(id); } catch (_) {}
      return;
    }

    // Smooth startup: avoid instant full-screen takeover on first paint
    const now = Date.now();
    const ARM_AFTER_MS = 1200;          // after script boot
    const NO_INTERACT_GRACE_MS = 2500;  // if user hasn't interacted yet
    const DWELL_MS = 320;              // must stay centered for a moment

    const queueRetry = (reason) => {
      // Keep it pending so highlightFlush/IO can retry once conditions are met
      try { state.pendingInterventions.set(id, { elem, res, ctx, ts: now, reason }); } catch (_) {}
      scheduleHighlightFlush(320);
    };

    if ((now - state.bootTs) < ARM_AFTER_MS) {
      queueRetry("arm");
      return;
    }
    if (!state.userInteracted && (now - state.bootTs) < NO_INTERACT_GRACE_MS) {
      queueRetry("grace");
      return;
    }

    // Require element to be roughly centered to avoid edge triggers (top-of-feed etc.)
    if (!isCenteredEnough(elem)) {
      try { state.interveneHold.delete(id); } catch (_) {}
      queueRetry("center");
      return;
    }

    // Dwell: require the post to remain centered briefly (prevents rapid-fire/false jumps)
    const hold = state.interveneHold.get(id);
    if (!hold || hold.stage !== "centered") {
      state.interveneHold.set(id, { stage: "centered", since: now });
      queueRetry("dwell_start");
      return;
    }
    if ((now - Number(hold.since || now)) < DWELL_MS) {
      queueRetry("dwell");
      return;
    }

    if (state.intervenedIds.has(id)) return;
    state.intervenedIds.add(id);
    try { state.interveneHold.delete(id); } catch (_) {}

    elem.classList.add("follone-danger");
    state.riskCount += 1;
    log("warn", "[INTERVENE]", "show", { id, cat, score, backend: state.sessionStatus, from: ctx?.from || "unknown" });
    showIntervention(elem, res);
    addXp(xpForIntervention(sev));
  }

function maybeApplyResultToElement(elem, res, ctx) {
    const score = Number(res?.riskScore || 0);
    const cat = String(res?.riskCategory || "なし");
    const sev = severityFor(score);

    // Only intervene for non-safe categories and when score exceeds threshold.
    if (isSafeCategory(cat) || sev === "none") return;

    // Trigger condition: post must be fully visible.
    if (!isFullyVisible(elem)) return;

    // If user is scrolling, queue this intervention and retry once the scroll settles.
    if (Date.now() - state.lastScrollTs < 260) {
      state.pendingInterventions.set(res.id, { elem, res, ctx, ts: Date.now() });
      scheduleHighlightFlush(280);
      return;
    }

    applyInterventionIfNeeded(elem, res, ctx);
  }

  function sessionSeconds() {
    return Math.floor((Date.now() - state.sessionStartMs) / 1000);
  }

  function buildReportText() {
    const sec = sessionSeconds();
    if (sec < settings.reportMinSeconds) {
      return `まだ${settings.reportMinSeconds}秒未満だよ。もう少し見てからの方が、ちゃんと役に立つレポートになる。`;
    }
    const entries = Array.from(state.topicCounts.entries()).sort((a, b) => b[1] - a[1]);
    const top3 = entries.slice(0, 3).map(([k, v]) => `${k}:${v}`).join(" / ") || "（未集計）";
    const backend = (state.sessionStatus === "ready") ? "PromptAPI" : (state.sessionStatus === "mock") ? "Mock" : "OFF";
    return [
      "今日のミニレポートだよ。",
      `閲覧時間: ${sec}秒`,
      `危険介入回数: ${state.riskCount}`,
      `上位トピック: ${top3}`,
      `判定方式: ${backend}`,
      "偏りが出たら、たまに別ジャンルも混ぜると情報の精度が上がるよ。"
    ].join("\n");
  }

  function maybeSuggestInactiveReport() {
    const now = Date.now();
    const inactiveMs = now - state.lastUserActivityTs;
    if (inactiveMs < settings.inactiveSuggestSeconds * 1000) return;
    if (now - state.lastInactiveSuggestTs < settings.inactiveCooldownMs) return;

    state.lastInactiveSuggestTs = now;

    const body = document.getElementById("follone-body");
    if (!body) return;

    const old = body.querySelector("[data-follone-inactive='1']");
    if (old) old.remove();

    const box = document.createElement("div");
    box.setAttribute("data-follone-inactive", "1");
    box.style.marginTop = "12px";
    box.style.padding = "10px 12px";
    box.style.borderRadius = "12px";
    box.style.background = "rgba(255,255,255,0.08)";

    box.innerHTML = `
      <div style="font-weight:900;">…ちょっと休憩？</div>
      <div style="opacity:0.9; margin-top:6px;">無操作が続いてるから、ミニレポート出しとこっか。</div>
      <div class="row" style="margin-top:10px;">
        <button id="follone-show-report">レポート</button>
        <button id="follone-dismiss-report">今はいい</button>
      </div>
    `;

    box.querySelector("#follone-show-report").addEventListener("click", () => {
      addXp(2);
      alert(buildReportText());
      box.remove();
    });
    box.querySelector("#follone-dismiss-report").addEventListener("click", () => box.remove());

    body.appendChild(box);
  }

  // -----------------------------
  // Observers
  // -----------------------------
  function startObservers() {
    // Prefetch observer: starts analysis before user fully sees the post.
    const prefetchIO = new IntersectionObserver((entries) => {
      ensureRuntimeMaps();
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const article = e.target;
        if (article.dataset.folloneDiscovered === "1") continue;
        article.dataset.folloneDiscovered = "1";

        // Extract in idle to avoid scroll jank
        state.discoverQueue.push(article);
        scheduleDiscovery(0);
      }
    }, { root: null, threshold: 0.01, rootMargin: "3500px 0px 3500px 0px" });

    // Warm observer: bumps priority shortly before the post becomes visible.
    const warmIO = new IntersectionObserver((entries) => {
      ensureRuntimeMaps();
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const article = e.target;
        const post = extractPostFromArticle(article);
        if (post) {
          enqueueForAnalysis(post, "high");
          scheduleAnalyze(0);
        }
      }
    }, { root: null, threshold: 0.01, rootMargin: "900px 0px 900px 0px" });

    // Highlight observer: triggers when post is almost fully visible.
    const highlightIO = new IntersectionObserver((entries) => {
      ensureRuntimeMaps();
      for (const e of entries) {
        const article = e.target;
        if (!e.isIntersecting) continue;

        // When an element enters view, schedule a highlight flush once scroll settles
        scheduleHighlightFlush(280);

        const id = article.dataset.folloneId;
        if (!id) {
          // Try to extract quickly when user actually sees it
          const post = extractPostFromArticle(article);
          if (post) {
            enqueueForAnalysis(post, "high");
            scheduleAnalyze(0);
          }
          /* v0.4.21: per-post analyzing badge removed */
          continue;
        }

        const res = state.riskCache.get(id);
        if (res) {
          article.classList.remove("follone-analyzing");
          maybeApplyResultToElement(article, res, { from: "highlightIO" });
        } else {
          // Not yet analyzed: show analyzing badge and prioritize this post now.
          /* v0.4.21: per-post analyzing badge removed */
          // If we have the element mapped, create a tiny "priority bump"
          const post = extractPostFromArticle(article);
          if (post) {
            enqueueForAnalysis(post, "high");
            scheduleAnalyze(0);
          }
        }
      }
    }, { root: null, threshold: 0.92 });

    function attachAll() {
      for (const a of findTweetArticles()) {
        prefetchIO.observe(a);
        warmIO.observe(a);
        highlightIO.observe(a);
      }
    }

    const mo = new MutationObserver(() => attachAll());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    attachAll();

    // Scroll/user activity tracking
    const onUserActivity = () => {
      const now = Date.now();
      state.lastScrollTs = now;
      state.lastUserActivityTs = now;
      if (!state.userInteracted) {
        state.userInteracted = true;
        state.firstInteractionTs = now;
      }
      scheduleHighlightFlush(280);
    };
    window.addEventListener("scroll", onUserActivity, { passive: true });
    window.addEventListener("mousemove", onUserActivity, { passive: true });
    window.addEventListener("keydown", onUserActivity, { passive: true });
    window.addEventListener("pointerdown", onUserActivity, { passive: true });

    // Inactive suggestion tick
    setInterval(maybeSuggestInactiveReport, 2000);

    // Kick initial discovery/analyze
    scheduleDiscovery(0);
    scheduleAnalyze(0);
  }

  function scheduleDiscovery(delayMs) {
    if (state.discoverScheduled) return;
    state.discoverScheduled = true;
    setTimeout(discoveryPump, Math.max(0, typeof delayMs === "number" ? delayMs : 60));
  }

  function discoveryPump() {
    ensureRuntimeMaps();
    const backlogGuard = state.analyzeHigh.length + state.analyzeLow.length;
    if (backlogGuard > 140) {
      log("debug","[DISCOVER]","backlog high -> pause", { backlog: backlogGuard });
      scheduleDiscovery(220);
      return;
    }
    state.discoverScheduled = false;
    const limit = 14; // per pump
    let done = 0;

    while (done < limit && state.discoverQueue.length) {
      const article = state.discoverQueue.shift();
      if (!article) continue;
      if (state.processed.has(article)) continue;
      state.processed.add(article);

      const post = extractPostFromArticle(article);
      if (!post) continue;

      enqueueForAnalysis(post);
      done += 1;
    }

    if (done) {
      log("debug", "[DISCOVER]", "pump", { done, left: state.discoverQueue.length, high: state.analyzeHigh.length, low: state.analyzeLow.length });
      scheduleAnalyze(0);
    }

    if (state.discoverQueue.length) scheduleDiscovery(80);
  }


  // -----------------------------
  // Boot
  // -----------------------------
  (async () => {
    ensureRuntimeMaps();
    await loadSettings();
    await loadBiasAgg();
    await loadResultCache();
    log("info","[SETTINGS]","loaded", { enabled: settings.enabled, aiMode: settings.aiMode, debug: settings.debug, logLevel: settings.logLevel, batchSize: settings.batchSize, idleMs: settings.idleMs });
    mountUI();
    await loadProgress();
    // M3 weekly quest: count active days (SW dedupes per-day)
    recordEvent("day_active");
    renderWidget();

    // Auto-start Prompt API when possible (no extra button)
    if (settings.enabled) {
      scheduleDiscovery(0);
      scheduleAnalyze(0);
    }

    // If model needs activation, any user interaction will attempt to refresh backend state.
    const once = () => {
      window.removeEventListener("pointerdown", once, true);
      window.removeEventListener("keydown", once, true);
      ensureBackend(true).then(() => renderWidget()).catch(() => {});
    };
    window.addEventListener("pointerdown", once, true);
    window.addEventListener("keydown", once, true);

    try {
      const res = await sendMessageSafe({ type: "FOLLONE_PING" });
      if (res) log("info","[SW]","ping", res);
    } catch (e) {
      if (!isContextInvalidated(e)) log("warn","[SW]","ping failed", String(e));
    }
    // Startup loader: use time to cover cold-start analysis
    if (!location.pathname.startsWith("/explore")) {
      setTask("loading");
      runLoaderGate("boot", `mode:${settings.aiMode}`, { minMs: 1400, maxExtraMs: 2500, preferPrompt: true });
    }

    startObservers();

    // Initial backend status (no auto-download)
    if (!settings.enabled || settings.aiMode === "off") {
      state.sessionStatus = "off";
    } else if (settings.aiMode === "auto" /* mock disabled */) { settings.aiMode = "auto";
      state.sessionStatus = "mock";
    } else {
      // auto
      if (typeof LanguageModel === "undefined") state.sessionStatus = "mock";
      else {
        try {
          const a = await LanguageModel.availability(LM_OPTIONS);
          state.sessionStatus = (a === "unavailable") ? "mock" : "not_ready";
        } catch (_e) {
      log("error","[BACKEND]","create() failed -> mock", String(_e));
          state.sessionStatus = "mock";
        }
      }
    }
    renderWidget();

    // Onboarding (M5): one-time intro + character selection, then send user to Options for AI setup.
    try {
      const ob = await chrome.storage.local.get(["follone_onboarding_state","follone_onboarding_done","follone_characterId","follone_ai_ready"]);
      let state = String(ob.follone_onboarding_state || "");
const legacyDone = Boolean(ob.follone_onboarding_done);
const charId = String(ob.follone_characterId || "");
const aiReady = Boolean(ob.follone_ai_ready);

// migration from legacy flags
if (!state) {
  if (legacyDone) state = "completed";
  else if (!charId) state = "character";
  else if (!aiReady) state = "ai-setup";
  else state = "tutorial";
  try { await chrome.storage.local.set({ follone_onboarding_state: state }); } catch (_e) {}
}

const done = (state === "completed");
if (!done && (state === "character" || state === "none")) {
        await showOnboardingOverlay({ presetChar: String(ob.follone_characterId || "") });
      }
    } catch (e) {
      // ignore onboarding failures; do not break timeline
    }
  })();

  async function showOnboardingOverlay({ presetChar }) {
    // Avoid duplicate overlays.
    if (document.getElementById("follone-onboarding")) return;

    const veil = document.createElement("div");
    veil.id = "follone-onboarding";
    veil.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "background:rgba(10,10,12,0.72)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:16px"
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
      "width:min(560px, 92vw)",
      "background:rgba(250,245,236,0.95)",
      "border:1px solid rgba(0,0,0,0.10)",
      "border-radius:16px",
      "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
      "padding:16px",
      "transform:translateY(10px)",
      "opacity:0",
      "transition:transform 240ms ease, opacity 240ms ease"
    ].join(";");

    // (M5) Focus cue overlays were intentionally removed here.
    // Focus guidance is only used in Options for:
    //  - AI model download button
    //  - "Go to tutorial" button

    const title = document.createElement("div");
    title.textContent = "follone for X";
    title.style.cssText = "font-weight:700;font-size:16px;margin-bottom:8px;letter-spacing:0.2px;";

    const msg = document.createElement("div");
    msg.style.cssText = "font-size:13px;line-height:1.55;margin-bottom:12px;color:rgba(0,0,0,0.80);";

    const step = { value: 0 };
    const chosen = { value: (presetChar === "likoris" || presetChar === "follone") ? presetChar : "" };

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px;";

    const btnPrimary = (label) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "cursor:pointer;border:none;border-radius:12px;padding:10px 12px;background:#2b2b32;color:#fff;font-weight:700;font-size:13px;";
      return b;
    };
    const btnGhost = (label) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "cursor:pointer;border:1px solid rgba(0,0,0,0.18);border-radius:12px;padding:10px 12px;background:transparent;color:rgba(0,0,0,0.82);font-weight:700;font-size:13px;";
      return b;
    };

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;";
    const card = (id, name, desc) => {
      const c = document.createElement("button");
      c.type = "button";
      c.style.cssText = "flex:1 1 220px;cursor:pointer;text-align:left;border:1px solid rgba(0,0,0,0.18);border-radius:14px;padding:12px;background:rgba(255,255,255,0.75);";
      const h = document.createElement("div");
      h.textContent = name;
      h.style.cssText = "font-weight:800;margin-bottom:4px;";
      const d = document.createElement("div");
      d.textContent = desc;
      d.style.cssText = "font-size:12px;opacity:0.8;line-height:1.45;";
      c.append(h, d);
      c.addEventListener("click", async () => {
        chosen.value = id;
        update();
        try { await chrome.storage.local.set({ follone_characterId: id }); } catch (_e) {}
      });
      return c;
    };

    const nextBtn = btnPrimary("次へ");
    const openOptionsBtn = btnPrimary("AI準備へ（Options）");
    const skipBtn = btnGhost("あとで");

    nextBtn.addEventListener("click", () => {
      step.value = Math.min(2, step.value + 1);
      update();
    });

    openOptionsBtn.addEventListener("click", async () => {
      if (!chosen.value) {
        chosen.value = "follone";
        try { await chrome.storage.local.set({ follone_characterId: chosen.value }); } catch (_e) {}
      }
      try { await chrome.storage.local.set({ follone_onboarding_phase: "ai_setup", follone_onboarding_state: "ai-setup" }); } catch (_e) {}
      try { await sendMessageSafe({ type: "FOLLONE_OPEN_OPTIONS" }); } catch (_e) {}
      veil.remove();
    });

    skipBtn.addEventListener("click", async () => {
      // Allow continuing without setup; Options can resume.
      try { await chrome.storage.local.set({ follone_onboarding_phase: "ai_setup", follone_onboarding_state: "ai-setup" }); } catch (_e) {}
      veil.remove();
    });

    function setCardSelectedStyles() {
      const cards = row.querySelectorAll("button");
      cards.forEach((c) => {
        const id = c.getAttribute("data-id");
        const on = id && id === chosen.value;
        c.style.borderColor = on ? "rgba(43,43,50,0.75)" : "rgba(0,0,0,0.18)";
        c.style.boxShadow = on ? "0 0 0 3px rgba(43,43,50,0.15)" : "none";
      });
    }

    function update() {
      actions.innerHTML = "";
      row.innerHTML = "";

      if (step.value === 0) {
        msg.innerHTML = "<div style='font-weight:800;margin-bottom:4px;'>まずは“何をする拡張か”だけ。</div><div>強い言葉や煽りに出会ったとき、<br>すぐ反応する前に“選択肢”を出します。</div>";
        actions.append(skipBtn, nextBtn);
      } else if (step.value === 1) {
        msg.innerHTML = "<div style='font-weight:800;margin-bottom:4px;'>Spotlightとは？</div><div>危険っぽい投稿を見つけたら、<br>いったん視線を止めて『戻る / 検索する』を選べます。</div>";
        actions.append(skipBtn, nextBtn);
      } else {
        msg.textContent = "相棒を選択：選んだキャラが、Spotlightで短く話しかけます。";
        const c1 = card("follone", "ふぉろね", "静かに、考える時間をくれる。");
        c1.setAttribute("data-id", "follone");
        const c2 = card("likoris", "りこりす", "明るく、行動を後押しする。");
        c2.setAttribute("data-id", "likoris");
        row.append(c1, c2);
        actions.append(skipBtn, openOptionsBtn);
        setCardSelectedStyles();
      }
    }

    panel.append(title, msg, row, actions);
    veil.append(panel);
    document.documentElement.append(veil);
    update();

    // animate in
    requestAnimationFrame(() => {
      panel.style.opacity = "1";
      panel.style.transform = "translateY(0)";
    });
  }

  // sanity: no invalid chars
  function isSafeText(s) {
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 32 && code !== 10 && code !== 9 && code !== 13) return false;
    }
    return true;
  }
  if (!isSafeText(document.currentScript ? document.currentScript.textContent : "")) {
    // nothing
  }

  // helpers
  function clampInt(v, min, max, fallback) { // shadowed earlier; kept for safety
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }
  function clampFloat(v, min, max, fallback) { // shadowed earlier
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }
})();
