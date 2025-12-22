// follone content script (X / Twitter)
// v0.4.35-a — Widget simplification + spotlight alignment + full navigation hooks
'use strict';

(() => {
  // -----------------------------
  // Constants / Config
  // -----------------------------
  const VERSION = '0.4.35-a';
  const APP_NAME = 'follone';

  const RISK_ENUM = ['ok','light','medium','high','critical','violent','sexual','hate','scam'];

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    debug: true,
    logLevel: 'info', // 'debug' | 'info' | 'warn' | 'error'
    aiMode: 'auto',   // 'auto' | 'mock' | 'off'
    enableSpotlight: true,

    // Risk thresholds (0..1)
    minRiskToIntervene: 0.65,
    minRiskToPromptSearch: 0.55,

    // Batching
    batchSize: 5,
    idleMs: 20000,

    // Content
    maxTextChars: 140
  });

  const STORAGE_KEYS = Object.freeze({
    enabled: 'follone_enabled',
    debug: 'follone_debug',
    logLevel: 'follone_logLevel',
    aiMode: 'follone_aiMode',
    enableSpotlight: 'follone_enableSpotlight',

    minRiskToIntervene: 'follone_minRiskToIntervene',
    minRiskToPromptSearch: 'follone_minRiskToPromptSearch',

    batchSize: 'follone_batchSize',
    idleMs: 'follone_idleMs',
    maxTextChars: 'follone_maxTextChars'
  });

  // Opposite-suggestion pools (search prompts)
  const OPPOSITE_POOLS = Object.freeze({
    politics: [
      '反対意見 政策 根拠', '与野党 論点 整理', '一次資料 公式発表 検証', '制度設計 トレードオフ 解説'
    ],
    economy: [
      '賛否 両論 インフレ 影響', '統計 データ ソース', '因果関係 相関 間違い', '長期的 影響 反証'
    ],
    tech: [
      'セキュリティ リスク 反論', 'デメリット 事例', '専門家 解説 賛否', 'プロコン 比較'
    ],
    society: [
      '現場 体験談 反対側', '当事者 複数視点', '研究 論文 反証', '歴史的経緯 解説'
    ],
    general: [
      '反対意見 根拠', '一次資料 ソース', '専門家 解説', 'デメリット 事例'
    ]
  });

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    settings: { ...DEFAULT_SETTINGS },
    startedAt: Date.now(),

    // backend status
    sessionStatus: 'unknown', // ready | downloadable | downloading | unavailable | not_ready | mock | off | unknown
    lastBackendCheck: 0,

    // caches
    riskCache: new Map(),         // textKey -> {riskScore, riskCategory, topicCategory, reasons, ts}
    pendingKeys: new Set(),       // keys being processed
    seenTweetIds: new Set(),      // avoid repeated attach

    // queue
    queue: [],
    processing: false,

    // topic stats
    topicCounts: new Map(),
    totalClassified: 0,
    bubbleScore: 0,

    // xp
    xp: 0,
    level: 1,

    // spotlight
    spotlightActive: false,
    spotlightTarget: null,
    scrollLock: null,
    prevWidgetDisplay: null,

    // ui elements
    ui: {
      widget: null,
      statusChip: null,
      toggleBtn: null,
      optionsBtn: null,
      expBar: null,
      expNext: null,
      expLabel: null,
      bubbleBar: null,
      bubbleScore: null,
      hint: null,
      spotlight: null,
      veilTop: null,
      veilBottom: null,
      veilLeft: null,
      veilRight: null,
      pop: null,
      popTitle: null,
      popBody: null,
      popButtons: null,
      popClose: null,
      loader: null,
      loaderFill: null,
      loaderText: null
    }
  };

  // -----------------------------
  // Logging
  // -----------------------------
  const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

  function logLevelVal() {
    return LOG_LEVELS[state.settings.logLevel] ?? 20;
  }

  function log(level, ...args) {
    if (!state.settings.debug) return;
    const v = LOG_LEVELS[level] ?? 20;
    if (v < logLevelVal()) return;
    // eslint-disable-next-line no-console
    console[level](`[${APP_NAME}]`, ...args);
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function safeText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function textKeyFor(tweetText) {
    // short stable key to reduce storage pressure
    const s = safeText(tweetText).slice(0, 512);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `t_${(h >>> 0).toString(16)}_${s.length}`;
  }

  function getVisualViewport() {
    const vv = window.visualViewport;
    if (!vv) return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    return { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height };
  }

  // -----------------------------
  // Storage / Settings
  // -----------------------------
  async function loadSettings() {
    try {
      const keys = Object.values(STORAGE_KEYS);
      const data = await chrome.storage.local.get(keys);

      const s = { ...DEFAULT_SETTINGS };

      if (typeof data[STORAGE_KEYS.enabled] === 'boolean') s.enabled = data[STORAGE_KEYS.enabled];
      if (typeof data[STORAGE_KEYS.debug] === 'boolean') s.debug = data[STORAGE_KEYS.debug];
      if (typeof data[STORAGE_KEYS.logLevel] === 'string') s.logLevel = data[STORAGE_KEYS.logLevel];
      if (typeof data[STORAGE_KEYS.aiMode] === 'string') s.aiMode = data[STORAGE_KEYS.aiMode];
      if (typeof data[STORAGE_KEYS.enableSpotlight] === 'boolean') s.enableSpotlight = data[STORAGE_KEYS.enableSpotlight];

      if (typeof data[STORAGE_KEYS.minRiskToIntervene] === 'number') s.minRiskToIntervene = clamp(data[STORAGE_KEYS.minRiskToIntervene], 0, 1);
      if (typeof data[STORAGE_KEYS.minRiskToPromptSearch] === 'number') s.minRiskToPromptSearch = clamp(data[STORAGE_KEYS.minRiskToPromptSearch], 0, 1);

      if (typeof data[STORAGE_KEYS.batchSize] === 'number') s.batchSize = clamp(Math.round(data[STORAGE_KEYS.batchSize]), 1, 10);
      if (typeof data[STORAGE_KEYS.idleMs] === 'number') s.idleMs = clamp(Math.round(data[STORAGE_KEYS.idleMs]), 2000, 600000);

      if (typeof data[STORAGE_KEYS.maxTextChars] === 'number') s.maxTextChars = clamp(Math.round(data[STORAGE_KEYS.maxTextChars]), 40, 400);

      state.settings = s;
      log('info', 'settings loaded', s);
    } catch (e) {
      log('warn', 'settings load failed', e);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = Object.values(STORAGE_KEYS).some(k => k in changes);
    if (relevant) {
      loadSettings().then(() => {
        updateWidget();
      });
    }
  });

  // -----------------------------
  // Messaging
  // -----------------------------
  function sendMessageSafe(message, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) return resolve({ ok: false, error: String(err) });
          resolve(resp || { ok: false, error: 'no_response' });
        });
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  // -----------------------------
  // Backend
  // -----------------------------
  async function ensureBackend(userInitiated = false) {
    const s = state.settings;

    if (s.aiMode === 'off') {
      state.sessionStatus = 'off';
      updateWidget();
      return true;
    }
    if (s.aiMode === 'mock') {
      state.sessionStatus = 'mock';
      updateWidget();
      return true;
    }

    // auto: status check (throttle)
    const nowTs = Date.now();
    if (!userInitiated && (nowTs - state.lastBackendCheck) < 2000) {
      return state.sessionStatus === 'ready';
    }
    state.lastBackendCheck = nowTs;

    const st = await sendMessageSafe({ type: 'FOLLONE_BACKEND_STATUS' }, 8000);
    if (!st || !st.ok) {
      state.sessionStatus = state.sessionStatus === 'ready' ? 'ready' : 'not_ready';
      updateWidget();
      return state.sessionStatus === 'ready';
    }

    // Normalize
    const avail = st.availability || st.status || 'unknown';
    if (avail === 'available' && st.hasSession) state.sessionStatus = 'ready';
    else if (avail === 'available') state.sessionStatus = 'not_ready';
    else if (avail === 'downloadable') state.sessionStatus = 'downloadable';
    else if (avail === 'downloading') state.sessionStatus = 'downloading';
    else if (avail === 'unavailable') state.sessionStatus = 'unavailable';
    else state.sessionStatus = 'unknown';

    updateWidget();

    if (userInitiated && (state.sessionStatus === 'not_ready' || state.sessionStatus === 'downloadable' || state.sessionStatus === 'downloading')) {
      const warm = await sendMessageSafe({ type: 'FOLLONE_BACKEND_WARMUP' }, 25000);
      if (warm && warm.ok) {
        state.sessionStatus = warm.status === 'ready' ? 'ready' : (warm.availability || warm.status || state.sessionStatus);
      }
      updateWidget();
    }

    return state.sessionStatus === 'ready';
  }

  // On first user gesture: try to warm up Prompt API to avoid falling back to mock.
  function installUserGestureWarmup() {
    let fired = false;
    const onGesture = () => {
      if (fired) return;
      fired = true;
      ensureBackend(true).catch(() => {});
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }

  // -----------------------------
  // UI Injection: CSS + Widget + Spotlight + Loader
  // -----------------------------
  function injectCss() {
    try {
      const href = chrome.runtime.getURL('overlay.css');
      if (document.querySelector(`link[href="${href}"]`)) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.documentElement.appendChild(link);
    } catch (e) {
      log('warn', 'css inject failed', e);
    }
  }

  function mountWidget() {
    if (state.ui.widget) return;

    const root = document.createElement('div');
    root.id = 'follone-widget';
    root.innerHTML = `
      <div class="follone-panel">
        <div class="follone-top">
          <div class="follone-brand">
            <span class="follone-dot"></span>
            <span class="follone-name">follone</span>
            <span class="follone-chip" id="follone-chip">--</span>
          </div>
          <div class="follone-actions">
            <button class="follone-btn ghost" id="follone-toggle">ON</button>
            <button class="follone-btn solid" id="follone-options">設定</button>
          </div>
        </div>

        <div class="follone-bars">
          <div class="follone-row">
            <span class="lbl" id="follone-exp-label">Lv 1</span>
            <span class="val" id="follone-exp-next">0/10</span>
          </div>
          <div class="follone-barwrap">
            <div class="follone-barfill" id="follone-exp-bar"></div>
          </div>

          <div class="follone-row">
            <span class="lbl">偏り</span>
            <span class="val" id="follone-bubble-score">--</span>
          </div>
          <div class="follone-barwrap thin">
            <div class="follone-barfill alt" id="follone-bubble-bar"></div>
          </div>
        </div>

        <div class="follone-hint" id="follone-hint">初期化中…</div>
      </div>
    `;
    document.documentElement.appendChild(root);

    // refs
    state.ui.widget = root;
    state.ui.statusChip = root.querySelector('#follone-chip');
    state.ui.toggleBtn = root.querySelector('#follone-toggle');
    state.ui.optionsBtn = root.querySelector('#follone-options');
    state.ui.expBar = root.querySelector('#follone-exp-bar');
    state.ui.expNext = root.querySelector('#follone-exp-next');
    state.ui.expLabel = root.querySelector('#follone-exp-label');
    state.ui.bubbleBar = root.querySelector('#follone-bubble-bar');
    state.ui.bubbleScore = root.querySelector('#follone-bubble-score');
    state.ui.hint = root.querySelector('#follone-hint');

    // handlers
    state.ui.toggleBtn.addEventListener('click', async () => {
      const next = !state.settings.enabled;
      await chrome.storage.local.set({ [STORAGE_KEYS.enabled]: next });
    });

    state.ui.optionsBtn.addEventListener('click', async () => {
      const res = await sendMessageSafe({ type: 'FOLLONE_OPEN_OPTIONS' }, 5000);
      if (!res || !res.ok) {
        const url = chrome.runtime.getURL('options.html');
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });

    updateWidget();
  }

  function mountLoader() {
    if (state.ui.loader) return;

    const root = document.createElement('div');
    root.id = 'follone-loader';
    root.className = 'follone-hidden';
    root.innerHTML = `
      <div class="follone-loader-card">
        <div class="follone-loader-title">follone</div>
        <div class="follone-loader-sub" id="follone-loader-text">準備中…</div>
        <div class="follone-loader-bar">
          <div class="follone-loader-fill" id="follone-loader-fill"></div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    state.ui.loader = root;
    state.ui.loaderFill = root.querySelector('#follone-loader-fill');
    state.ui.loaderText = root.querySelector('#follone-loader-text');
  }

  function showLoader(text = '準備中…') {
    mountLoader();
    state.ui.loader.classList.remove('follone-hidden');
    setLoaderText(text);
    setLoaderProgress(0);
  }

  function hideLoader() {
    if (!state.ui.loader) return;
    state.ui.loader.classList.add('follone-hidden');
  }

  function setLoaderProgress(pct) {
    if (!state.ui.loaderFill) return;
    const p = clamp(pct, 0, 100);
    state.ui.loaderFill.style.width = `${p}%`;
  }

  function setLoaderText(t) {
    if (!state.ui.loaderText) return;
    state.ui.loaderText.textContent = t;
  }

  function mountSpotlight() {
    if (state.ui.spotlight) return;

    const root = document.createElement('div');
    root.id = 'follone-spotlight';
    root.className = 'follone-hidden';
    root.innerHTML = `
      <div class="veil top" id="follone-veil-top"></div>
      <div class="veil left" id="follone-veil-left"></div>
      <div class="veil right" id="follone-veil-right"></div>
      <div class="veil bottom" id="follone-veil-bottom"></div>

      <div class="follone-pop" id="follone-pop">
        <div class="follone-pop-head">
          <div class="title" id="follone-pop-title">注意</div>
          <button class="close" id="follone-pop-close" aria-label="close">×</button>
        </div>
        <div class="follone-pop-body" id="follone-pop-body"></div>
        <div class="follone-pop-actions" id="follone-pop-actions"></div>
      </div>
    `;
    document.documentElement.appendChild(root);

    state.ui.spotlight = root;
    state.ui.veilTop = root.querySelector('#follone-veil-top');
    state.ui.veilBottom = root.querySelector('#follone-veil-bottom');
    state.ui.veilLeft = root.querySelector('#follone-veil-left');
    state.ui.veilRight = root.querySelector('#follone-veil-right');
    state.ui.pop = root.querySelector('#follone-pop');
    state.ui.popTitle = root.querySelector('#follone-pop-title');
    state.ui.popBody = root.querySelector('#follone-pop-body');
    state.ui.popButtons = root.querySelector('#follone-pop-actions');
    state.ui.popClose = root.querySelector('#follone-pop-close');

    const close = () => closeSpotlight();
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });
    state.ui.popClose.addEventListener('click', close);

    // Escape closes
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.spotlightActive) closeSpotlight();
    }, true);

    // Re-layout on viewport changes
    window.addEventListener('resize', () => { if (state.spotlightActive) layoutSpotlight(); }, { passive: true });
    window.visualViewport?.addEventListener('resize', () => { if (state.spotlightActive) layoutSpotlight(); }, { passive: true });
    window.visualViewport?.addEventListener('scroll', () => { if (state.spotlightActive) layoutSpotlight(); }, { passive: true });
  }

  function updateWidget() {
    if (!state.ui.widget) return;

    // Toggle
    state.ui.toggleBtn.textContent = state.settings.enabled ? 'ON' : 'OFF';
    state.ui.toggleBtn.classList.toggle('off', !state.settings.enabled);

    // Status chip
    const st = state.sessionStatus;
    const label =
      (state.settings.aiMode === 'off') ? 'OFF' :
      (state.settings.aiMode === 'mock') ? 'MOCK' :
      (st === 'ready') ? 'PromptAPI' :
      (st === 'downloadable') ? 'DL可' :
      (st === 'downloading') ? 'DL中' :
      (st === 'unavailable') ? '不可' :
      (st === 'not_ready') ? '準備中' :
      '--';
    state.ui.statusChip.textContent = label;

    // XP and level
    const xp = state.xp || 0;
    const lvl = computeLevel(xp);
    state.level = lvl.level;

    state.ui.expLabel.textContent = `Lv ${lvl.level}`;
    state.ui.expNext.textContent = `${lvl.cur}/${lvl.next}`;

    const pct = (lvl.next > 0) ? (lvl.cur / lvl.next) * 100 : 0;
    state.ui.expBar.style.width = `${clamp(pct, 0, 100)}%`;

    // Bubble score (0..100)
    state.ui.bubbleScore.textContent = `${Math.round(state.bubbleScore)}%`;
    state.ui.bubbleBar.style.width = `${clamp(state.bubbleScore, 0, 100)}%`;

    // Hint
    if (!state.settings.enabled) {
      state.ui.hint.textContent = '停止中';
    } else if (state.settings.aiMode === 'mock') {
      state.ui.hint.textContent = 'Mock判定（精度低）';
    } else if (state.settings.aiMode === 'off') {
      state.ui.hint.textContent = 'AI判定OFF';
    } else if (state.sessionStatus !== 'ready') {
      state.ui.hint.textContent = 'AI準備中（操作すると起動します）';
    } else {
      state.ui.hint.textContent = '監視中';
    }
  }

  // -----------------------------
  // Level / XP
  // -----------------------------
  function computeLevel(xp) {
    // Simple curve: L1 0-9, L2 10-24, L3 25-44 ...
    let level = 1;
    let need = 10;
    let remaining = xp;

    while (remaining >= need) {
      remaining -= need;
      level += 1;
      need = Math.round(need * 1.6);
      if (level > 99) break;
    }
    return { level, cur: remaining, next: need };
  }

  async function loadXP() {
    const res = await sendMessageSafe({ type: 'FOLLONE_GET_XP' }, 5000);
    if (res && res.ok) {
      state.xp = Number(res.xp || 0);
      updateWidget();
    }
  }

  async function addXP(delta) {
    const res = await sendMessageSafe({ type: 'FOLLONE_ADD_XP', delta }, 5000);
    if (res && res.ok) {
      state.xp = Number(res.xp || 0);
      updateWidget();
    }
  }

  // -----------------------------
  // Topic bias score
  // -----------------------------
  function updateTopicStats(topic) {
    if (!topic) return;
    const k = String(topic);
    state.topicCounts.set(k, (state.topicCounts.get(k) || 0) + 1);
    state.totalClassified += 1;

    // Bias score: 1 - normalized entropy
    const counts = Array.from(state.topicCounts.values());
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    let entropy = 0;
    for (const c of counts) {
      const p = c / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    const maxH = Math.log2(Math.max(1, counts.length));
    const normH = maxH > 0 ? (entropy / maxH) : 0;
    const bias = 1 - normH;
    state.bubbleScore = clamp(bias * 100, 0, 100);
  }

  function pickOppositeQueries(topic) {
    const pool = OPPOSITE_POOLS[topic] || OPPOSITE_POOLS.general;
    // pick 3 unique-ish
    const out = [];
    const used = new Set();
    for (let i = 0; i < pool.length && out.length < 3; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      const q = pool[idx];
      if (!used.has(q)) {
        used.add(q);
        out.push(q);
      }
    }
    return out.length ? out : pool.slice(0, 3);
  }

  function openXSearch(query) {
    const q = encodeURIComponent(query);
    const url = `https://x.com/search?q=${q}&src=typed_query&f=live`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // -----------------------------
  // Tweet extraction
  // -----------------------------
  function findTweetArticles(root = document) {
    let nodes = Array.from(root.querySelectorAll('article[data-testid="tweet"]'));
    if (!nodes.length) {
      nodes = Array.from(root.querySelectorAll('article[role="article"]'));
    }
    return nodes;
  }

  function extractTweetText(article) {
    if (!article) return '';
    const parts = [];
    const textNodes = article.querySelectorAll('div[data-testid="tweetText"]');
    textNodes.forEach((n) => parts.push(n.innerText || n.textContent || ''));
    let txt = safeText(parts.join('\n'));
    if (!txt) {
      // fallback: aria-label content
      txt = safeText(article.innerText || article.textContent || '');
    }
    return txt.slice(0, state.settings.maxTextChars);
  }

  function extractTweetId(article) {
    if (!article) return null;
    // try permalink
    const a = article.querySelector('a[href*="/status/"]');
    if (a && a.getAttribute('href')) return a.getAttribute('href');
    return null;
  }

  // -----------------------------
  // Observation + Queueing
  // -----------------------------
  const io = new IntersectionObserver((entries) => {
    for (const ent of entries) {
      if (!ent.isIntersecting) continue;
      const article = ent.target;
      queueArticle(article);
    }
  }, { root: null, threshold: 0.25 });

  function attachArticle(article) {
    if (!article || !(article instanceof HTMLElement)) return;
    const id = extractTweetId(article) || '';
    if (id && state.seenTweetIds.has(id)) return;
    if (id) state.seenTweetIds.add(id);

    if (article.dataset.folloneAttached) return;
    article.dataset.folloneAttached = '1';
    io.observe(article);
  }

  function attachAllTweets(root = document) {
    const arts = findTweetArticles(root);
    for (const a of arts) attachArticle(a);
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.('article[data-testid="tweet"], article[role="article"]')) attachArticle(node);
        attachAllTweets(node);
      }
    }
  });

  function startObservers() {
    attachAllTweets(document);
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function queueArticle(article) {
    if (!state.settings.enabled) return;
    const text = extractTweetText(article);
    if (!text) return;

    const key = textKeyFor(text);
    if (state.pendingKeys.has(key)) return;

    state.queue.push({ article, text, key, enqueuedAt: Date.now() });
    pumpQueue();
  }

  async function pumpQueue() {
    if (state.processing) return;
    state.processing = true;

    try {
      while (state.queue.length && state.settings.enabled) {
        // Batch
        const batch = [];
        while (batch.length < state.settings.batchSize && state.queue.length) {
          const item = state.queue.shift();
          if (!item) break;
          if (state.pendingKeys.has(item.key)) continue;
          state.pendingKeys.add(item.key);
          batch.push(item);
        }
        if (!batch.length) break;

        const results = await classifyBatch(batch);
        for (const r of results) {
          try { handleClassified(r); } catch (e) { log('warn', 'handleClassified error', e); }
        }

        // small yield
        await sleep(100);
      }
    } finally {
      state.processing = false;
    }
  }

  // -----------------------------
  // Classification
  // -----------------------------
  function buildTopicList() {
    // keep a small stable set; can be extended from history
    const base = ['politics','economy','society','tech','entertainment','sports','health','education','international','general'];
    const dyn = Array.from(state.topicCounts.keys()).slice(0, 25);
    const out = Array.from(new Set([...base, ...dyn]));
    return out.slice(0, 80);
  }

  function mockClassify(text) {
    const t = safeText(text).toLowerCase();
    let riskScore = 0.15;
    let riskCategory = 'ok';
    let topicCategory = 'general';

    if (/(scam|giveaway|airdrop|投資|儲かる|副業|口座|暗号資産|bitcoin|btc|eth)/i.test(t)) {
      riskScore = 0.78; riskCategory = 'scam'; topicCategory = 'economy';
    } else if (/(kill|murder|爆破|刺す|殺す|燃やす|暴力)/i.test(t)) {
      riskScore = 0.82; riskCategory = 'violent'; topicCategory = 'society';
    } else if (/(死ね|消えろ|ぶっ殺|ゴミ|害悪)/i.test(t)) {
      riskScore = 0.62; riskCategory = 'medium'; topicCategory = 'society';
    } else if (/(政治|選挙|与党|野党|首相|大統領|政策)/i.test(t)) {
      riskScore = 0.28; riskCategory = 'light'; topicCategory = 'politics';
    }

    return { riskScore, riskCategory, topicCategory, reasons: [] };
  }

  async function classifyBatch(batchItems) {
    // cache hit fast-path
    const out = [];
    const need = [];

    for (const item of batchItems) {
      const cached = state.riskCache.get(item.key);
      if (cached && (Date.now() - cached.ts) < 24 * 3600 * 1000) {
        out.push({ ...item, ...cached, fromCache: true });
      } else {
        need.push(item);
      }
    }
    if (!need.length) return out;

    // Try Prompt API first (auto)
    const canUse = await ensureBackend(false);

    let resp = null;
    if (state.settings.aiMode === 'auto' && canUse) {
      const topicList = buildTopicList();
      resp = await sendMessageSafe({
        type: 'FOLLONE_CLASSIFY_BATCH',
        batch: need.map((x) => ({ id: x.key, text: x.text })),
        topicList
      }, 25000);
    }

    if (!resp || !resp.ok || !Array.isArray(resp.results)) {
      // fallback to mock
      log('warn', 'Prompt classify failed; fallback to mock', resp?.error || resp?.status || resp);
      state.sessionStatus = (state.settings.aiMode === 'auto') ? (state.sessionStatus === 'ready' ? 'ready' : 'not_ready') : state.sessionStatus;
      updateWidget();

      for (const item of need) {
        const m = mockClassify(item.text);
        const rec = { ...m, ts: Date.now() };
        state.riskCache.set(item.key, rec);
        out.push({ ...item, ...rec, engine: 'mock', fromCache: false });
      }

      // clear pending
      for (const item of need) state.pendingKeys.delete(item.key);
      return out;
    }

    // Map by id (key)
    const map = new Map(resp.results.map((r) => [String(r.id), r]));
    for (const item of need) {
      const r = map.get(item.key) || {};
      const rec = {
        riskScore: clamp(Number(r.riskScore || 0), 0, 1),
        riskCategory: (RISK_ENUM.includes(r.riskCategory)) ? r.riskCategory : 'ok',
        topicCategory: String(r.topicCategory || 'general'),
        reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 3).map(String) : [],
        ts: Date.now()
      };
      state.riskCache.set(item.key, rec);
      out.push({ ...item, ...rec, engine: resp.engine || 'prompt_api', fromCache: false });
      state.pendingKeys.delete(item.key);
    }

    // status
    state.sessionStatus = 'ready';
    updateWidget();

    return out;
  }

  function handleClassified(item) {
    updateTopicStats(item.topicCategory);
    updateWidget();

    if (item.riskScore >= state.settings.minRiskToIntervene) {
      // intervene only if visible and spotlight enabled
      if (state.settings.enableSpotlight) {
        maybeIntervene(item.article, item);
      }
    }
  }

  // -----------------------------
  // Spotlight intervention
  // -----------------------------
  function isFullyVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const vv = getVisualViewport();
    return r.top >= vv.y + 4 && r.left >= vv.x + 4 && r.bottom <= (vv.y + vv.h - 4) && r.right <= (vv.x + vv.w - 4);
  }

  function findScrollContainer() {
    // Prefer main scroll container (X typically uses documentElement/body but may have nested)
    const candidates = [];
    const docEl = document.scrollingElement || document.documentElement;
    if (docEl) candidates.push(docEl);
    if (document.body) candidates.push(document.body);

    for (const el of candidates) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY)) return el;
    }

    // Fallback: the closest scrollable ancestor of the timeline
    const timeline = document.querySelector('main') || document.body;
    let cur = timeline;
    while (cur && cur !== document.documentElement) {
      const st = getComputedStyle(cur);
      if (/(auto|scroll)/.test(st.overflowY)) return cur;
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function lockScroll(targetEl) {
    const sc = findScrollContainer();
    const prev = {
      scrollEl: sc,
      scrollTop: sc.scrollTop,
      bodyOverflow: document.body.style.overflow,
      docOverflow: document.documentElement.style.overflow
    };

    // Freeze scroll
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    // Resist wheel/touch
    const onWheel = (e) => { e.preventDefault(); };
    const onTouch = (e) => { e.preventDefault(); };
    const onKey = (e) => {
      const keys = ['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '];
      if (keys.includes(e.key)) e.preventDefault();
    };

    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('touchmove', onTouch, { passive: false, capture: true });
    window.addEventListener('keydown', onKey, { passive: false, capture: true });

    // Keep element pinned (X can re-render)
    let raf = null;
    const tick = () => {
      try {
        sc.scrollTop = prev.scrollTop;
      } catch (_) {}
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    state.scrollLock = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('touchmove', onTouch, true);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev.bodyOverflow;
      document.documentElement.style.overflow = prev.docOverflow;
    };
  }

  function unlockScroll() {
    if (typeof state.scrollLock === 'function') {
      try { state.scrollLock(); } catch (_) {}
    }
    state.scrollLock = null;
  }

  function layoutSpotlight() {
    if (!state.spotlightActive || !state.spotlightTarget) return;
    const el = state.spotlightTarget;

    const r = el.getBoundingClientRect();
    const vv = getVisualViewport();

    // pad tuned for "ズレ" complaint; keep tight
    const pad = 6;

    // Convert to visual viewport space
    const holeL = clamp(r.left - pad, vv.x, vv.x + vv.w);
    const holeT = clamp(r.top - pad, vv.y, vv.y + vv.h);
    const holeR = clamp(r.right + pad, vv.x, vv.x + vv.w);
    const holeB = clamp(r.bottom + pad, vv.y, vv.y + vv.h);

    const w = holeR - holeL;
    const h = holeB - holeT;

    // Veils: position within the fixed spotlight root using visual viewport offsets
    const root = state.ui.spotlight;
    root.style.left = `${vv.x}px`;
    root.style.top = `${vv.y}px`;
    root.style.width = `${vv.w}px`;
    root.style.height = `${vv.h}px`;

    const relL = holeL - vv.x;
    const relT = holeT - vv.y;
    const relR = holeR - vv.x;
    const relB = holeB - vv.y;

    state.ui.veilTop.style.left = '0px';
    state.ui.veilTop.style.top = '0px';
    state.ui.veilTop.style.width = `${vv.w}px`;
    state.ui.veilTop.style.height = `${Math.max(0, relT)}px`;

    state.ui.veilBottom.style.left = '0px';
    state.ui.veilBottom.style.top = `${Math.max(0, relB)}px`;
    state.ui.veilBottom.style.width = `${vv.w}px`;
    state.ui.veilBottom.style.height = `${Math.max(0, vv.h - relB)}px`;

    state.ui.veilLeft.style.left = '0px';
    state.ui.veilLeft.style.top = `${Math.max(0, relT)}px`;
    state.ui.veilLeft.style.width = `${Math.max(0, relL)}px`;
    state.ui.veilLeft.style.height = `${Math.max(0, relB - relT)}px`;

    state.ui.veilRight.style.left = `${Math.max(0, relR)}px`;
    state.ui.veilRight.style.top = `${Math.max(0, relT)}px`;
    state.ui.veilRight.style.width = `${Math.max(0, vv.w - relR)}px`;
    state.ui.veilRight.style.height = `${Math.max(0, relB - relT)}px`;

    // Popover placement
    const pop = state.ui.pop;
    pop.style.maxWidth = `${Math.min(420, vv.w - 24)}px`;

    // show first to measure
    pop.style.visibility = 'hidden';
    pop.style.display = 'block';

    const pw = pop.offsetWidth || 320;
    const ph = pop.offsetHeight || 180;

    let px = relL;
    let py = relB + 10;

    if (py + ph > vv.h - 10) py = relT - ph - 10;
    py = clamp(py, 10, vv.h - ph - 10);

    if (px + pw > vv.w - 10) px = vv.w - pw - 10;
    px = clamp(px, 10, vv.w - pw - 10);

    pop.style.left = `${px}px`;
    pop.style.top = `${py}px`;
    pop.style.visibility = 'visible';
  }

  function openSpotlight(article, riskItem) {
    if (state.spotlightActive) return;
    if (!article) return;
    if (!isFullyVisible(article)) return;

    mountSpotlight();

    // Hide widget while spotlight is open (prevents "ごちゃごちゃ")
    if (state.ui.widget) {
      state.prevWidgetDisplay = state.ui.widget.style.display || '';
      state.ui.widget.style.display = 'none';
    }

    state.spotlightActive = true;
    state.spotlightTarget = article;

    // Fill UI
    state.ui.popTitle.textContent = '一度立ち止まって確認';
    const scorePct = Math.round(clamp(riskItem.riskScore, 0, 1) * 100);
    const topic = safeText(riskItem.topicCategory || 'general');
    state.ui.popBody.innerHTML = `
      <div class="follone-pop-meta">
        <span class="pill">${topic}</span>
        <span class="pill danger">risk ${scorePct}%</span>
      </div>
      <div class="follone-pop-text">
        反対側の視点や一次資料も確認して、情報の偏りを減らしましょう。
      </div>
    `;

    // Buttons
    state.ui.popButtons.innerHTML = '';
    const qs = pickOppositeQueries(topic);
    for (const q of qs) {
      const b = document.createElement('button');
      b.className = 'follone-pop-btn';
      b.textContent = q;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        openXSearch(q);
      });
      state.ui.popButtons.appendChild(b);
    }

    // show
    state.ui.spotlight.classList.remove('follone-hidden');

    // scroll lock
    lockScroll(article);

    // layout
    layoutSpotlight();
    log('info', 'spotlight open', { topic, scorePct });
  }

  function closeSpotlight() {
    if (!state.spotlightActive) return;
    state.spotlightActive = false;

    unlockScroll();

    if (state.ui.spotlight) state.ui.spotlight.classList.add('follone-hidden');
    state.spotlightTarget = null;

    // Restore widget
    if (state.ui.widget) {
      state.ui.widget.style.display = state.prevWidgetDisplay ?? '';
      state.prevWidgetDisplay = null;
    }
  }

  function maybeIntervene(article, item) {
    // Avoid repeated intervention on same element
    if (!article || article.dataset.folloneIntervened) return;

    // Only when visible (full) to avoid “ズレ” from partial
    if (!isFullyVisible(article)) return;

    // mark
    article.dataset.folloneIntervened = '1';

    // Open spotlight
    openSpotlight(article, item);

    // award xp for encounter
    addXP(1).catch(() => {});
  }

  // -----------------------------
  // Navigation hooks (X is SPA)
  // -----------------------------
  function installNavHooks() {
    // Dispatch custom event on URL change
    let lastHref = location.href;

    const emit = () => {
      const href = location.href;
      if (href === lastHref) return;
      lastHref = href;
      window.dispatchEvent(new CustomEvent('follone:navigate', { detail: { href } }));
    };

    const wrap = (fn) => function(...args) {
      const ret = fn.apply(this, args);
      queueMicrotask(emit);
      return ret;
    };

    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', emit);

    // initial
    setTimeout(emit, 50);

    window.addEventListener('follone:navigate', () => {
      // Clear lightweight transient state; keep cache
      state.queue.length = 0;
      state.pendingKeys.clear();
      // Re-attach tweets for new timeline
      attachAllTweets(document);
      // Show loader briefly to avoid early mock
      runLoaderGate().catch(() => {});
    });
  }

  // -----------------------------
  // Loader gate (spend time while Prompt warms)
  // -----------------------------
  async function runLoaderGate() {
    if (!state.settings.enabled) return;
    // Only during initial navigation windows
    showLoader('AI準備中…');
    const minMs = 5000;
    const t0 = Date.now();

    // Try warmup early to make Prompt API the default (best-effort)
    ensureBackend(true).catch(() => {});

    // Wait until ready or timeout; keep progress moving
    let pct = 0;
    while (Date.now() - t0 < minMs) {
      pct = clamp(((Date.now() - t0) / minMs) * 100, 0, 100);
      setLoaderProgress(pct);

      // Update text
      if (state.sessionStatus === 'ready') setLoaderText('完了');
      else if (state.sessionStatus === 'downloadable') setLoaderText('モデルDL可能');
      else if (state.sessionStatus === 'downloading') setLoaderText('モデルDL中…');
      else setLoaderText('AI準備中…');

      await sleep(120);
    }
    setLoaderProgress(100);
    await sleep(120);
    hideLoader();
  }

  // -----------------------------
  // Boot
  // -----------------------------
  async function boot() {
    try {
      injectCss();
      await loadSettings();
      mountWidget();
      mountLoader();
      mountSpotlight();
      installUserGestureWarmup();
      installNavHooks();
      startObservers();
      loadXP();

      // initial loader
      runLoaderGate().catch(() => {});
      ensureBackend(false).catch(() => {});
      updateWidget();

      log('info', 'booted', VERSION);
    } catch (e) {
      log('error', 'boot failed', e);
    }
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
