
// Phase11: Phase2 (Data -> Alive UI)
// - real bias from follone_biasAgg_v2
// - quest progress from follone_quest
// - number animations
(() => {
  'use strict';

  // -----------------------------
  // Small helpers
  // -----------------------------
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const $ = (sel, root=document) => root.querySelector(sel);
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v)||0));

  // -----------------------------
  // Character theme (UI accent)
  // -----------------------------
  const CHAR_THEME = {
    follone: {
      id: 'follone',
      label: 'FOLLONE',
      accent: '#9b87ff',
      accent2: '#c3b8ff',
      accentRGB: '155,135,255',
    },
    likoris: {
      id: 'likoris',
      label: 'LIKORIS',
      accent: '#FD6B98',
      accent2: '#ffd0df',
      accentRGB: '253,107,152',
    }
  };

  function applyCharacterTheme(characterId) {
    const theme = CHAR_THEME[characterId] || CHAR_THEME.follone;
    document.documentElement.dataset.char = theme.id;
    // Keep vars in sync (helps if CSS is cached / partial overrides)
    document.documentElement.style.setProperty('--accent', theme.accent);
    document.documentElement.style.setProperty('--accent2', theme.accent2);
    document.documentElement.style.setProperty('--accentRGB', theme.accentRGB);
  }

  function hasChrome() {
    return typeof chrome !== 'undefined' && chrome?.storage?.local;
  }

  function jstDayKey(ts = Date.now()) {
    // Use Asia/Tokyo day key (YYYY-MM-DD)
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
      });
      return fmt.format(new Date(ts));
    } catch (_) {
      const d = new Date(ts);
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const da = String(d.getDate()).padStart(2,'0');
      return `${y}-${m}-${da}`;
    }
  }

  function parseDayKey(key) {
    // key: YYYY-MM-DD
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key||''));
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
    // interpret as JST midnight to order correctly
    return Date.UTC(y, mo, d); // ordering only
  }

  // -----------------------------
  // XP table (must match sw.js)
  // -----------------------------
  const XP_LEVELS = [0, 10, 25, 45, 70, 100, 140, 190, 250, 320, 400, 500, 620, 760, 920, 1100];

  function xpToLevel(xp) {
    const x = Math.max(0, Number(xp)||0);
    let lv = 1;
    for (let i = 1; i < XP_LEVELS.length; i++) if (x >= XP_LEVELS[i]) lv = i+1;
    return lv;
  }
  function levelToNextXp(lv) {
    const idx = Math.max(1, Math.min(XP_LEVELS.length, Number(lv)||1)) - 1;
    const cur = XP_LEVELS[idx] ?? 0;
    const next = XP_LEVELS[idx+1] ?? (cur + 200);
    return { cur, next };
  }

  // -----------------------------
  // Bias agg (must match content.js key)
  // -----------------------------
  const BIAS_STORAGE_KEY = 'follone_biasAgg_v2';
  // CanSee: unified storage keys (keep stable across pages)
  const CANSEE_SELECTED_CHAR_KEY = 'cansee_selected_character_id';


  function entropyNorm(counts, nTotalTopics) {
    const vals = Object.values(counts||{}).map(v=>Number(v)||0).filter(v=>v>0);
    const total = vals.reduce((a,b)=>a+b,0);
    if (!total) return 0;
    let H = 0;
    for (const v of vals) {
      const p = v/total;
      H += -p * Math.log(p);
    }
    const n = Math.max(2, Number(nTotalTopics)||vals.length||2);
    return clamp01(H / Math.log(n));
  }

  function calcBiasMetrics(agg) {
    const counts = agg?.counts || {};
    const total = Number(agg?.total||0);
    const topics = Array.isArray(agg?.topics) ? agg.topics : [];
    const nTotalTopics = topics.length || 12;

    let top = 0, topKey = '';
    for (const [k,v] of Object.entries(counts)) {
      const n = Number(v)||0;
      if (n > top) { top = n; topKey = k; }
    }
    const focus = total ? clamp01(top/total) : 0;
    const variety = entropyNorm(counts, nTotalTopics);
    const eff = Object.values(counts).filter(v => (Number(v)||0) > 0).length;
    const explore = clamp01(eff / nTotalTopics);

    return { focus, variety, explore, total, topKey, top, eff, nTotalTopics };
  }

  function aggByPeriod(dayMap, period) {
    // dayMap: {"YYYY-MM-DD": {focus: n, variety: n, explore: n}}
    const out = { counts: { focus:0, variety:0, explore:0 }, total:0, range: { start:null, end:null, days:0 } };
    if (!dayMap || typeof dayMap !== 'object') return out;

    const keys = Object.keys(dayMap).sort(); // chronological
    const now = new Date();
    const todayKey = isoDate(now);

    const within = (dayKey) => {
      if (period === 'total') return true;
      const d = new Date(dayKey + 'T00:00:00');
      const diffDays = Math.floor((now - d) / 86400000);
      if (period === 'day') return diffDays <= 1;
      if (period === 'week') return diffDays <= 7;
      if (period === 'month') return diffDays <= 30;
      if (period === 'year') return diffDays <= 365;
      return true;
    };

    const included = [];
    for (const dayKey of keys) {
      if (!within(dayKey)) continue;
      included.push(dayKey);

      const c = dayMap[dayKey] || {};
      for (const [t,v] of Object.entries(c)) {
        out.counts[t] = Number(out.counts[t]||0) + Number(v||0);
      }
    }

    out.range.days = included.length;
    out.range.start = included[0] || null;
    out.range.end = included[included.length-1] || null;
    out.total = out.counts.focus + out.counts.variety + out.counts.explore;

    return out;
  }

  // -----------------------------
  // Canvas charts (ring-pie)
  // -----------------------------
  function drawRingPie(canvas, value01, labelTop, labelBottom) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0,0,W,H);

    const cx = W/2, cy = H/2;
    const r = Math.min(W,H)/2 - 12;
    const thick = Math.max(10, Math.floor(r * 0.22));

    // background ring
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = thick;
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();

    // value ring
    const v = clamp01(value01);
    const start = -Math.PI/2;
    const end = start + v * Math.PI * 2;

    // subtle glow
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = thick + 4;
    ctx.strokeStyle = '#9b87ff';
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = thick;
    ctx.strokeStyle = '#b8abff';
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.stroke();
    ctx.restore();

    // center text (minimal)
    ctx.save();
    ctx.fillStyle = 'rgba(240,240,255,0.92)';
    ctx.font = '700 22px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(v*100)}%`, cx, cy - 6);

    ctx.globalAlpha = 0.75;
    ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    if (labelTop) ctx.fillText(labelTop, cx, cy + 18);
    if (labelBottom) ctx.fillText(labelBottom, cx, cy + 34);
    ctx.restore();
  }

  function tween(from, to, ms, onUpdate, onDone) {
    const t0 = performance.now();
    const dur = Math.max(0, ms||0);
    const a = Number(from)||0;
    const b = Number(to)||0;

    function ease(x) { return 1 - Math.pow(1 - x, 3); } // cubic out

    function tick(now) {
      const p = dur ? clamp01((now - t0) / dur) : 1;
      const v = a + (b - a) * ease(p);
      onUpdate(v, p);
      if (p < 1) requestAnimationFrame(tick);
      else onDone && onDone();
    }
    requestAnimationFrame(tick);
  }

  function animateNumber(el, target, ms=350, fmt=(v)=>String(Math.round(v))) {
    if (!el) return;
    const cur = Number(el.dataset.cur || el.textContent || 0) || 0;
    const t = Number(target)||0;
    el.dataset.cur = String(cur);
    tween(cur, t, ms, (v) => {
      el.dataset.cur = String(v);
      el.textContent = fmt(v);
    });
  }

  // -----------------------------
  // DOM
  // -----------------------------
  const dom = {
    // master toggles
    mEnabled: $('#m-enabled'),
    mAnalyze: $('#m-analyze'),
    mIntervene: $('#m-intervene'),
    mDisplay: $('#m-display'),

    // views
    views: $$('.hb-view'),
    mainTitle: $('#mainTitle'),
    mainHint: $('#mainHint'),
    btnBack: $('#btnBack'),

    // nav
    rightTabs: $$('.hb-sideTabs .hb-tab'),
    rightCards: $$('.hb-sideCard[data-open]'),

    // progress
    kvLv: $('#kvLv'),
    kvXp: $('#kvXp'),
    kvNext: $('#kvNext'),
    kvTlType: $('#kvTlType'),
    kvXpRate: $('#kvXpRate'),

    // ai
    aiState: $('#aiState'),
    aiSession: $('#aiSession'),
    aiLatency: $('#aiLatency'),
    btnPrompt: $('#btnPrompt'),
    btnWarmup: $('#btnWarmup'),

    // next action
    nextText: $('#nextText'),

    // one-glance / mode / pause / help
    tagExt: $('#tagExt'),
    tagApi: $('#tagApi'),
    tagAnalyze: $('#tagAnalyze'),
    tagSpot: $('#tagSpot'),
    tagDisplay: $('#tagDisplay'),
    tagMode: $('#tagMode'),
    tagT: $('#tagT'),
    tagU: $('#tagU'),
    btnPauseSoft: $('#btnPauseSoft'),
    btnPauseMute: $('#btnPauseMute'),
    btnResumeAll: $('#btnResumeAll'),
    btnPresetBeginner: $('#btnPresetBeginner'),
    btnPresetStandard: $('#btnPresetStandard'),
    btnPresetStrict: $('#btnPresetStrict'),
    btnSchool: $('#btnSchool'),
    btnPersonal: $('#btnPersonal'),
    btnDiff: $('#btnDiff'),
    // Quick settings
    qsSafe: $('#qsSafe'),
    qsSoft: $('#qsSoft'),
    qsAuto: $('#qsAuto'),
    qsNotify: $('#qsNotify'),
    qsSpotL: $('#qsSpotL'),
    qsSpotN: $('#qsSpotN'),
    qsSpotH: $('#qsSpotH'),
    btnFollone: $('#btnFollone'),
    btnLikoris: $('#btnLikoris'),
    helpBlocks: $$('.hb-help'),
    helpBtns: $$('.hb-q'),

    // bubble
    bubble: $('#bubble'),
    bubbleName: $('#bubbleName'),
    bubbleText: $('#bubbleText'),


    // command/chat
    cmdBar: $('#cmdBar'),
    cmdInput: $('#cmdInput'),
    cmdSend: $('#cmdSend'),
    cmdLog: $('#cmdLog'),

    // bias
    cFocus: $('#cFocus'),
    cVar: $('#cVar'),
    cExp: $('#cExp'),
      periodNote: $('#periodNote'),
    tFocus: $('#tFocus'),
    tVar: $('#tVar'),
    tExp: $('#tExp'),
    periodBtns: $$('.hb-seg__btn[data-period]'),

    // quest
    qDaily: $('#qDaily'),
    qWeekly: $('#qWeekly'),
    selHead: $('#selHead'),
    selFx: $('#selFx'),
        unlockText: $('#unlockText'),

    // rpg (Phase3)
    bpTrack: $('#bpTrack'),
    unlockNextLabel: $('#unlockNextLabel'),
    rpgLv: $('#rpgLv'),
    rpgXp: $('#rpgXp'),
    rpgNext: $('#rpgNext'),
    btnClaimDemo: $('#btnClaimDemo'),
    btnEquipDemo: $('#btnEquipDemo'),
  };


  // ===== Tooltips (hover / focus) =====
  const tipEl = document.getElementById('hbTooltip');
  let tipTarget = null;
  let tipRaf = 0;

  // Many controls are <input> + <label>. Users usually hover the label,
  // but data-tip was set on the input, so the tooltip didn't trigger.
  // Copy tips from inputs to their corresponding labels.
  try {
    document.querySelectorAll('input[data-tip][id]').forEach((inp) => {
      const id = inp.id;
      const text = (inp.getAttribute('data-tip') || '').trim();
      if (!id || !text) return;
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (!label) return;
      if (!label.getAttribute('data-tip')) label.setAttribute('data-tip', text);
    });
  } catch (e) {
    // ignore
  }

  function showTip(target, text, x, y){
    if (!tipEl) return;
    tipEl.textContent = text;
    tipEl.setAttribute('aria-hidden','false');
    tipEl.classList.add('is-show');

    // position
    const pad = 14;
    const rect = tipEl.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    const maxLeft = window.innerWidth - rect.width - 8;
    const maxTop = window.innerHeight - rect.height - 8;
    if (left > maxLeft) left = Math.max(8, x - rect.width - pad);
    if (top > maxTop) top = Math.max(8, y - rect.height - pad);
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }
  function hideTip(){
    if (!tipEl) return;
    tipEl.setAttribute('aria-hidden','true');
    tipEl.classList.remove('is-show');
    tipTarget = null;
  }

  function getTipText(el){
    if (!el) return '';
    return (el.getAttribute('data-tip') || el.getAttribute('title') || '').trim();
  }

  // use capture to catch nested elements; walk up to find data-tip
  const tipSelector = '[data-tip],[title]';
  document.addEventListener('mouseover', (ev)=>{
    const el = ev.target && ev.target.closest ? ev.target.closest(tipSelector) : null;
    if (!el) return;
    const text = getTipText(el);
    if (!text) return;
    tipTarget = el;
    showTip(el, text, ev.clientX, ev.clientY);
  }, true);

  document.addEventListener('mousemove', (ev)=>{
    if (!tipTarget) return;
    if (tipRaf) cancelAnimationFrame(tipRaf);
    tipRaf = requestAnimationFrame(()=>{
      const text = getTipText(tipTarget);
      if (!text) return hideTip();
      showTip(tipTarget, text, ev.clientX, ev.clientY);
    });
  }, true);

  document.addEventListener('mouseout', (ev)=>{
    if (!tipTarget) return;
    const rel = ev.relatedTarget;
    if (rel && tipTarget.contains(rel)) return;
    hideTip();
  }, true);

  document.addEventListener('focusin', (ev)=>{
    const el = ev.target && ev.target.closest ? ev.target.closest(tipSelector) : null;
    if (!el) return;
    const text = getTipText(el);
    if (!text) return;
    const r = el.getBoundingClientRect();
    tipTarget = el;
    showTip(el, text, r.left + r.width/2, r.top);
  }, true);
  document.addEventListener('focusout', hideTip, true);

  
  // -----------------------------
  // Tooltip normalization (Step2)
  // -----------------------------
  function normalizeTooltips() {
    // 1) If the real hover target is a wrapper/label, copy tip from child input/button
    $$('.hb-chip').forEach((lab) => {
      const src = lab.querySelector('input[data-tip],button[data-tip],select[data-tip]');
      if (src && !lab.dataset.tip) lab.dataset.tip = src.dataset.tip;
      if (!lab.getAttribute('title') && src && src.getAttribute('title')) lab.setAttribute('title', src.getAttribute('title'));
    });

    // 2) Catalog: ensure all major controls have a short JP explanation
    const catalog = [
      ['.hb-tab[data-open="home"]', 'HOME（拠点）に戻る'],
      ['.hb-tab[data-open="bias"]', '偏りダッシュボード（3軸）を開く'],
      ['.hb-tab[data-open="quest"]', 'Daily/Weeklyクエストを開く'],
      ['.hb-tab[data-open="log"]', '理由ログ（Spotlight/偏り/EXP）を開く'],
      ['.hb-tab[data-open="settings"]', '基本設定を開く'],
      ['.hb-tab[data-open="rpg"]', '成長・解放（RPG）を開く'],
      ['#btnBack', '1つ前の画面に戻る'],
      ['#btnPrompt', 'Prompt API を準備（利用可能なら1クリック）'],
      ['#btnWarmup', '初回ウォームアップ（最初のClassifyまで）'],
      ['#btnPauseAll', '解析・介入を一時停止（拡張自体はOFFにしない）'],
      ['#btnResumeAll', '一時停止を解除して再開'],
      ['#btnMute', '発表用：表示だけ静かに（UIは残す）'],
      ['#cmdInput', 'コマンド/短文チャット入力。例: /help  /developer  /export'],
      ['#cmdSend', '入力を送信'],
      ['#m-enabled', '拡張機能の稼働（全体ON/OFF）'],
      ['#m-analyze', '解析のON/OFF（危険判定を回す）'],
      ['#m-intervene', '介入のON/OFF（Spotlight・通知など）'],
      ['#m-display', '表示のON/OFF（Overlay表示など）'],
    ];

    for (const [sel, tip] of catalog) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (!el.dataset.tip) el.dataset.tip = tip;
      if (!el.getAttribute('title')) el.setAttribute('title', tip);
    }

    // 3) Segment buttons: use their meaning as fallback
    $$('.hb-btn, .hb-seg__btn, .hb-tab, button').forEach((btn) => {
      if (btn.dataset.tip || btn.getAttribute('title')) return;
      const t = (btn.textContent || '').trim();
      if (!t) return;
      // Avoid noisy tooltips for purely decorative tiny buttons
      if (t.length <= 24) btn.setAttribute('title', t);
    });
  }

// -----------------------------
  // App state (UI + latest data)
  // -----------------------------
  const app = {
    view: 'home',
    lastLevel: null,
    period: 'week',
    data: {
      xp: 0,
      level: 1,
      quest: null,
      biasAgg: null,
      characterId: 'follone',
      equippedHead: '',
      backend: { state: 'unavailable', session: '--', latency: '--' },
      master: { enabled: true, analyze: true, intervene: true, display: true },
    },
    chartLast: { focus: 0, variety: 0, explore: 0 }
  };

  // timestamps for "school run" sanity checks
  const startedAt = Date.now();
  let lastConfigAt = Date.now();

  // UI mode: school/personal (default school=false)
  let schoolMode = false;

  // -----------------------------
  // Storage read / write
  // -----------------------------
  async function readAll() {
    // Minimal keys for Phase2
    const keys = [
      'follone_xp',
      'follone_level',
      'follone_quest',
      // CanSee: primary shared keys
      CANSEE_SELECTED_CHAR_KEY,
      // characterId はOverlay側とキー名がズレても復旧できるように複数読む
      'follone_characterId',
      'characterId',
      'selectedCharacterId',
      'pet_characterId',
      'retroPet_characterId',
      'likoris_characterId',
      'follone_equippedHead',
      // quick settings
      'follone_safeFilterEnabled',
      'follone_softWarningEnabled',
      'follone_autoScanEnabled',
      'follone_notifyEnabled',
      'follone_spotlightStrength',
      BIAS_STORAGE_KEY,
      'follone_backend_availability',
      'follone_backend_session',
      'follone_backend_latencyAvg',
      'follone_backend_lastError',
      'follone_lightLog_v1',
      // master toggles (they may be named differently in your build; we fall back safely)
      'follone_enabled',
      'follone_master_analyze',
      'follone_master_intervene',
      'follone_master_display',

      // UI helper
      'follone_ui_schoolMode',
      'follone_defaults_snapshot'
    ];

    if (!hasChrome()) {
      // mock
      return {
        follone_xp: 451,
        follone_level: 11,
        // mock
        follone_characterId: 'follone',
        characterId: 'follone',
        follone_equippedHead: 'bandage',
        [BIAS_STORAGE_KEY]: null,
        follone_quest: null
      };
    }

    const obj = await chrome.storage.local.get(keys);
    return obj || {};
  }

  function pickCharacterId(obj) {
    // Priority:
    // 1) CanSee primary key (shared across Options/Overlay)
    // 2) legacy keys (older builds / migrations)
    const raw =
      (obj && obj[CANSEE_SELECTED_CHAR_KEY]) ||
      (obj && (
        obj.follone_characterId ||
        obj.characterId ||
        obj.selectedCharacterId ||
        obj.pet_characterId ||
        obj.retroPet_characterId ||
        obj.likoris_characterId
      )) ||
      'follone';

    const id = String(raw).trim().toLowerCase();
    return CHAR_THEME[id] ? id : 'follone';
  }

  async function writeOne(key, value) {
    if (!hasChrome()) return;
    await chrome.storage.local.set({ [key]: value });
  }

  async function setCharacterId(nextId, { silent=false } = {}) {
    const id = String(nextId || '').trim().toLowerCase();
    if (!CHAR_THEME[id]) return;
    if (app.data.characterId === id) return;

    app.data.characterId = id;
    applyCharacterTheme(id);

    // Persist (primary + legacy)
    if (hasChrome()) {
      await chrome.storage.local.set({
        [CANSEE_SELECTED_CHAR_KEY]: id,
        follone_characterId: id,
        characterId: id,
        selectedCharacterId: id,
        pet_characterId: id,
        retroPet_characterId: id,
      });
    }

    // Keep Options UI and PetEngine in sync
    if (!silent) {
      renderAll();
      window.dispatchEvent(new CustomEvent('hb:petReload', { detail: { reason: 'character' } }));
    }
  }

  // -----------------------------
  // Rendering
  // -----------------------------
  function setView(view) {
    if (!view) view = 'home';
    const prevView = app.view;
    if (prevView === view) return;
    app.view = view;

    // Smooth view transition: fade/slide between panels.
    const prevEl = dom.views.find(v => v.dataset.view === prevView) || null;
    const nextEl = dom.views.find(v => v.dataset.view === view) || null;

    if (prevEl) {
      prevEl.classList.remove('is-active');
      prevEl.classList.add('is-leaving');
      prevEl.style.display = 'block';
    }

    dom.views.forEach(v => {
      // keep only prev + next visible during animation
      if (v === prevEl || v === nextEl) return;
      v.classList.remove('is-active', 'is-leaving');
      v.style.display = 'none';
    });

    if (nextEl) {
      nextEl.classList.remove('is-leaving');
      nextEl.classList.remove('is-active');
      nextEl.style.display = 'block';
      // force reflow so transition triggers
      void nextEl.offsetWidth;
      nextEl.classList.add('is-active');
    }

    if (prevEl) {
      window.setTimeout(() => {
        // if user switched again, don't stomp the new view
        if (app.view !== view) return;
        prevEl.classList.remove('is-leaving');
        prevEl.style.display = 'none';
      }, 240);
    }

    if (dom.btnBack) dom.btnBack.classList.toggle('is-on', view !== 'home');

    const titleMap = { home: 'HOME', bias: 'BIAS', quest: 'QUEST', log: 'LOG', settings: 'SETTINGS', rpg: 'RPG', dev: 'DEV' };
    if (dom.mainTitle) dom.mainTitle.textContent = titleMap[view] || String(view || 'HOME');

    // Hint text per view
    const hintMap = {
      dev: '開発/運用用。隠しコマンド developer / exit で切替。',
      home: '右のカードを押すと、左のメインモニターが切り替わる。',
      bias: '偏りダッシュボード（期間切替可）。',
      quest: 'Daily / Weekly の進捗。',
      log: 'Spotlightの理由 / 偏りの原因候補 / EXP減衰理由。',
      settings: '基本設定（学校運用向け）。',
      rpg: '成長・解放要素（準備中）。'
    };
    if (dom.mainHint) dom.mainHint.textContent = hintMap[view] || '';
    if (view === 'dev') { const t = document.querySelector('.hb-tab--dev'); if (t) t.hidden = false; }
    if (view === 'dev') renderDev();
    if (view === 'log') renderLog();
  }

  function setTag(el, text, state) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('is-ok', 'is-warn', 'is-off');
    if (state === 'ok') el.classList.add('is-ok');
    if (state === 'warn') el.classList.add('is-warn');
    if (state === 'off') el.classList.add('is-off');
  }

  function applyUiMode() {
    document.body.classList.toggle('hb-school', !!schoolMode);
    if (dom.btnSchool) dom.btnSchool.classList.toggle('is-on', !!schoolMode);
    if (dom.btnPersonal) dom.btnPersonal.classList.toggle('is-on', !schoolMode);
  }

  function calcTlTypeLabel(m) {
    const f = m.focus || 0, v = m.variety || 0, e = m.explore || 0;
    if (f > 0.62) return '情報偏重型';
    if (e > 0.55 && f < 0.45) return '探索型';
    if (v > 0.52 && f < 0.55) return 'バランス型';
    return '混合型';
  }

  function calcXpRate(m) {
    const f = m.focus || 0;
    if (f > 0.65) return { rate: 0.4, reason: 'Focus が高め → EXP 減衰' };
    if (f > 0.52) return { rate: 0.7, reason: 'Focus がやや高め → EXP 少し減衰' };
    return { rate: 1.0, reason: 'バランス良好 → 100%' };
  }

  function updateGlance() {
    const master = app.data.master || { enabled:true, analyze:true, intervene:true, display:true };
    const backendAvail = (app.data.backend && app.data.backend.available) ? true : false;
    const apiOn = (app.data.settings && app.data.settings.aiMode === 'prompt');
    setTag(dom.tagExt, `EXT ${master.enabled ? 'ON' : 'OFF'}`, master.enabled ? 'ok' : 'off');
    setTag(dom.tagApi, `API ${apiOn ? 'ON' : 'OFF'}`, apiOn ? (backendAvail ? 'ok' : 'warn') : 'off');
    setTag(dom.tagAnalyze, `ANALYZE ${master.analyze ? 'ON' : 'OFF'}`, master.analyze ? 'ok' : 'off');
    setTag(dom.tagSpot, `SPOTLIGHT ${master.intervene ? 'ON' : 'OFF'}`, master.intervene ? 'ok' : 'off');
    setTag(dom.tagDisplay, `DISPLAY ${master.display ? 'ON' : 'OFF'}`, master.display ? 'ok' : 'off');

    if (dom.timeStarted) dom.timeStarted.textContent = fmtTime(startedAt);
    if (dom.timeUpdated) dom.timeUpdated.textContent = fmtTime(lastConfigAt);
    if (dom.diffText) dom.diffText.textContent = buildDiffText();

    // Character selector buttons (Settings view)
    if (dom.btnFollone && dom.btnLikoris) {
      const isF = (app.data.characterId || 'follone') === 'follone';
      dom.btnFollone.classList.toggle('is-on', isF);
      dom.btnLikoris.classList.toggle('is-on', !isF);
    }

    // Sidebar quick controls (HOME side)
    updateQuickSidebarControls();
  }

  function updateQuickSidebarControls() {
    // MASTER toggles
    const masterState = {
      enabled: !!dom.chkEnabled?.checked,
      analyze: !!dom.chkAnalyze?.checked,
      intervene: !!dom.chkIntervene?.checked,
      display: !!dom.chkDisplay?.checked,
      spotlight: !!dom.chkIntervene?.checked, // spotlight is part of intervene in current pipeline
    };
    document.querySelectorAll('[data-master]').forEach((btn) => {
      const k = btn.getAttribute('data-master');
      if (!k) return;
      btn.classList.toggle('is-on', !!masterState[k]);
    });

    // Character
    const charId = (app.data.characterId || 'follone');
    document.querySelectorAll('[data-char]').forEach((btn) => {
      const id = btn.getAttribute('data-char');
      btn.classList.toggle('is-on', id === charId);
    });

    // Sensitivity
    const sens = (app.data.sensitivity || 'normal');
    document.querySelectorAll('[data-sense]').forEach((btn) => {
      const v = btn.getAttribute('data-sense');
      btn.classList.toggle('is-on', v === sens);
    });
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    return `${hh}:${mm}`;
  }

  function buildDiffText() {
    // keep it extremely simple + safe for school PCs
    const diffs = [];
    const m = app.data.master || {};
    if (m.enabled !== true) diffs.push('ENABLE=OFF');
    if (m.analyze !== true) diffs.push('ANALYZE=OFF');
    if (m.intervene !== true) diffs.push('INTERVENE=OFF');
    if (m.display !== true) diffs.push('DISPLAY=OFF');
    if (schoolMode) diffs.push('MODE=SCHOOL');
    if ((app.data.characterId || 'follone') !== 'follone') diffs.push('CHAR=LIKORIS');
    return diffs.length ? diffs.join(' / ') : 'default';
  }

  function renderProgress() {
    const xp = Number(app.data.xp||0);
    const lv = Number(app.data.level||xpToLevel(xp));
    const { cur, next } = levelToNextXp(lv);

    animateNumber(dom.kvLv, lv, 320, v => String(Math.round(v)));
    animateNumber(dom.kvXp, xp, 420, v => String(Math.round(v)));
    animateNumber(dom.kvNext, Math.max(0, next - xp), 420, v => String(Math.round(v)));

    // TL type (simple label) + XP rate (transparent, not "black box")
    let tlType = '--';
    let xpRate = 1.0;
    let xpReason = '';
    if (app.data.biasAgg) {
      const m = calcBiasMetrics(app.data.biasAgg, app.period || 'week');
      const focus = m.focus || 0;
      const variety = m.variety || 0;
      const explore = m.explore || 0;
      if (focus > 0.62) tlType = '情報偏重型';
      else if (explore > 0.55) tlType = '探索型';
      else if (variety > 0.55) tlType = 'バランス型';
      else tlType = 'ミックス型';

      if (focus > 0.70) { xpRate = 0.40; xpReason = 'Focus高め'; }
      else if (focus > 0.58) { xpRate = 0.70; xpReason = 'Focusやや高め'; }
      else { xpRate = 1.00; xpReason = '通常'; }
    }
    if (dom.kvTlType) dom.kvTlType.textContent = tlType;
    if (dom.kvXpRate) dom.kvXpRate.textContent = `${Math.round(xpRate*100)}%${xpReason ? ` (${xpReason})` : ''}`;

    // Phase3: level-up reaction (safe: UI-only)
    if (app.lastLevel == null) {
      app.lastLevel = lv;
    } else if (lv > app.lastLevel) {
      const gained = lv - app.lastLevel;
      app.lastLevel = lv;
      speak(`Lv UP (+${gained})。次の解放も近い。`, (app.data.characterId || 'PET').toUpperCase());
      // quick glow on status card
      const st = (dom.kvLv && dom.kvLv.closest('.hb-card')) || null;
      if (st) {
        st.classList.add('is-glow');
        setTimeout(() => st.classList.remove('is-glow'), 650);
      }
    }


    // unlock preview (every 5 levels)
    const nextUnlockLv = (Math.floor((lv-1)/5)+1)*5;
    const text = lv >= nextUnlockLv
      ? `Unlock ready: Lv ${nextUnlockLv} reward`
      : `Next unlock: Lv ${nextUnlockLv}`;
    if (dom.unlockText) dom.unlockText.textContent = text;
  }

  function renderQuest() {
    const q = app.data.quest;
    if (!q || !dom.qDaily || !dom.qWeekly) return;

    const daily = (q.daily && Array.isArray(q.daily.items)) ? q.daily.items : [];
    const weekly = (q.weekly && q.weekly.item) ? [q.weekly.item] : [];

    dom.qDaily.innerHTML = '';
    for (const it of daily) dom.qDaily.appendChild(renderQuestItem(it));

    dom.qWeekly.innerHTML = '';
    for (const it of weekly) dom.qWeekly.appendChild(renderQuestItem(it, true));

    // right card quick summary update (if present)
    const dOk = daily.reduce((a,i)=>a + ((i.cur>=i.goal)?1:0), 0);
    const wOk = weekly.reduce((a,i)=>a + ((i.cur>=i.goal)?1:0), 0);
    const questCard = document.querySelector('#sideQuest');
    if (questCard) questCard.textContent = `Daily ${dOk}/${daily.length} / Weekly ${wOk}/${weekly.length}`;
  }

  function renderQuestItem(it, isWeekly=false) {
    const li = document.createElement('li');
    li.className = 'hb-li';

    const label = document.createElement('div');
    label.className = 'hb-li__label';
    label.textContent = it.label || it.id || (isWeekly ? 'weekly' : 'daily');

    const meter = document.createElement('div');
    meter.className = 'hb-meter';
    const goal = Math.max(1, Number(it.goal||1));
    const cur = Math.max(0, Math.min(goal, Number(it.cur||0)));

    // blocks
    const blocks = document.createElement('div');
    blocks.className = 'hb-blocks';
    for (let i=0;i<goal;i++){
      const b = document.createElement('span');
      b.className = 'hb-block' + (i < cur ? ' is-on' : '');
      blocks.appendChild(b);
    }
    const nums = document.createElement('div');
    nums.className = 'hb-li__nums';
    nums.textContent = `${cur}/${goal}`;

    meter.appendChild(blocks);
    meter.appendChild(nums);

    if (cur >= goal) li.classList.add('is-done');

    li.appendChild(label);
    li.appendChild(meter);
    return li;
  }

  function renderLog() {
    const list = document.getElementById('logList');
    const summary = document.getElementById('logSummary');
    const empty = document.getElementById('logEmpty');
    if (!list || !summary || !empty) return;

    const itemsRaw = Array.isArray(app.data.lightLog) ? app.data.lightLog : [];
    const items = itemsRaw.slice().reverse().slice(0, 12);

    summary.textContent = `latest: ${items.length}/${itemsRaw.length}`;

    list.innerHTML = '';
    if (!items.length) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'hb-li hb-li--log';

      const meta = document.createElement('div');
      meta.className = 'hb-logMeta';
      const ts = (it.ts || it.time || it.at || null);
      meta.textContent = ts ? new Date(Number(ts)).toLocaleString() : '—';

      const text = document.createElement('div');
      text.className = 'hb-logText';
      const reason = (it.reason || it.label || it.kind || it.type || 'Spotlight');
      const extra = it.detail || it.note || it.tag || '';
      text.textContent = extra ? `${reason} — ${extra}` : String(reason);

      const tag = document.createElement('div');
      tag.className = 'hb-tag';
      const score = (it.score ?? it.level ?? it.severity ?? null);
      tag.textContent = score === null ? (it.mode || 'info') : `score ${score}`;

      li.appendChild(meta);
      li.appendChild(text);
      li.appendChild(tag);
      list.appendChild(li);
    }
  }

  function ensureMiniRings() {
    if (dom._miniRingsEl) return dom._miniRingsEl;
    const card = document.querySelector('.hb-sideCard[data-open="bias"] .hb-sideCard__bd');
    if (!card) return null;
    const wrap = document.createElement('div');
    wrap.className = 'hb-miniRings';
    wrap.innerHTML = `
      <div class="hb-ring" data-k="f"><div class="hb-ring__cap">F</div></div>
      <div class="hb-ring" data-k="v"><div class="hb-ring__cap">V</div></div>
      <div class="hb-ring" data-k="e"><div class="hb-ring__cap">E</div></div>
    `;
    card.appendChild(wrap);
    dom._miniRingsEl = wrap;
    return wrap;
  }

  function setRing(el, p) {
    const v = clamp01(p);
    el.style.setProperty('--p', String(v));
  }

  function updateMiniRings(focus, variety, explore) {
    const wrap = ensureMiniRings();
    if (!wrap) return;
    const rf = wrap.querySelector('.hb-ring[data-k="f"]');
    const rv = wrap.querySelector('.hb-ring[data-k="v"]');
    const re = wrap.querySelector('.hb-ring[data-k="e"]');
    if (rf) setRing(rf, focus);
    if (rv) setRing(rv, variety);
    if (re) setRing(re, explore);
  }

  function renderBias() {
    const biasAgg = app.data.biasAgg;
    const period = app.period;
    const agg = aggByPeriod(biasAgg, period);
    const m = calcBiasMetrics(agg);

    // update note
    if (dom.periodNote) {
      dom.periodNote.textContent = `${period.toUpperCase()} / posts: ${m.total} / top: ${m.topKey || '--'}`;
    }

    // animate charts
    const prev = app.chartLast;
    const next = { focus: m.focus, variety: m.variety, explore: m.explore };

    tween(prev.focus, next.focus, 420, v => drawRingPie(dom.cFocus, v, m.topKey ? `top: ${m.topKey}` : 'top: --', `posts: ${m.total}`));
    tween(prev.variety, next.variety, 420, v => drawRingPie(dom.cVar, v, `topics: ${m.eff}/${m.nTotalTopics}`, `entropy`));
    tween(prev.explore, next.explore, 420, v => drawRingPie(dom.cExp, v, `unique: ${m.eff}`, `scope`));

    app.chartLast = next;

    if (dom.tFocus) dom.tFocus.textContent = `Focus ${Math.round(m.focus*100)}% (${m.topKey||'--'})`;
    if (dom.tVar) dom.tVar.textContent = `Variety ${Math.round(m.variety*100)}% (topics ${m.eff}/${m.nTotalTopics})`;
    if (dom.tExp) dom.tExp.textContent = `Explore ${Math.round(m.explore*100)}% (unique ${m.eff})`;

    // right bias card summary
    const biasCard = document.querySelector('#sideBias');
    if (biasCard) biasCard.textContent = `Focus ${Math.round(m.focus*100)}% / Variety ${Math.round(m.variety*100)}% / Explore ${Math.round(m.explore*100)}%`;
  }
  // -----------------------------
  // Phase1: PetEngine boot (kept when Phase2 adds data)
  // -----------------------------
  

  // -----------------------------
  // Phase4: Dev console + rule visibility + light history
  // -----------------------------
  function renderDev() {
    // backend
    const b = app.data.backend || {};
    const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v===undefined||v===null||v==='') ? '--' : String(v); };

    setTxt('devAvail', b.state ?? 'unavailable');
    setTxt('devSession', b.session ?? '--');
    setTxt('devLatency', b.latency ?? '--');
    setTxt('devLastErr', b.lastError ?? '--');

    // reflect feature flags in both header and dev
    const f = app.data.master || {};
    const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    setChk('m-enabled', f.enabled);
    setChk('m-analyze', f.analyze);
    setChk('m-intervene', f.intervene);
    setChk('m-display', f.display);

    setChk('devEnabled', f.enabled);
    setChk('devAnalyze', f.analyze);
    setChk('devIntervene', f.intervene);
    setChk('devDisplay', f.display);

    // light log (today)
    const day = jstDayKey(Date.now());
    const log = (app.data.lightLog && app.data.lightLog[day]) ? app.data.lightLog[day] : { analyzed: 0, spotlight: 0, xp: 0 };
    setTxt('devLogAnalyze', log.analyzed ?? 0);
    setTxt('devLogSpot', log.spotlight ?? 0);
    setTxt('devLogXp', log.xp ?? 0);
  }

  function bindDev() {
    const wire = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', async () => {
        const v = !!el.checked;
        if (!app.data.master) app.data.master = { enabled:true, analyze:true, intervene:true, display:true };
        app.data.master[key] = v;

        // persist (safe)
        const map = {
          enabled: 'follone_enabled',
          analyze: 'follone_master_analyze',
          intervene: 'follone_master_intervene',
          display: 'follone_master_display'
        };
        await writeOne(map[key], v);
        speak('……切り替えた。', (app.data.characterId || 'PET').toUpperCase());
        renderDev();
      });
    };
    wire('m-enabled','enabled');
    wire('m-analyze','analyze');
    wire('m-intervene','intervene');
    wire('m-display','display');
    wire('devEnabled','enabled');
    wire('devAnalyze','analyze');
    wire('devIntervene','intervene');
    wire('devDisplay','display');

    const btnClear = document.getElementById('btnClearLog');
    if (btnClear) btnClear.addEventListener('click', async () => {
      const day = jstDayKey(Date.now());
      if (!app.data.lightLog) app.data.lightLog = {};
      app.data.lightLog[day] = { analyzed: 0, spotlight: 0, xp: 0 };
      await writeOne('follone_lightLog_v1', app.data.lightLog);
      speak('……今日のログ、消した。', (app.data.characterId || 'PET').toUpperCase());
      renderDev();
    });

    const btnHard = document.getElementById('btnHardReset');
    if (btnHard) btnHard.addEventListener('click', async () => {
      if (!confirm('HARD RESETしますか？\n（ストレージが初期化されます）')) return;
      try {
        if (hasChrome()) await chrome.storage.local.clear();
      } catch (e) {}
      location.reload();
    });
  }
function bootPet() {
    const cvMain = document.getElementById('petCanvas');
    const cvSub  = document.getElementById('petCanvasSub');

    const setNext = (t) => {
      const el = document.getElementById('nextText');
      if (el) el.textContent = t;
    };

    const drawFallback = (cv, label='NO PET') => {
      if (!cv) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0,0,cv.width,cv.height);
      ctx.fillStyle = '#120f1f';
      ctx.fillRect(0,0,cv.width,cv.height);
      ctx.fillStyle = 'rgba(180,160,255,.55)';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillText(label, 10, cv.height - 12);
    };

    if (!cvMain) return;

    const PetEngine = window.PetEngine;
    if (!PetEngine) {
      setNext('PetEngineが読み込めていません（options.htmlにpet/PetEngine.jsが必要）');
      drawFallback(cvMain, 'NO PET');
      drawFallback(cvSub, 'NO PET');
      return;
    }

    // Resolve extension URL safely
    const resolveExtURL = (path) => {
      try {
        if (window.chrome?.runtime?.getURL) return window.chrome.runtime.getURL(path);
      } catch (_) {}
      return path;
    };

    // Keep single instance
    if (!window.__hbPet) window.__hbPet = {};
    const P = window.__hbPet;

    // Create engines
    try {
      P.engineMain = new PetEngine({ canvas: cvMain, debug: false, pixelSize: 1 });
      if (cvSub) P.engineSub = new PetEngine({ canvas: cvSub, debug: false, pixelSize: 1 });
    } catch (e) {
      console.warn('[HB] PetEngine ctor failed', e);
      setNext('PetEngine: init failed');
      drawFallback(cvMain, 'NO PET');
      drawFallback(cvSub, 'NO PET');
      return;
    }

    // Load assets (same as overlay/options original)
    const accessoriesURL = resolveExtURL('pet/data/accessories/accessories.json');
    const charIdRaw = (app?.data?.characterId) || 'follone';
    const charId = (String(charIdRaw) === 'forone') ? 'follone' : String(charIdRaw);
    const charURL = resolveExtURL(`pet/data/characters/${charId}.json`);

    P.charId = charId;
    P.stop = false;

    const ensureLoaded = async () => {
      try {
        if (!P.accessories) {
          try {
            P.accessories = await P.engineMain.loadAccessoriesFromURL(accessoriesURL);
          } catch (e) {
            console.warn('[HB] accessories load failed', e);
            P.accessories = null;
          }
        }
        P.char = await P.engineMain.loadCharacterFromURL(charURL);
        setNext('pet engine: online');
      } catch (e) {
        console.error('[HB] character load failed', e);
        setNext('pet engine: character load failed');
        drawFallback(cvMain, 'NO PET');
        drawFallback(cvSub, 'NO PET');
        P.char = null;
      }
    };

    // Animation state
    P.nextBlinkAt = performance.now() + 1800 + Math.random()*1800;
    P.blinkUntil = 0;
    P.talkUntil = 0;

    const tick = (t) => {
      if (P.stop) return;
      if (!P.char) { P.raf = requestAnimationFrame(tick); return; }

      const now = t;

      // Blink scheduling
      if (now >= P.nextBlinkAt) {
        P.blinkUntil = now + 140;
        P.nextBlinkAt = now + 1800 + Math.random()*2200;
      }

      const eyes = (now <= P.blinkUntil) ? 'blink' : 'normal';
      const mouth = (now <= P.talkUntil) ? 'talk' : 'idle';

      // Equipment from app state (if present)
      const headId = app?.data?.equippedHead || null;
      const fxId   = app?.data?.equippedFx || null;

      try {
        P.engineMain.renderPet({
          char: P.char,
          eyesVariant: eyes,
          mouthVariant: mouth,
          extraVariant: 'default',
          accessories: P.accessories || undefined,
          equip: { head: headId, fx: fxId }
        });
        if (P.engineSub) {
          P.engineSub.renderPet({
            char: P.char,
            eyesVariant: eyes,
            mouthVariant: mouth,
            extraVariant: 'default',
            accessories: P.accessories || undefined,
            equip: { head: headId, fx: fxId }
          });
        }
      } catch (e) {
        console.warn('[HB] render error', e);
        // Don't spam: stop rendering if repeated failures
      }

      P.raf = requestAnimationFrame(tick);
    };

    // Re-load when characterId changes
    if (!P.__boundReload) {
      P.__boundReload = true;
      window.addEventListener('hb:petReload', () => {
        P.char = null;
        ensureLoaded().catch(()=>{});
      });
    }

    ensureLoaded().then(() => {
      if (P.raf) cancelAnimationFrame(P.raf);
      P.raf = requestAnimationFrame(tick);
    }).catch(()=>{});
  }



  
  // -----------------------------
  // Phase3: RPG (Battle Pass / Unlock preview)
  // -----------------------------
  function speak(text, name) {
    if (!dom.bubble || !dom.bubbleText) return;
    dom.bubble.style.display = 'block';
    if (dom.bubbleName) dom.bubbleName.textContent = name || (app.data.characterId || 'PET').toUpperCase();
    dom.bubbleText.textContent = text || '';
  }

  const REWARD_TABLE = [
    { lv: 5, slot: 'head', id: 'bandage', label: 'Head: Bandage' },
    { lv: 10, slot: 'head', id: 'cap', label: 'Head: Cap' },
    { lv: 15, slot: 'fx', id: 'sparkle', label: 'FX: Sparkle' },
    { lv: 20, slot: 'fx', id: 'heart', label: 'FX: Heart' },
  ];
  // -----------------------------
  // Command / Chat
  // -----------------------------
  const cmdState = {
    lines: [],
    lastChatAt: 0,
    chatCooldownMs: 1800,
  };

  function clipText(s, max = 40) {
    const t = String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!t) return '';
    if (t.length <= max) return t;
    return t.slice(0, Math.max(0, max - 1)) + '…';
  }

  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function pushCmdLine(label, text) {
    if (!dom.cmdLog) return;
    const line = `${label}: ${text}`;
    cmdState.lines.push({ label, text });
    if (cmdState.lines.length > 6) cmdState.lines.shift();
    dom.cmdLog.innerHTML = cmdState.lines.map(l => {
      const safe = escapeHtml(l.text);
      const lab = escapeHtml(l.label);
      return `<div class="hb-cmdlog__line"><b>${lab}</b> ${safe}</div>`;
    }).join('');
    dom.cmdLog.scrollTop = dom.cmdLog.scrollHeight;
  }

  function focusCmd() {
    if (!dom.cmdInput) return;
    dom.cmdInput.focus();
    dom.cmdInput.select?.();
  }

  function normalizeCmd(s) { return String(s || '').trim(); }

  async function runCommand(raw) {
    const t = normalizeCmd(raw);
    if (!t) return;

    // hidden / alias (no slash required)
    if (t === 'developer') { setView('dev'); pushCmdLine('SYS', 'DEV MODE'); return; }
    if (t === 'exit') { setView('home'); pushCmdLine('SYS', 'HOME'); return; }

    // command style
    const isCmd = t.startsWith('/');
    const body = isCmd ? t.slice(1).trim() : t;
    const parts = body.split(/\s+/).filter(Boolean);
    const cmd = (parts.shift() || '').toLowerCase();
    const arg = parts.join(' ');

    const goto = (v) => {
      setView(v);
      if (v === 'bias') renderBias();
      if (v === 'quest') renderQuest();
      if (v === 'log') renderLog();
      if (v === 'rpg') renderRpg();
      if (v === 'dev') { renderDev(); }
    };

    const helpText = [
      'GENERAL: /home /bias /quest /log /settings /rpg',
      'AI CORE: /prepare /warmup /status',
      'RPG/OPS: /suggest /reset',
      'SHARE : /export /import',
      'CHAR  : /char follone|likoris',
      'HIDDEN: developer / exit',
      'CHAT  : そのまま文章（40字）'
    ].join(' | ');

    if (cmd === 'help' || cmd === '?') { pushCmdLine('HELP', helpText); return; }
    if (['home','bias','quest','settings','rpg','dev'].includes(cmd)) { goto(cmd === 'dev' ? 'dev' : cmd); pushCmdLine('SYS', `goto ${cmd}`); return; }

    if (cmd === 'char') {
      const id = (parts[0] || '').toLowerCase();
      if (!id) { pushCmdLine('ERR', 'usage: /char follone|likoris'); return; }
      const val = id === 'likoris' ? 'likoris' : 'follone';
      await setCharacterId(val);
      if (app.view === 'bias') renderBias();
      if (app.view === 'quest') renderQuest();
      if (app.view === 'rpg') renderRpg();
      pushCmdLine('SYS', `character = ${val}`);
      return;
    }

    if (cmd === 'prepare') {
      const resp = await sendSW('FOLLONE_AI_SETUP_START', {});
      pushCmdLine(resp.ok ? 'AI' : 'ERR', resp.ok ? 'prepare started' : (resp.errorCode || 'prepare failed'));
      await refreshBackend();
      return;
    }

    if (cmd === 'suggest') {
      const hint = buildSuggestion();
      speak(hint, (app.data.characterId || 'PET').toUpperCase());
      pushCmdLine('SYS', hint);
      return;
    }

    if (cmd === 'export') {
      await doExport();
      return;
    }

    if (cmd === 'import') {
      await doImport();
      return;
    }

    if (cmd === 'warmup') {
      const resp = await sendSW('FOLLONE_BACKEND_WARMUP', {});
      pushCmdLine(resp.ok ? 'AI' : 'ERR', resp.ok ? 'warmup started' : (resp.errorCode || 'warmup failed'));
      await refreshBackend();
      return;
    }

    if (cmd === 'status') {
      const resp = await sendSW('FOLLONE_BACKEND_STATUS', {});
      if (resp && resp.ok) {
        pushCmdLine('AI', `availability=${resp.availability || '—'} session=${resp.sessionId || '—'} latency=${resp.latencyMs ?? '—'}ms`);
      } else {
        pushCmdLine('ERR', resp?.errorCode || 'status failed');
      }
      await refreshBackend();
      return;
    }

    if (cmd === 'reset') {
      const ok = confirm('完全初期化しますか？（学校PC運用向け）');
      if (!ok) { pushCmdLine('SYS', 'reset canceled'); return; }
      const resp = await sendSW('FOLLONE_FACTORY_RESET', {});
      pushCmdLine(resp.ok ? 'SYS' : 'ERR', resp.ok ? 'reset done' : (resp.errorCode || 'reset failed'));
      await readAll();
      renderProgress();
      if (app.view === 'bias') renderBias();
      if (app.view === 'quest') renderQuest();
      if (app.view === 'rpg') renderRpg();
      return;
    }

    if (cmd === 'dev') {
      // kept as explicit command too
      goto('dev');
      pushCmdLine('SYS', 'DEV MODE');
      return;
    }

    // If it wasn't a slash command, treat as chat
    if (!isCmd) {
      await sendChat(t);
      return;
    }

    pushCmdLine('ERR', `unknown: ${cmd}  (try /help)`);
  }

  async function sendChat(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const now = Date.now();
    if (now - cmdState.lastChatAt < cmdState.chatCooldownMs) {
      const waitMs = cmdState.chatCooldownMs - (now - cmdState.lastChatAt);
      const msg = `クールダウン中… ${(waitMs/1000).toFixed(1)}s`;
      pushCmdLine('SYS', msg);
      speak(msg, (app.data.characterId || 'PET').toUpperCase());
      return;
    }
    cmdState.lastChatAt = now;

    // keep it short (UI).
    const clipped = clipText(t, 40);
    pushCmdLine('YOU', clipped);

    const ctx = buildChatContext();

    const resp = await sendSW('FOLLONE_CHAT', { text: clipped, context: ctx }, 22000);
    if (resp && resp.ok && resp.text) {
      const outRaw = String(resp.text);
      const out = clipText(outRaw, 40);
      speak(out);
      pushCmdLine((app.data.characterId || 'PET').toUpperCase(), out);
    } else {
      const code = resp?.errorCode || resp?.status || 'unavailable';
      const fallback = code === 'SIMULATED_UNAVAILABLE'
        ? '（学校PC: AI未接続。設定→AI準備）'
        : '……今は話せない。';
      const fb = clipText(fallback, 40);
      speak(fb);
      pushCmdLine('PET', fb);
    }
  }

  function buildChatContext() {
    // Safe, tiny context: can be ignored by backend.
    const bias = app.data?.bias || null;
    const quest = app.data?.quest || null;
    return {
      view: app.view,
      characterId: app.data?.characterId,
      level: app.data?.level,
      xp: app.data?.xp,
      next: app.data?.next,
      backend: app.data?.backend || null,
      bias: bias ? {
        focus: bias.focus,
        variety: bias.variety,
        explore: bias.explore,
        total: bias.total,
      } : null,
      quest: quest ? {
        dailyDone: quest.dailyDone,
        dailyTotal: quest.dailyTotal,
        weeklyDone: quest.weeklyDone,
        weeklyTotal: quest.weeklyTotal,
      } : null,
    };
  }

  function buildSuggestion() {
    // Prefer concrete actions that work in school.
    const b = app.data?.bias;
    const q = app.data?.quest;
    if (q && q.dailyDone < (q.dailyTotal || 3)) {
      return 'NEXT: Dailyクエストを1つ進めよう。';
    }
    if (b) {
      const focus = Number(b.focus || 0);
      const variety = Number(b.variety || 0);
      const explore = Number(b.explore || 0);
      if (focus >= 0.65) return '偏り強め。検索で別ジャンルを1回試そう。';
      if (variety <= 0.35) return '話題が単調。違う視点の投稿を1つ探そう。';
      if (explore <= 0.25) return '新規が少ない。フォロー外も少し覗こう。';
      return 'いい感じ。今の調子で1クエスト消化しよう。';
    }
    return 'NEXT: 右のQUESTかBIASを開いて確認しよう。';
  }

  async function doExport() {
    const keys = [
      'follone_characterId',
      'follone_xp',
      'follone_equippedHead',
      'follone_equippedFx',
      'follone_quest',
      'follone_flags',
      'follone_settings',
      'follone_biasAgg_v2',
    ];
    if (!hasChrome()) {
      pushCmdLine('ERR', 'export: NO_STORAGE');
      return;
    }
    const data = await chrome.storage.local.get(keys);
    const payload = {
      v: 1,
      exportedAt: new Date().toISOString(),
      keys,
      data,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `retro-pet-options-export_${jstDayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    pushCmdLine('SYS', 'exported.');
  }

  async function doImport() {
    const input = document.getElementById('cmdImportFile');
    if (!input) { pushCmdLine('ERR', 'import: NO_INPUT'); return; }
    if (!hasChrome()) { pushCmdLine('ERR', 'import: NO_STORAGE'); return; }
    const ok = confirm('importすると現在の設定/進捗を上書きします。続行しますか？');
    if (!ok) { pushCmdLine('SYS', 'import canceled'); return; }
    input.value = '';
    input.click();
  }

  function bindCommandBar() {
    if (!dom.cmdInput) return;

    // import handler
    const importInput = document.getElementById('cmdImportFile');
    if (importInput && !importInput.__hbBound) {
      importInput.__hbBound = true;
      importInput.addEventListener('change', async () => {
        const file = importInput.files && importInput.files[0];
        if (!file) return;
        try {
          const txt = await file.text();
          const parsed = JSON.parse(txt);
          const data = parsed && parsed.data ? parsed.data : null;
          if (!data || typeof data !== 'object') throw new Error('bad format');
          await chrome.storage.local.set(data);
          pushCmdLine('SYS', 'imported.');
          // refresh UI
          await loadAll();
          renderProgress();
          if (app.view === 'bias') renderBias();
          if (app.view === 'quest') renderQuest();
          if (app.view === 'rpg') renderRpg();
          if (app.view === 'dev') renderDev();
        } catch (e) {
          pushCmdLine('ERR', `import failed: ${String(e && e.message ? e.message : e)}`);
        } finally {
          importInput.value = '';
        }
      });
    }

    // click send
    if (dom.cmdSend) {
      dom.cmdSend.addEventListener('click', () => {
        const v = dom.cmdInput.value;
        dom.cmdInput.value = '';
        runCommand(v);
      });
    }

    // enter to submit
    dom.cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = dom.cmdInput.value;
        dom.cmdInput.value = '';
        runCommand(v);
      }
      if (e.key === 'Escape') {
        dom.cmdInput.value = '';
        dom.cmdInput.blur();
      }
    });

    // quick focus with '/'
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea') return;
      if (e.key === '/') {
        e.preventDefault();
        focusCmd();
        // prefill slash
        if (dom.cmdInput && dom.cmdInput.value.trim() === '') dom.cmdInput.value = '/';
      }
    });
  }

  async function sendSW(type, payload = {}, timeoutMs = 15000) {
    if (!window.chrome?.runtime?.sendMessage) return { ok: false, errorCode: 'NO_RUNTIME' };
    return await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, errorCode: 'TIMEOUT' });
      }, timeoutMs);
      try {
        window.chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          // chrome.runtime.lastError happens when no listener / extension reload
          const le = window.chrome.runtime.lastError;
          if (le) { resolve({ ok: false, errorCode: 'RUNTIME_ERROR', error: String(le.message || le) }); return; }
          resolve(resp || { ok: false });
        });
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, errorCode: 'EXCEPTION', error: String(e) });
      }
    });
  }

  async function refreshBackend() {
    // Optional: update app.data.backend if supported
    const resp = await sendSW('FOLLONE_BACKEND_STATUS', {}, 12000);
    if (resp && resp.ok) {
      app.data.backend = {
        availability: resp.availability || resp.status || '—',
        sessionId: resp.sessionId || resp.session || '—',
        latencyMs: typeof resp.latencyMs === 'number' ? resp.latencyMs : null,
        lastError: resp.lastError || resp.errorCode || ''
      };
      renderProgress();
      if (app.view === 'bias') renderBias();
      if (app.view === 'quest') renderQuest();
      if (app.view === 'rpg') renderRpg();
    }
  }


  function nextReward(lv) {
    return REWARD_TABLE.find(r => r.lv > lv) || null;
  }
  function rewardAt(lv) {
    return REWARD_TABLE.find(r => r.lv === lv) || null;
  }

  function renderBattlePass(lv) {
    if (!dom.bpTrack) return;
    dom.bpTrack.innerHTML = '';
    const start = Math.max(1, lv - 3);
    const end = lv + 8;

    for (let n = start; n <= end; n++) {
      const r = rewardAt(n);
      const node = document.createElement('div');
      node.className = 'hb-bpNode' + (n === lv ? ' is-on' : '') + (n < lv ? ' is-done' : '');
      node.innerHTML = `
        <div class="hb-bpDot"></div>
        <div class="hb-bpLv">Lv ${n}</div>
        <div class="hb-bpReward">${r ? r.label : '—'}</div>
      `;
      node.addEventListener('click', () => {
        if (r) speak(`Lv${r.lv}で「${r.label}」が解放。`, (app.data.characterId || 'PET').toUpperCase());
        else speak(`Lv${n}：報酬なし。次の節目に備えよう。`, (app.data.characterId || 'PET').toUpperCase());
      });
      dom.bpTrack.appendChild(node);
    }
  }

  function renderRpg() {
    const lv = Number(app.data.level || 0);
    const xp = Number(app.data.xp || 0);
    const next = Number(app.data.next || 0);

    if (dom.rpgLv) dom.rpgLv.textContent = isFinite(lv) ? String(lv) : '--';
    if (dom.rpgXp) dom.rpgXp.textContent = isFinite(xp) ? String(xp) : '--';
    if (dom.rpgNext) dom.rpgNext.textContent = isFinite(next) ? String(next) : '--';

    renderBattlePass(lv);

    const nr = nextReward(lv);
    if (dom.unlockNextLabel) {
      dom.unlockNextLabel.textContent = nr ? `Next Unlock: Lv ${nr.lv} / ${nr.label}` : 'Next Unlock: --';
    }

    if (dom.btnClaimDemo) {
      dom.btnClaimDemo.onclick = () => {
        const rr = rewardAt(lv);
        speak(rr ? `（demo）Lv${lv}報酬を受け取った。` : `（demo）次の節目まで待とう。`, (app.data.characterId || 'PET').toUpperCase());
      };
    }
    if (dom.btnEquipDemo) {
      dom.btnEquipDemo.onclick = () => {
        speak('（demo）装備UIは次の実装で拡張するよ。', (app.data.characterId || 'PET').toUpperCase());
      };
    }
  }

// -----------------------------
  // Bindings
  // -----------------------------

  function renderAll() {
    // minimal safe rerender set
    renderProgress();
    renderDev();
    if (app.data.quest) renderQuest();
    renderBias();
    updateGlance();
    updateDiffText();
    if (app.view === 'log') renderLog();
    if (app.view === 'rpg') renderRpg();
  }

  function bindNav() {
    dom.rightTabs.forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.open;
        if (!v) return;
        setView(v);
        if (v === 'bias') renderBias();
        if (v === 'quest') renderQuest();
        if (v === 'log') renderLog();
        if (v === 'rpg') renderRpg();
      });
    });

    dom.rightCards.forEach(card => {
      card.addEventListener('click', () => {
        const v = card.dataset.open;
        if (!v) return;
        setView(v);
        if (v === 'bias') renderBias();
        if (v === 'quest') renderQuest();
        if (v === 'log') renderLog();
        if (v === 'rpg') renderRpg();
      });
    });

    
    // Also bind any in-panel buttons with data-open (HOME next-action etc.)
    $$('.hb-root [data-open]').forEach(el => {
      if (el.classList.contains('hb-sideCard') || el.classList.contains('hb-tab')) return;
      el.addEventListener('click', () => {
        const v = el.dataset.open;
        if (!v) return;
        setView(v);
        if (v === 'bias') renderBias();
        if (v === 'quest') renderQuest();
        if (v === 'log') renderLog();
        if (v === 'rpg') renderRpg();
      });
    });

if (dom.btnBack) dom.btnBack.addEventListener('click', () => setView('home'));

    dom.periodBtns.forEach(b => {
      b.addEventListener('click', () => {
        dom.periodBtns.forEach(x => x.classList.remove('is-on'));
        b.classList.add('is-on');
        app.period = b.dataset.period || 'week';
        renderBias();
      });
    });
  }

  function bindGlanceAndHelp() {
    // help toggles
    $$('.hb-q').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.help;
        if (!id) return;
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('is-on');
      });
    });

    // mode
    if (dom.btnSchool) dom.btnSchool.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      schoolMode = true;
      lastConfigAt = Date.now();
      applyUiMode();
      await writeOne('follone_ui_schoolMode', true);
      updateGlance(); updateDiffText();
    });
    if (dom.btnPersonal) dom.btnPersonal.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      schoolMode = false;
      lastConfigAt = Date.now();
      applyUiMode();
      await writeOne('follone_ui_schoolMode', false);
      updateGlance(); updateDiffText();
    });

    // pause presets
    if (dom.btnPauseAnalyze) dom.btnPauseAnalyze.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      dom.chkAnalyze.checked = false;
      dom.chkIntervene.checked = false;
      await saveMaster();
      speak('解析/介入を一時停止した。', (app.data.characterId || 'PET').toUpperCase());
      lastConfigAt = Date.now();
      updateGlance(); updateDiffText();
    });
    if (dom.btnMuteDisplay) dom.btnMuteDisplay.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      dom.chkDisplay.checked = false;
      await saveMaster();
      speak('表示をミュートした。', (app.data.characterId || 'PET').toUpperCase());
      lastConfigAt = Date.now();
      updateGlance(); updateDiffText();
    });
    if (dom.btnResumeAll) dom.btnResumeAll.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      dom.chkEnabled.checked = true;
      dom.chkAnalyze.checked = true;
      dom.chkIntervene.checked = true;
      dom.chkDisplay.checked = true;
      await saveMaster();
      speak('すべて再開した。', (app.data.characterId || 'PET').toUpperCase());
      lastConfigAt = Date.now();
      updateGlance(); updateDiffText();
    });

    // presets (ui-only safe)
    if (dom.btnPresetBeginner) dom.btnPresetBeginner.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      dom.qsSafe.checked = true;
      dom.qsWarn.checked = false;
      dom.qsAuto.checked = true;
      dom.btnSensNormal?.click();
      lastConfigAt = Date.now();
      speak('初心者向けプリセットを反映した。', (app.data.characterId || 'PET').toUpperCase());
      updateDiffText();
    });
    if (dom.btnPresetStandard) dom.btnPresetStandard.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      dom.qsSafe.checked = true;
      dom.qsWarn.checked = true;
      dom.qsAuto.checked = true;
      dom.btnSensNormal?.click();
      lastConfigAt = Date.now();
      speak('標準プリセットを反映した。', (app.data.characterId || 'PET').toUpperCase());
      updateDiffText();
    });
    if (dom.btnPresetSafe) dom.btnPresetSafe.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      dom.qsSafe.checked = true;
      dom.qsWarn.checked = true;
      dom.qsAuto.checked = true;
      dom.btnSensHard?.click();
      lastConfigAt = Date.now();
      speak('しっかり安全プリセットを反映した。', (app.data.characterId || 'PET').toUpperCase());
      updateDiffText();
    });

    if (dom.btnDiff) dom.btnDiff.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const t = buildDiffText();
      speak(t || '変更点はないよ。', (app.data.characterId || 'PET').toUpperCase());
    });

    // Character selector (Settings)
    if (dom.btnFollone) dom.btnFollone.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      await setCharacterId('follone');
      speak('ふぉろねに切り替えた。', 'SYSTEM');
    });
    if (dom.btnLikoris) dom.btnLikoris.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      await setCharacterId('likoris');
      speak('りこりすに切り替えた。', 'SYSTEM');
    });

    document.querySelectorAll('[data-master]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const k = btn.getAttribute('data-master');
        if (!k) return;
        // spotlight is currently treated as a view of the intervene toggle
        if (k === 'spotlight') {
          dom.chkIntervene.checked = !dom.chkIntervene.checked;
        } else if (k === 'enabled') {
          dom.chkEnabled.checked = !dom.chkEnabled.checked;
        } else if (k === 'analyze') {
          dom.chkAnalyze.checked = !dom.chkAnalyze.checked;
        } else if (k === 'intervene') {
          dom.chkIntervene.checked = !dom.chkIntervene.checked;
        } else if (k === 'display') {
          dom.chkDisplay.checked = !dom.chkDisplay.checked;
        }
        await saveMaster();
        updateGlance();
      });
    });

    document.querySelectorAll('[data-char]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = btn.getAttribute('data-char');
        if (!id) return;
        await setCharacterId(id);
        await writeOne('follone_characterId', app.data.characterId);
        updateGlance();
      });
    });

    document.querySelectorAll('[data-sense]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const v = btn.getAttribute('data-sense');
        if (!v) return;
        app.data.sensitivity = v;
        await writeOne('follone_sensitivity', v);
        updateGlance();
      });
    });
  }

  async function saveMaster() {
    if (!hasChrome()) return;
    const obj = {
      follone_enabled: !!dom.chkEnabled?.checked,
      follone_master_analyze: !!dom.chkAnalyze?.checked,
      follone_master_intervene: !!dom.chkIntervene?.checked,
      follone_master_display: !!dom.chkDisplay?.checked,
    };
    await new Promise(res => chrome.storage.local.set(obj, res));
  }

  function bindAccessory() {
    if (dom.selHead) {
      dom.selHead.addEventListener('change', async () => {
        const v = dom.selHead.value;
        app.data.equippedHead = (v === 'none') ? '' : v;
        // SW expects follone_equippedHead
        await writeOne('follone_equippedHead', app.data.equippedHead);
      });
    }
    // FX isn't in SW yet in this build; keep UI local without breaking.
    if (dom.selFx) {
      dom.selFx.addEventListener('change', () => {});
    }
  }

  function bindStorageListener() {
    if (!hasChrome() || !chrome.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      let needProgress = false, needBias = false, needQuest = false;

      if (changes.follone_xp || changes.follone_level) {
        app.data.xp = Number(changes.follone_xp?.newValue ?? app.data.xp);
        app.data.level = Number(changes.follone_level?.newValue ?? app.data.level);
        needProgress = true;
      }
      if (changes.follone_quest) {
        app.data.quest = changes.follone_quest.newValue;
        needQuest = true;
      }
      if (changes[BIAS_STORAGE_KEY]) {
        app.data.biasAgg = changes[BIAS_STORAGE_KEY].newValue;
        needBias = true;
      }
      if (changes.follone_equippedHead && dom.selHead) {
        const v = changes.follone_equippedHead.newValue || '';
        dom.selHead.value = v || 'none';
      }

      if (needProgress) renderProgress();
      renderDev();
      if (needQuest) renderQuest();
      if (needBias && app.view === 'bias') renderBias();
      renderDev();
      if (needBias && app.view === 'home') {
        // keep right-card updated
        renderBias();
      renderDev();
      }
    });
  }

  // -----------------------------
  // Init
  // -----------------------------
  async function init() {
    // Phase2.5: ensure YEAR period exists (insert dynamically to keep HTML stable)
    const seg = document.querySelector('.hb-seg');
    if (seg && !seg.querySelector('[data-period="year"]')) {
      const btn = document.createElement('button');
      btn.className = 'hb-seg__btn';
      btn.dataset.period = 'year';
      btn.textContent = 'YEAR';
      const total = seg.querySelector('[data-period="total"]');
      if (total) seg.insertBefore(btn, total);
      else seg.appendChild(btn);
    }
    // refresh period buttons list (dom is const object but properties can be updated)
    dom.periodBtns = $$('.hb-seg__btn[data-period]');

    bindNav();
    bindGlanceAndHelp();
    normalizeTooltips();
    bindAccessory();
    bindCommandBar();
    setView('home');
    if (dom.nextAction) dom.nextAction.classList.add('is-pulse');

    const obj = await readAll();

    app.data.xp = Number(obj.follone_xp || 0);
    app.data.level = Number(obj.follone_level || xpToLevel(app.data.xp));
    app.data.quest = obj.follone_quest || null;
    app.data.biasAgg = obj[BIAS_STORAGE_KEY] || null;
    app.data.characterId = pickCharacterId(obj);
    app.data.equippedHead = obj.follone_equippedHead || '';

    // Quick settings (right monitor)
    app.data.safeFilter = obj.follone_safeFilterEnabled !== false;
    app.data.softWarning = obj.follone_softWarningEnabled === true;
    app.data.autoScan = obj.follone_autoScanEnabled !== false;
    app.data.notifyEnabled = obj.follone_notifyEnabled === true;
    app.data.spotlightStrength = String(obj.follone_spotlightStrength || 'normal');

    // Apply character theme to the whole Options UI
    applyCharacterTheme(app.data.characterId);

    // Boot PetEngine AFTER we know the selected character (fix: Options always fell back to follone on load)
    bootPet();

    // UI mode
    schoolMode = !!obj.follone_ui_schoolMode;
    applyUiMode();

    // defaults snapshot (for "diff" display). If missing, set once.
    if (!obj.follone_defaults_snapshot) {
      const snap = {
        master: null,
        characterId: app.data.characterId,
        equippedHead: app.data.equippedHead,
        createdAt: Date.now()
      };
      // we store master after it's built below
      chrome.storage.local.set({ follone_defaults_snapshot: snap });
    }

    // master toggles (keys may exist or default to true)
    app.data.master = {
      enabled: (obj.follone_enabled !== undefined) ? !!obj.follone_enabled : true,
      analyze: (obj.follone_master_analyze !== undefined) ? !!obj.follone_master_analyze : true,
      intervene: (obj.follone_master_intervene !== undefined) ? !!obj.follone_master_intervene : true,
      display: (obj.follone_master_display !== undefined) ? !!obj.follone_master_display : true,
    };

    // if snapshot exists but master is null, fill it once
    try {
      const snap = obj.follone_defaults_snapshot;
      if (snap && snap.master == null) {
        snap.master = { ...app.data.master };
        chrome.storage.local.set({ follone_defaults_snapshot: snap });
      }
    } catch (_) {}

    // fill snapshot master if it was created without it
    try {
      const snap = obj.follone_defaults_snapshot;
      if (snap && !snap.master) {
        snap.master = { ...app.data.master };
        chrome.storage.local.set({ follone_defaults_snapshot: snap });
      }
    } catch (_) {}

    // backend (best-effort; keys may differ across builds)
    const backend = {
      state: obj.follone_backend_availability ?? obj.follone_backend_state ?? obj.backend_availability ?? 'unavailable',
      session: obj.follone_backend_session ?? obj.backend_session ?? '--',
      latency: obj.follone_backend_latencyAvg ?? obj.backend_latencyAvg ?? obj.backend_latency ?? '--',
      lastError: obj.follone_backend_lastError ?? obj.backend_lastError ?? '--'
    };
    app.data.backend = backend;

    // light log
    app.data.lightLog = obj.follone_lightLog_v1 || {};


    if (dom.selHead) dom.selHead.value = app.data.equippedHead ? app.data.equippedHead : 'none';

    renderProgress();
      renderDev();
    if (app.data.quest) renderQuest();
    renderBias();
      renderDev(); // updates right card summary too

    updateGlance();
    updateDiffText();

    renderDev();
    bindDev();

    // Log refresh (Spotlight reasons)
    const btnRefreshLog = document.getElementById('btnRefreshLog');
    if (btnRefreshLog) {
      btnRefreshLog.addEventListener('click', async () => {
        try {
          const obj = await chrome.storage.local.get(['follone_lightLog_v1']);
          app.data.lightLog = Array.isArray(obj.follone_lightLog_v1) ? obj.follone_lightLog_v1 : [];
          renderLog();
        } catch (e) {
          console.warn('[options] refresh log failed', e);
        }
      });
    }

    bindStorageListener();

    // Safety net: some environments don't fire onChanged reliably while Options is open.
    // Poll lightweight keys so Bias chart + summaries stay in sync with Overlay.
    let lastBiasJson = '';
    setInterval(async () => {
      try {
        const obj = await chrome.storage.local.get([BIAS_STORAGE_KEY]);
        const next = obj[BIAS_STORAGE_KEY] || null;
        const json = next ? JSON.stringify(next) : '';
        if (json && json !== lastBiasJson) {
          lastBiasJson = json;
          app.data.biasAgg = next;
          renderBias();
          renderDev(); // updates side summaries too
        }
      } catch (_) {}
    }, 2500);

    // Keep charts crisp on resize (rerender if bias view)
    window.addEventListener('resize', () => {
      if (app.view === 'bias') renderBias();
    });
  }

  init().catch(err => {
    console.warn('[options] init failed', err);
  });
})();