// follone content script (v0.4.6)
// - Prompt API (Gemini Nano) が利用できない環境でも "mock" で動くようにする。
// - This file avoids invisible/invalid characters.

(() => {
  "use strict";

  const host = location.hostname.toLowerCase();
  const isX = host.endsWith("x.com") || host.endsWith("twitter.com");
  if (!isX) return;

  // -----------------------------
  // Constants
  // -----------------------------
  const RISK_ENUM = ["誹謗中傷", "政治", "偏見", "差別", "詐欺", "成人向け", "なし"];


  const REASON_ENUM = ["攻撃的な言い回し", "個人への非難", "煽り/扇動", "属性の一般化", "差別的表現", "政治的煽動", "誤情報の可能性", "金銭/誘導", "詐欺の可能性", "性的示唆", "露骨な表現", "スパム/宣伝", "過度な断定", "低情報量", "画像のみ", "絵文字のみ"];

  const FALLBACK_TOPICS = [
    "社会","政治","経済","国際","テック","科学","教育","健康",
    "スポーツ","エンタメ","音楽","映画/アニメ","ゲーム","趣味",
    "創作","生活","旅行","歴史","ビジネス","その他"
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
    debug: true,
    logLevel: "info", // debug | info | warn | error
    aiMode: "auto", // auto | mock | off
    riskSoft: 60,
    riskHard: 75,
    batchSize: 3,
    idleMs: 650,
    maxTextChars: 200,

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
    const cur = await chrome.storage.local.get([
      "follone_enabled",
      "follone_aiMode",
      "follone_riskSoftThreshold",
      "follone_riskHardThreshold",
      "follone_batchSize",
      "follone_idleMs",
      "follone_topicWindow",
      "follone_bubbleDominance",
      "follone_bubbleEntropy",
      "follone_bubbleCooldownMs",
      "follone_bubbleMinSamples",
      "follone_bubbleUseLLM",
      "follone_reportMinSeconds",
      "follone_inactiveSuggestSeconds",
      "follone_inactiveCooldownMs",
      "follone_topics",
      "follone_debug",
      "follone_logLevel",
      "follone_cacheMax",
      "follone_skipMediaOnly",
      "follone_skipEmojiOnly"
    ]);

    if (cur.follone_enabled !== undefined) settings.enabled = !!cur.follone_enabled;
    if (cur.follone_aiMode !== undefined) settings.aiMode = String(cur.follone_aiMode || "auto");

    if (cur.follone_riskSoftThreshold !== undefined) settings.riskSoft = clampInt(cur.follone_riskSoftThreshold, 0, 100, 60);
    if (cur.follone_riskHardThreshold !== undefined) settings.riskHard = clampInt(cur.follone_riskHardThreshold, 0, 100, 75);
    if (cur.follone_batchSize !== undefined) settings.batchSize = clampInt(cur.follone_batchSize, 1, 8, 3);
    if (cur.follone_idleMs !== undefined) settings.idleMs = clampInt(cur.follone_idleMs, 100, 5000, 650);

    if (cur.follone_topicWindow !== undefined) settings.topicWindow = clampInt(cur.follone_topicWindow, 10, 200, 30);
    if (cur.follone_bubbleDominance !== undefined) settings.bubbleDominance = clampFloat(cur.follone_bubbleDominance, 0.3, 0.95, 0.62);
    if (cur.follone_bubbleEntropy !== undefined) settings.bubbleEntropy = clampFloat(cur.follone_bubbleEntropy, 0.1, 1.0, 0.55);
    if (cur.follone_bubbleCooldownMs !== undefined) settings.bubbleCooldownMs = clampInt(cur.follone_bubbleCooldownMs, 10_000, 3_600_000, 600_000);
    if (cur.follone_bubbleMinSamples !== undefined) settings.bubbleMinSamples = clampInt(cur.follone_bubbleMinSamples, 10, 100, 16);
    if (cur.follone_bubbleUseLLM !== undefined) settings.bubbleUseLLM = !!cur.follone_bubbleUseLLM;

    if (cur.follone_reportMinSeconds !== undefined) settings.reportMinSeconds = clampInt(cur.follone_reportMinSeconds, 10, 3600, 60);
    if (cur.follone_inactiveSuggestSeconds !== undefined) settings.inactiveSuggestSeconds = clampInt(cur.follone_inactiveSuggestSeconds, 30, 3600, 180);
    if (cur.follone_inactiveCooldownMs !== undefined) settings.inactiveCooldownMs = clampInt(cur.follone_inactiveCooldownMs, 10_000, 3_600_000, 600_000);

    if (cur.follone_debug !== undefined) settings.debug = !!cur.follone_debug;
    if (cur.follone_logLevel !== undefined) settings.logLevel = String(cur.follone_logLevel || "info");
    if (cur.follone_cacheMax !== undefined) settings.cacheMax = Math.max(100, Number(cur.follone_cacheMax || settings.cacheMax));
    if (cur.follone_skipMediaOnly !== undefined) settings.skipMediaOnly = !!cur.follone_skipMediaOnly;
    if (cur.follone_skipEmojiOnly !== undefined) settings.skipEmojiOnly = !!cur.follone_skipEmojiOnly;

    if (Array.isArray(cur.follone_topics) && cur.follone_topics.length) {
      settings.topics = cur.follone_topics.map(s => String(s).trim()).filter(Boolean).slice(0, 30);
      if (!settings.topics.length) settings.topics = FALLBACK_TOPICS.slice();
    }
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
    topicHistory: [],
    lastBubbleTs: 0,

    sessionStartMs: Date.now(),
    contextInvalidated: false,
    xp: 0,
    dashBias: 0,
    dashTop: null,
    dashQueries: [],
    riskCount: 0,
    topicCounts: new Map(),

    // v0.4.32: spotlight intervention runtime
    spotlightOpen: false,
    spotlightId: null,
    spotlightElem: null,
    spotlightRestore: null,
    spotlightLayoutTimer: 0
  };

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
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const obj = await storageGetSafe([RESULT_CACHE_KEY_V2, RESULT_CACHE_KEY_V1]);
      let saved = obj[RESULT_CACHE_KEY_V2];

      if (!saved || typeof saved !== "object") {
        const v1 = obj[RESULT_CACHE_KEY_V1];
        if (v1 && typeof v1 === "object") {
          log("info", "[CACHE]", "migrating v1 -> v2");
          saved = {
            version: 2,
            ids: { order: Array.isArray(v1.order) ? v1.order.slice() : [], map: v1.map || {} },
            hashes: { order: [], map: Object.create(null) },
            id2h: Object.create(null)
          };
        }
      }

      if (!saved || typeof saved !== "object") {
        log("info", "[CACHE]", "no saved cache");
        return;
      }

      // Normalize
      if (saved.version !== 2) {
        saved = ensurePersistentCache();
      } else {
        if (!saved.ids) saved.ids = { order: [], map: Object.create(null) };
        if (!saved.hashes) saved.hashes = { order: [], map: Object.create(null) };
        if (!saved.id2h) saved.id2h = Object.create(null);
      }

      state.persistentCache = saved;

      // ensure all expected buckets exist
      ensurePersistentCache();

      const idOrder = Array.isArray(saved.ids.order) ? saved.ids.order : [];
      const idMap = saved.ids.map || {};
      const hashOrder = Array.isArray(saved.hashes.order) ? saved.hashes.order : [];
      const hashMap = saved.hashes.map || {};

      let restored = 0;
      for (const id of idOrder.slice(-Number(settings.cacheMax || 800))) {
        const v = idMap[id];
        if (!v) continue;
        state.riskCache.set(id, v);
        restored += 1;
      }

      let restoredH = 0;
      for (const h of hashOrder.slice(-Number(settings.cacheMaxHash || 500))) {
        const v = hashMap[h];
        if (!v) continue;
        state.hashCache.set(h, v);
        restoredH += 1;
      }

      // Restore id->hash mapping into runtime map
      const id2h = saved.id2h || {};
      for (const [id, h] of Object.entries(id2h)) {
        if (h) state.hashById.set(id, h);
      }

      log("info", "[CACHE]", "restored", { ids: restored, hashes: restoredH });
    } catch (e) {
      log("warn", "[CACHE]", "load failed", String(e));
    }
  }

  function touchPersistentCache(id, value, textHash) {
    if (!id || !value) return;
    const pc = ensurePersistentCache();

    touchCacheBucket(pc.ids, id, value, Number(settings.cacheMax || 800));

    const h = String(textHash || "");
    if (h) {
      touchCacheBucket(pc.hashes, h, value, Number(settings.cacheMaxHash || 500));
      pc.id2h[id] = h;
      state.hashCache.set(h, value);
      state.hashById.set(id, h);
    }

    cacheDirty = true;
    schedulePersistCache();
  }

  function schedulePersistCache() {
    if (!cacheDirty) return;
    if (cachePersistTimer) return;
    cachePersistTimer = setTimeout(async () => {
      cachePersistTimer = 0;
      if (!cacheDirty) return;
      cacheDirty = false;
      try {
        const pc = ensurePersistentCache();
        if (!pc) return;
        await storageSetSafe({ [RESULT_CACHE_KEY_V2]: pc });
        log("debug", "[CACHE]", "persisted", { ids: (pc?.ids?.order?.length||0), hashes: (pc?.hashes?.order?.length||0) });
      } catch (e) {
        if (!isContextInvalidated(e)) log("warn", "[CACHE]", "persist failed", String(e));
      }
    }, Math.max(250, settings.cachePersistMs || 700));
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

function addXp(amount) {
    sendMessageSafe({ type: "FOLLONE_ADD_XP", amount: Number(amount) || 0 }).then((res) => {
      if (res && res.ok) {
        state.xp = Number(res.xp || state.xp || 0);
        renderWidget();
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
    window.open(url, "_blank", "noopener,noreferrer");
  
  // ---------------------------------
  // "Opposite" (good-content) search suggestions
  // ---------------------------------
  const OPPOSITE_POOLS = {
    "誹謗中傷": ["やさしい言葉 例", "癒し 音楽", "猫 かわいい", "良いニュース", "心が落ち着く 呼吸法"],
    "政治": ["科学 ニュース", "宇宙 写真", "歴史 文化", "絶景 旅行", "学び まとめ"],
    "偏見": ["多様性 学び", "文化 交流", "インクルーシブデザイン", "人権 教育", "やさしい解説"],
    "差別": ["共生 取り組み", "多様性 学び", "文化 交流", "優しさ エピソード", "インクルーシブデザイン"],
    "詐欺": ["情報リテラシー", "フィッシング 見分け方", "セキュリティ 基礎", "安心できる買い物 コツ", "生活の豆知識"],
    "成人向け": ["アート 写真", "映画 レビュー", "料理 レシピ", "散歩 風景", "猫 かわいい"],
    "なし": ["猫 かわいい", "良いニュース", "音楽 おすすめ", "科学 ニュース", "絶景 旅行"]
  };

  function pickOppositeQueries(riskCategory, n=3) {
    const cat = String(riskCategory || "なし");
    const pool = OPPOSITE_POOLS[cat] || OPPOSITE_POOLS["なし"];
    // deterministic-ish shuffle
    const seed = Date.now() % 997;
    const arr = pool.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (seed + i * 17) % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, Math.max(1, Math.min(5, n)));
  }

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

    // Popover placement: prefer right, otherwise left, otherwise bottom.
    const margin = 12;
    const preferRight = (vw - holeR) > 420;
    const preferLeft = holeL > 420;
    let popLeft = margin;
    let popTop = Math.max(margin, holeT);
    if (preferRight) {
      popLeft = Math.min(vw - margin - pop.offsetWidth, holeR + margin);
      popTop = Math.min(vh - margin - pop.offsetHeight, Math.max(margin, holeT));
    } else if (preferLeft) {
      popLeft = Math.max(margin, holeL - margin - pop.offsetWidth);
      popTop = Math.min(vh - margin - pop.offsetHeight, Math.max(margin, holeT));
    } else {
      popLeft = Math.min(vw - margin - pop.offsetWidth, Math.max(margin, holeL));
      popTop = Math.min(vh - margin - pop.offsetHeight, holeB + margin);
    }
    pop.style.left = `${Math.max(margin, popLeft)}px`;
    pop.style.top = `${Math.max(margin, popTop)}px`;
  }

  function closeSpotlight(reason) {
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
        sp.onclick = null;
      }
    } catch (_) {}

    // Unlock scroll
    try { lockScroll(false); } catch (_) {}

    state.spotlightRestore = null;
    state.spotlightOpen = false;
    state.spotlightId = null;
    state.spotlightElem = null;
  }

  function openSpotlight(opts) {
    const { elem, id, severity, badgeText, subText, html, muted, searches, cat, score } = opts || {};
    const sp = document.getElementById("follone-spotlight");
    const pop = document.getElementById("follone-sp-pop");
    if (!sp || !pop || !elem) {
      return false;
    }

    // Close any existing spotlight
    try { closeSpotlight("reopen"); } catch (_) {}

    state.spotlightOpen = true;
    state.spotlightId = String(id || "");
    state.spotlightElem = elem;

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
    sp.classList.add("show");

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
    const btnCont = document.getElementById("follone-sp-continue");
    if (btnBack) btnBack.onclick = () => {
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
      const list = Array.isArray(searches) ? searches : [];
      const q = list[0] || "良いニュース";
      try { openXSearch(q); } catch (_) {}
      closeSpotlight("search");
      try { addXp(xpForIntervention(severity) + 2); } catch (_) {}
    };
    if (btnCont) btnCont.onclick = () => {
      closeSpotlight("continue");
      try { addXp(1); } catch (_) {}
    };

    // Layout now + after next frame (popover dimensions stabilize)
    try { layoutSpotlight(elem); } catch (_) {}
    try { requestAnimationFrame(() => { if (state.spotlightOpen) layoutSpotlight(elem); }); } catch (_) {}
    try { setTimeout(() => { if (state.spotlightOpen) layoutSpotlight(elem); }, 120); } catch (_) {}


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
    const el = document.getElementById("follone-loader");
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

    el.classList.add("show");
    lockScroll(true, document.querySelector("main") || document.querySelector("[role='main']") || document.body.firstElementChild);
    setLoaderBrand(loader.kind === "boot" ? "Follone" : "Now analyzing");
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
    setTimeout(() => {
      el.classList.remove("show");
      lockScroll(false);
    }, 260);
  }

  function resetLoaderGates() {
    loader.gateToken = loader.pageToken;
    loader.gateDeadlineTs = 0;

    loader.anyReady = new Promise(res => { loader._resolveAny = res; });
    loader.promptReady = new Promise(res => { loader._resolvePrompt = res; });
    loader.backendReady = new Promise(res => { loader._resolveBackend = res; });
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

  async function runLoaderGate(kind, metaLeft, opts) {
    const o = Object.assign({ minMs: 5000, maxExtraMs: 9000, preferPrompt: true }, (opts || {}));
    bumpPageToken();
    resetLoaderGates();

    showLoader(kind, metaLeft);

    const token = loader.pageToken;
    const start = Date.now();
    loader.gateDeadlineTs = start + o.minMs + o.maxExtraMs;

    // Kick warmup early to hide cold-start latency behind loader.
    if (settings.enabled && settings.aiMode === "auto") {
      ensureBackend(true).then(ok => {
        if (ok) signalBackendReady({ ok: true });
      }).catch(() => {});
    }

    // Head start: discover + analyze immediately
    scheduleDiscovery(0);
    scheduleAnalyze(0);

    // Minimum time: always wait o.minMs
    await new Promise(r => setTimeout(r, o.minMs));
    if (loader.pageToken != token) return; // navigated away

    // After minMs: wait for first prompt result (preferred) or any result, but never block forever.
    const remaining = Math.max(0, loader.gateDeadlineTs - Date.now());
    const timeout = new Promise(res => setTimeout(() => res({ timeout: true }), remaining));

    let winner;
    if (o.preferPrompt) {
      winner = await Promise.race([loader.promptReady, loader.anyReady, timeout]);
    } else {
      winner = await Promise.race([loader.anyReady, timeout]);
    }

    if (loader.pageToken != token) return;
    hideLoader();
    scheduleHighlightFlush(0);
    log("info","[LOADER]","gate release", { kind, winner, waitedMs: Date.now() - start });
  }

/* v0.4.15: loader is time-based (no markFirstAnalysisDone) */


  function bumpPageToken() {
    loader.pageToken += 1;
    log("info", "[NAV]", "pageToken", loader.pageToken, location.pathname);
  }

  function installNavHooks() {
    const emit = () => window.dispatchEvent(new Event("follone:navigate"));
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function(...args){ const r = origPush.apply(this, args); emit(); return r; };
    history.replaceState = function(...args){ const r = origReplace.apply(this, args); emit(); return r; };
    window.addEventListener("popstate", emit);

    window.addEventListener("follone:navigate", () => {
      // New page context
      state.intervenedIds = new Set();

      // Time-based loader + small extra wait to hide cold-start. (Do not over-block on navigation.)
      runLoaderGate("nav", `mode:${settings.aiMode}`, { minMs: 5000, maxExtraMs: 1500, preferPrompt: false });
    });
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
      <div class="panel">
        <div class="header">
          <div class="avatar"></div>
          <div>
            <div class="title">follone</div>
            <div class="sub" id="follone-sub">起動待ち</div>
          </div>
        </div>
        <div class="body" id="follone-body">
          こんにちは、ふぉろねだよ～。君と一緒に、タイムライン見ちゃお～。
          <div class="row">
            <button id="follone-start">AI開始</button>
            <button id="follone-toggle">ON/OFF</button>
          </div>
          <div class="row">
            <button id="follone-options">設定</button>
            <button id="follone-diagnose">診断</button>
          </div>
          
          <div class="exp" id="follone-exp">
            <div class="expRow">
              <div id="follone-exp-label">EXP Lv 1</div>
              <div id="follone-exp-next">0/10</div>
            </div>
            <div class="expBarWrap"><div class="expBar" id="follone-exp-bar"></div></div>
          </div>

          <div class="dash" id="follone-dash">
            <div class="dashTitle">視野ダッシュボード</div>
            <div class="dashRow"><span>偏り度</span><span id="follone-bubble-score">--</span></div>
            <div class="dashBarWrap"><div class="dashBar" id="follone-bubble-bar"></div></div>
            <div class="dashSmall" id="follone-bubble-top">top: --</div>
            <div class="dashSmall" id="follone-bubble-suggest">おすすめ: --</div>
            <div class="row"><button id="follone-bubble-search">検索で広げる</button></div>
          </div>

          <div class="muted" id="follone-meta"></div>

        </div>
      </div>
    `;
    document.documentElement.appendChild(w);

    const ov = document.createElement("div");
    ov.id = "follone-overlay";
    ov.innerHTML = `
      <div class="card">
        <div class="cardHeader">
          <div class="avatar"></div>
          <div>
            <div class="title">follone</div>
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
            <div class="avatar"></div>
            <div>
              <div class="title">follone</div>
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


    w.querySelector("#follone-start").addEventListener("click", async () => {
      await ensureBackend(true);
      renderWidget();
      scheduleAnalyze(0);
    });

    w.querySelector("#follone-toggle").addEventListener("click", async () => {
      settings.enabled = !settings.enabled;
      await chrome.storage.local.set({ follone_enabled: settings.enabled });
      renderWidget();
    });

    w.querySelector("#follone-options").addEventListener("click", () => openOptions());

    w.querySelector("#follone-diagnose").addEventListener("click", async () => {
      const meta = document.getElementById("follone-meta");
      const parts = [];
      parts.push(`aiMode:${settings.aiMode}`);
      parts.push(`LanguageModel:${typeof LanguageModel}`);
      if (typeof LanguageModel !== "undefined") {
        try {
          const a = await LanguageModel.availability(LM_OPTIONS);
          parts.push(`availability:${a}`);
        } catch (e) {
          parts.push(`availability error:${String(e)}`);
        }
      }
      parts.push(`userActivation:${navigator.userActivation?.isActive ? "active" : "inactive"}`);

      try {
        const b = await sendMessageSafe({ type: "FOLLONE_BACKEND_STATUS" });
        if (b && b.ok) {
          parts.push(`offscreen:${String(b.availability || "-")}/${String(b.status || "-")}`);
        } else {
          parts.push(`offscreen:na`);
        }
      } catch (e) {
        if (isContextInvalidated(e)) onContextInvalidated(e);
        parts.push(`offscreen:err`);
      }

      parts.push(`backend:${state.sessionStatus}`);
      if (meta) meta.textContent = parts.join(" / ");
    });

    // Dashboard action: widen perspective via X search
    w.querySelector("#follone-bubble-search")?.addEventListener("click", () => {
      const qs = state.dashQueries && state.dashQueries.length ? state.dashQueries : ["猫 かわいい"];
      openXSearch(qs[0]);
      addXp(1);
    });


    renderWidget();
  }

  function setSub(text) {
    const el = document.getElementById("follone-sub");
    if (el) el.textContent = text;
  }

  function renderWidget() {
    const meta = document.getElementById("follone-meta");
    const enabled = settings.enabled ? "ON" : "OFF";
    const sec = Math.floor((Date.now() - state.sessionStartMs) / 1000);

    let backendLabel = state.sessionStatus;
    if (state.sessionStatus === "ready") backendLabel = "PromptAPI";
    if (state.sessionStatus === "mock") backendLabel = "Mock";
    if (state.sessionStatus === "off") backendLabel = "OFF";
    if (state.sessionStatus === "unavailable") backendLabel = "利用不可";
    if (state.sessionStatus === "downloadable") backendLabel = "DL待ち";
    if (state.sessionStatus === "downloading") backendLabel = "DL中";

    let sub = `${enabled} / AI:${backendLabel} / mode:${settings.aiMode}`;
    setSub(sub);

    if (meta) {
      meta.textContent = `可視tweetのみ / batch:${settings.batchSize} / idle:${settings.idleMs}ms / session:${sec}s`;
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

    // Dashboard (filter-bubble)
    const scoreEl = document.getElementById("follone-bubble-score");
    const barEl = document.getElementById("follone-bubble-bar");
    const topEl = document.getElementById("follone-bubble-top");
    const sugEl = document.getElementById("follone-bubble-suggest");

    const biasPct = Number(state.dashBias || 0);
    const top = state.dashTop || "—";
    const qs = Array.isArray(state.dashQueries) ? state.dashQueries : [];
    if (scoreEl) scoreEl.textContent = `${biasPct}%`;
    if (barEl) barEl.style.width = `${Math.max(0, Math.min(100, biasPct))}%`;
    if (topEl) topEl.textContent = `top: ${top}`;
    if (sugEl) sugEl.textContent = `おすすめ: ${qs.length ? qs.map(q => `「${q}」`).join("、") : "—"}`;
  }

  // -----------------------------
  // Backend selection
  // -----------------------------
  async function ensureBackend(userInitiated) {
    log("debug","[BACKEND]","ensureBackend", { userInitiated, aiMode: settings.aiMode, status: state.sessionStatus });

    if (settings.aiMode === "off") {
      state.sessionStatus = "off";
      return false;
    }

    if (settings.aiMode === "mock") {
      state.sessionStatus = "mock";
      return true;
    }

    // If user explicitly asked to start AI, warm up the backend session.
    if (userInitiated) {
      try {
        const w = await sendMessageSafe({ type: "FOLLONE_BACKEND_WARMUP" });
        if (w && w.ok) {
          state.sessionStatus = "ready";
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



    // auto: Ask SW/offscreen backend (extension origin) for status.
    try {
      const resp = await sendMessageSafe({ type: "FOLLONE_BACKEND_STATUS" });
      if (resp && resp.ok) {
        // Map backend states into UI states
        const a = String(resp.availability || "");
        const s = String(resp.status || "");
        if (a === "available" && (s === "ready" || resp.hasSession)) {
          state.sessionStatus = "ready";
          log("info","[BACKEND]","sw/offscreen ready", resp);
          signalBackendReady(resp);
          return true;
        }
        if (a === "downloadable" || a === "downloading" || s === "downloadable" || s === "downloading") {
          state.sessionStatus = a || s;
          log("warn","[BACKEND]","model not ready (needs warmup)", resp);
          // In this state, we keep mock fallback; options page provides a safe click to download.
          return true;
        }
        if (a === "unavailable" || s === "unavailable") {
          state.sessionStatus = "unavailable";
          log("warn","[BACKEND]","Prompt API unavailable", resp);
          return true;
        }
      } else if (resp) {
        log("warn","[BACKEND]","backend status not ok", resp);
      }

    } catch (e) {
      log("warn","[BACKEND]","backend status failed", String(e));
    }

    // Fallback
    state.sessionStatus = "mock";
    return true;
  }

  
  function truncateText(s, maxChars) {
    const t = String(s || "");
    const n = Math.max(0, Number(maxChars || 0));
    if (!n || t.length <= n) return t;
    return t.slice(0, n) + "…";
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

    text = truncateText(text, settings.maxTextChars);

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
    return {
      id: String(id || ""),
      riskScore: 0,
      riskCategory: "なし",
      topicCategory: "その他",
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

  async function classifyBatch(batch, priority) {
    if (settings.aiMode === "off") return [];

    // Try offscreen Prompt API backend first (extension origin).
    if (settings.aiMode === "auto") {
      try {
        const t0 = performance.now();
        log("debug", "[AI]", "send->sw", { backend: "offscreen", n: batch.length, priority: priority || "low", chars: batch.reduce((acc, p) => acc + String(p?.text || "").length, 0) });
        const resp = await sendMessageSafe({
          type: "FOLLONE_CLASSIFY_BATCH",
          batch,
          topicList: settings.topics,
          priority: priority || "low"
        });
        const dt = Math.round(performance.now() - t0);
        if (!resp) {
          throw new Error("Extension context invalidated");
        }
        if (resp && resp.ok && Array.isArray(resp.results)) {
          state.sessionStatus = "ready";
          log("info", "[AI]", "recv", { backend: resp.backend || "offscreen", engine: resp.engine || "prompt_api", status: resp.status, availability: resp.availability, latencyMs: resp.latencyMs || dt, n: resp.results.length });

          state.lastLatencyMs = Number(resp.latencyMs || dt);
          state.lastEngine = resp.engine || "prompt_api";
          signalAnyResult({ engine: state.lastEngine, latencyMs: state.lastLatencyMs });
          if ((resp.engine || "prompt_api") === "prompt_api") signalPromptResult({ latencyMs: state.lastLatencyMs });
          return resp.results;
        } else if (resp) {
          log("warn","[AI]","backend not ok -> mock", { status: resp.status, availability: resp.availability, engine: resp.engine, error: resp.error });
        }

        // If backend reports not-ready/unavailable, keep sessionStatus for UX, then fall back to mock.
        if (resp && resp.status) {
          state.sessionStatus = String(resp.status);
        }
      } catch (e) {
        log("warn","[CLASSIFY]","SW classify failed -> mock", String(e));
      }
    }

    // mock (no cost, always available)
    signalAnyResult({ engine: "mock" });
    return classifyBatchMock(batch);
  }

  // -----------------------------
  // Bubble detection
  // -----------------------------
  function normalizedEntropy(counts, total) {
    const n = counts.length;
    if (total <= 0 || n <= 1) return 0;
    let h = 0;
    for (const c of counts) {
      const p = c / total;
      if (p > 0) h += -p * Math.log(p);
    }
    const hMax = Math.log(n);
    return hMax > 0 ? (h / hMax) : 0;
  }

  function updateTopicStats(topic) {
    state.topicHistory.push(topic);
    if (state.topicHistory.length > settings.topicWindow) state.topicHistory.shift();
    state.topicCounts.set(topic, (state.topicCounts.get(topic) || 0) + 1);
  }

  function pickUnderrepresentedTopics(n) {
    const list = settings.topics.length ? settings.topics : FALLBACK_TOPICS;
    const seen = new Map();
    for (const t of state.topicHistory) seen.set(t, (seen.get(t) || 0) + 1);
    const scored = list.map(t => ({ t, c: seen.get(t) || 0 })).sort((a,b) => a.c - b.c);
    return scored.slice(0, n).map(x => x.t);
  }

  async function maybeShowFilterBubble() {
    const now = Date.now();
    if (now - state.lastBubbleTs < settings.bubbleCooldownMs) return;

    const hist = state.topicHistory;
    if (hist.length < settings.bubbleMinSamples) return;

    // Count distribution
    const countsMap = new Map();
    for (const c of hist) countsMap.set(c, (countsMap.get(c) || 0) + 1);

    let topCat = null;
    let topN = 0;
    const counts = [];
    let total = 0;
    for (const [k, v] of countsMap.entries()) {
      total += v;
      counts.push(v);
      if (v > topN) { topN = v; topCat = k; }
    }

    const h = normalizedEntropy(counts, total);
    const bias = Math.max(0, Math.min(1, 1 - h)); // 0=多様, 1=偏り強
    const biasPct = Math.round(bias * 100);

    // Pick queries that are "underrepresented" to widen the view
    const qs = pickUnderrepresentedTopics(3);
    if (!qs.length) qs.push("別の視点");

    state.lastBubbleTs = now;
    state.dashBias = biasPct;
    state.dashTop = topCat || "その他";
    state.dashQueries = qs;

    // Always-visible dashboard: just refresh UI
    renderWidget();
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

  function showBubbleCard(topCat, dominance, ent, suggestions) {
    const body = document.getElementById("follone-body");
    if (!body) return;

    const old = body.querySelector("[data-follone-bubble='1']");
    if (old) old.remove();

    const box = document.createElement("div");
    box.setAttribute("data-follone-bubble", "1");
    box.style.marginTop = "12px";
    box.style.padding = "10px 12px";
    box.style.borderRadius = "12px";
    box.style.background = "rgba(255,255,255,0.08)";

    const sug = suggestions.slice(0, 3);
    box.innerHTML = `
      <div style="font-weight:900;">…最近「${escapeHtml(topCat)}」が濃いかも。</div>
      <div style="opacity:0.9; margin-top:6px;">
        偏りは悪じゃないけど、精度を上げるなら別ジャンルを少し混ぜとこ。
        （dominance:${dominance.toFixed(2)} / entropy:${ent.toFixed(2)}）
      </div>
      <div class="row" style="margin-top:10px;">
        <button data-q="${escapeHtml(sug[0] || "別の視点")}">${escapeHtml(sug[0] || "別の視点")}</button>
        <button data-q="${escapeHtml(sug[1] || "検証")}">${escapeHtml(sug[1] || "検証")}</button>
        <button data-q="${escapeHtml(sug[2] || "関連")}">${escapeHtml(sug[2] || "関連")}</button>
      </div>
    `;

    box.querySelectorAll("button[data-q]").forEach(btn => {
      btn.addEventListener("click", () => {
        addXp(4);
        openXSearch(btn.getAttribute("data-q") || "別の視点");
      });
    });

    body.appendChild(box);
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

    const explain = (() => {
      switch (cat) {
        case "誹謗中傷": return "言葉が強くなりやすい流れかも。落ち着いて距離感を保とう。";
        case "政治": return "政治系は熱が上がりやすい。一次情報と複数視点を混ぜてね。";
        case "偏見": return "決めつけ/一般化が混ざりやすい。例外や文脈も見て判断しよう。";
        case "差別": return "属性を理由にした断定や排除に注意。相手を人として扱える距離で。";
        case "詐欺": return "誘導や金銭が絡む可能性。リンクやDM、個人情報は慎重に。";
        case "成人向け": return "年齢により不適切な表現が含まれる可能性。必要なら回避しよう。";
        default: return "刺激が強い/偏りやすい要素があるかも。無理せず切り替えてね。";
      }
    })();

    const html = `
      <div style="font-weight:900; margin-bottom:8px;">…ちょい待って。ここ、気になる匂いがする。</div>
      <div style="margin-bottom:10px;">${escapeHtml(explain)}</div>
      <div style="opacity:0.95; padding:10px 12px; border-radius:12px; background:rgba(255,255,255,0.08);">
        <div style="font-weight:900;">${escapeHtml(reasonLine)}</div>
      </div>
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
  function enqueueForAnalysis(post, priority) {
    ensureRuntimeMaps();
    if (!post || !post.id) return;

    // If we already have a result, no need to analyze.
    if (state.riskCache.has(post.id)) return;

    // Reverse filter (low-risk skip)
    const norm = normalizeForHash(post.text || "");
    const textHash = norm ? fnv1a32(norm) : "";
    if (textHash) setIdHash(post.id, textHash);

    // Hash cache fast path (id-independent reuse)
    if (textHash && !state.riskCache.has(post.id)) {
      const cached = state.hashCache.get(textHash);
      if (cached) {
        const res = { ...cached, id: post.id };
        state.riskCache.set(post.id, res);
        state.elemById.set(post.id, post.elem);
        try { post.elem.dataset.folloneId = post.id; } catch (_) {}
        touchPersistentCache(post.id, shrinkResultForCache(res), textHash);
        log("debug", "[CACHE]", "hit(hash)", { id: post.id, h: textHash });
        return;
      }
    }

    const sk = shouldSkipAnalysis(post);
    if (sk.skip) {
      const res = makeSkipResult(post.id, sk.reason);
      state.riskCache.set(post.id, res);
      touchPersistentCache(post.id, shrinkResultForCache(res), textHash);
      state.elemById.set(post.id, post.elem);
      try { post.elem.dataset.folloneId = post.id; } catch (_) {}
      log("debug", "[SKIP]", sk.reason, { id: post.id });
      return;
    }

    // Priority upgrade path: if already queued as low, allow bump to high.
    const pr = (priority === "high") ? "high" : "low";
    if (state.sentForAnalysis.has(post.id)) {
      const cur = state.pendingPriority.get(post.id) || "low";
      if (pr === "high" && cur !== "high") {
        state.pendingPriority.set(post.id, "high");

        // seq-based dedupe: newer copy wins
        const seq = ++state.enqSeq;
        state.seqById.set(post.id, seq);
        const bumped = { ...post, seq };

        state.analyzeHigh.unshift(bumped); // front-load
        log("debug", "[QUEUE]", "upgrade->high", { id: post.id, seq });
        scheduleAnalyze(0);
      }
      return;
    }

    state.sentForAnalysis.add(post.id);

    const seq = ++state.enqSeq;
    state.seqById.set(post.id, seq);
    post.seq = seq;
    state.pendingPriority.set(post.id, pr);
    state.canceledIds.delete(post.id);
    state.elemById.set(post.id, post.elem);
    try { post.elem.dataset.folloneId = post.id; } catch (_) {}

    if (pr === "high") state.analyzeHigh.push(post);
    else state.analyzeLow.push(post);

    log("debug", "[QUEUE]", "enqueueForAnalysis", { id: post.id, pr, high: state.analyzeHigh.length, low: state.analyzeLow.length });
  }



  function choosePriorityBatch(maxN) {
    const batch = [];
    while (batch.length < maxN && state.analyzeHigh.length) {
      const p = state.analyzeHigh.shift();
      if (!p) continue;
      const current = state.seqById.get(p.id);
      if (current && p.seq && p.seq !== current) continue;
      batch.push(p);
    }
    while (batch.length < maxN && state.analyzeLow.length) {
      const p = state.analyzeLow.shift();
      if (!p) continue;
      const current = state.seqById.get(p.id);
      if (current && p.seq && p.seq !== current) continue;
      batch.push(p);
    }
    const priority = batch.some(p => isNearViewport(p.elem)) ? "high" : (state.analyzeHigh.length ? "high" : "low");
    return { batch, priority };
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

    const backlog = state.analyzeHigh.length + state.analyzeLow.length;
    if (!backlog) return;

    // Dynamic batch sizing
    // - High priorityは小さめのバッチで「最初の結果」を早く返す（体感速度を上げる）
    // - 低優先のみのときはスループット重視で大きめ
    const slow = Number(state.lastLatencyMs || 0) > 6500;
    const hasHigh = state.analyzeHigh.length > 0;
    const maxN = hasHigh ? (slow ? 1 : Math.min(2, settings.batchSize))
      : Math.min(8, Math.max(settings.batchSize, backlog > 30 ? settings.batchSize + 2 : settings.batchSize));
    const { batch, priority } = choosePriorityBatch(maxN);
    if (!batch.length) return;

    state.inFlight = true;
    try {
      log("info", "[CLASSIFY]", "batch", batch.map(x => x.id), { priority, maxN, backlog });
      const results = await classifyBatch(batch, priority);
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

        // Update topic stats
        const topic = String(r.topicCategory || "その他");
        updateTopicStats(topic);

        // If this element is currently fully visible, apply decorations now
                // Try applying now; if the post isn't visible enough yet, we'll catch it later via highlight flush.
        elem.classList.remove("follone-analyzing");
        maybeApplyResultToElement(elem, r, { from: "analyzePump" });

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

    function getViewportCoverageRatio(elem) {
    try {
      const r = elem.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const vw = window.innerWidth || document.documentElement.clientWidth;

      const visibleH = Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
      const visibleW = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
      const visArea = visibleH * visibleW;

      // 正規化：要素がビューポートより大きい場合でも「最大で見える面積」に対して比率を取る
      // （r.width*r.height で割ると “絶対に1にならない” 死状態が起き得るため）
      const effW = Math.max(1, Math.min(vw, Math.max(0, r.width)));
      const effH = Math.max(1, Math.min(vh, Math.max(0, r.height)));
      const effArea = effW * effH;

      const ratio = effArea ? (visArea / effArea) : 0;
      return Math.max(0, Math.min(1, ratio));
    } catch (_) {
      return 0;
    }
  }

  function isFullyVisible(elem) {
    // “ほぼ全部見えている” を正規化して判定（背の高い投稿でも死なない）
    return getViewportCoverageRatio(elem) >= 0.98;
  }

  function isVisibleEnough(elem, minRatio) {
    const min = typeof minRatio === "number" ? minRatio : 0.45;
    return getViewportCoverageRatio(elem) >= min;
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
      if (!isVisibleEnough(elem, 0.45)) continue;

      // Try applying again (now idle)
      applyInterventionIfNeeded(elem, res, it?.ctx || { from: "flush" });
      if (state.intervenedIds?.has?.(id)) state.pendingInterventions.delete(id);
    }

    // 2) Safety net: scan currently visible posts and apply highlights if needed
    try {
      const articles = findTweetArticles();
      for (const a of articles) {
        if (!isVisibleEnough(a, 0.45)) continue;
        const id = a.dataset.folloneId;
        if (!id) continue;
        const res = state.riskCache.get(id);
        if (!res) continue;
        applyInterventionIfNeeded(a, res, { from: "scanVisible" });
      }
    } catch (_e) {}
  }

  function applyInterventionIfNeeded(elem, res, ctx) {
    const score = Number(res?.riskScore || 0);
    const cat = String(res?.riskCategory || "なし");
    const sev = severityFor(score);

    if (isSafeCategory(cat) || sev === "none") return;
    if (!isVisibleEnough(elem, 0.45)) return;


    if (state.intervenedIds.has(res.id)) return;
    state.intervenedIds.add(res.id);

    elem.classList.add("follone-danger");
    state.riskCount += 1;
    log("warn", "[INTERVENE]", "show", { id: res.id, cat, score, backend: state.sessionStatus, from: ctx?.from || "unknown" });
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
    if (!isVisibleEnough(elem, 0.45)) return;


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
        // Avoid heavy work / intervention until the post is reasonably in view (stabilizes spotlight position).
        if (!isVisibleEnough(article, 0.45)) continue;


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
    }, { root: null, threshold: 0.01 });


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
    const onScroll = () => {
      state.lastScrollTs = Date.now();
      state.lastUserActivityTs = Date.now();
      scheduleHighlightFlush(280);
    };
    const onUserActivity = () => {
      state.lastUserActivityTs = Date.now();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
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

      const pr = isNearViewport(article) ? "high" : "low";
      enqueueForAnalysis(post, pr);
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
    await loadResultCache();
    log("info","[SETTINGS]","loaded", { enabled: settings.enabled, aiMode: settings.aiMode, debug: settings.debug, logLevel: settings.logLevel, batchSize: settings.batchSize, idleMs: settings.idleMs });
    mountUI();
    await loadXp();
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
    runLoaderGate("boot", `mode:${settings.aiMode}`, { minMs: 5000, maxExtraMs: 9000, preferPrompt: true });

    startObservers();

    // Initial backend status (no auto-download)
    if (settings.aiMode === "off") {
      state.sessionStatus = "off";
    } else if (settings.aiMode === "mock") {
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
  })();

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
