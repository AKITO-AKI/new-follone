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

    topicWindow: 30,
    bubbleDominance: 0.62,
    bubbleEntropy: 0.55,
    bubbleCooldownMs: 10 * 60 * 1000,
    bubbleMinSamples: 16,
    bubbleUseLLM: true,

    reportMinSeconds: 60,
    inactiveSuggestSeconds: 180,
    inactiveCooldownMs: 10 * 60 * 1000,

    topics: FALLBACK_TOPICS.slice()
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
      "follone_logLevel"
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

    topicHistory: [],
    lastBubbleTs: 0,

    sessionStartMs: Date.now(),
    riskCount: 0,
    topicCounts: new Map()
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
  function addXp(amount) {
    chrome.runtime.sendMessage({ type: "FOLLONE_ADD_XP", amount: Number(amount) || 0 }, () => {});
  }
  function openOptions() {
    chrome.runtime.sendMessage({ type: "FOLLONE_OPEN_OPTIONS" }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        window.open(chrome.runtime.getURL("options.html"), "_blank", "noopener,noreferrer");
      }
    });
  }
  function openXSearch(q) {
    const url = `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=top`;
    window.open(url, "_blank", "noopener,noreferrer");
  }
  function lockScroll(lock) {
    const html = document.documentElement;
    const body = document.body;
    if (lock) {
      html.dataset.follonePrevOverflow = html.style.overflow || "";
      body.dataset.follonePrevOverflow = body.style.overflow || "";
      html.style.overflow = "hidden";
      body.style.overflow = "hidden";
    } else {
      html.style.overflow = html.dataset.follonePrevOverflow || "";
      body.style.overflow = body.dataset.follonePrevOverflow || "";
      delete html.dataset.follonePrevOverflow;
      delete body.dataset.follonePrevOverflow;
    }
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

    w.querySelector("#follone-start").addEventListener("click", async () => {
      await ensureBackend(true);
      renderWidget();
      scheduleProcess();
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
        const b = await chrome.runtime.sendMessage({ type: "FOLLONE_BACKEND_STATUS" });
        if (b && b.ok) {
          parts.push(`offscreen:${String(b.availability || "-")}/${String(b.status || "-")}`);
        } else {
          parts.push(`offscreen:na`);
        }
      } catch (e) {
        parts.push(`offscreen:err`);
      }

      parts.push(`backend:${state.sessionStatus}`);
      if (meta) meta.textContent = parts.join(" / ");
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

    let sub = `${enabled} / AI:${backendLabel} / mode:${settings.aiMode}`;
    if (state.sessionStatus === "downloading") sub = `モデルDL中… ${enabled}`;
    setSub(sub);

    if (meta) {
      meta.textContent = `可視tweetのみ / batch:${settings.batchSize} / idle:${settings.idleMs}ms / session:${sec}s`;
    }
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

    // auto: Ask SW/offscreen backend (extension origin) for status.
    try {
      const resp = await chrome.runtime.sendMessage({ type: "FOLLONE_BACKEND_STATUS" });
      if (resp && resp.ok) {
        // Map backend states into UI states
        const a = String(resp.availability || "");
        const s = String(resp.status || "");
        if (a === "available" && (s === "ready" || resp.hasSession)) {
          state.sessionStatus = "ready";
          log("info","[BACKEND]","sw/offscreen ready", resp);
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
      }
    } catch (e) {
      log("warn","[BACKEND]","backend status failed", String(e));
    }

    // Fallback
    state.sessionStatus = "mock";
    return true;
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

    return { id, text, meta, elem: article };
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
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              riskScore: { type: "integer", minimum: 0, maximum: 100 },
              riskCategory: { type: "string", enum: RISK_ENUM },
              topicCategory: { type: "string", enum: topicList },
              summary: { type: "string" },
              explanation: { type: "string" },
              suggestedSearches: { type: "array", maxItems: 3, items: { type: "string" } }
            },
            required: ["id", "riskScore", "riskCategory", "topicCategory", "summary", "explanation", "suggestedSearches"],
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
      "次のX投稿（複数）について「危険カテゴリ」「危険度」「トピックカテゴリ」を判定し、説明と安全な検索誘導を作る。",
      `危険カテゴリ: ${RISK_ENUM.join(" / ")}`,
      "危険度: 0〜100（高いほど危険）",
      `トピックカテゴリ: ${topicList.join(" / ")}`,
      "制約: 出力はJSONのみ（responseConstraintに合致）。余計な文は出さない。",
      "summary: 100文字目安。罵倒/差別語/露骨な性的表現をそのまま再掲せず、言い換える。",
      "explanation: なぜ注意か、どう行動するとよいかを説明重視で。断定しすぎず可能性として述べる。",
      "suggestedSearches: X内検索に使える安全で中立な語句を最大3つ。学習/検証/別視点を促す。"
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

    const summary = sanitizeForSummary(t);
    const explanation = riskCategory === "なし"
      ? "大きな危険サインは薄め。気になる点があれば、一次情報や別ソースも見てね。"
      : "断定はできないけど、刺激が強い/偏りやすい要素が見える。見続けるなら距離感を保って、別視点も混ぜて。";

    const suggestedSearches = buildMockSearches(riskCategory);

    return {
      id: String(post.id),
      riskScore: score,
      riskCategory,
      topicCategory: topic,
      summary,
      explanation,
      suggestedSearches
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
        const resp = await chrome.runtime.sendMessage({
          type: "FOLLONE_CLASSIFY_BATCH",
          batch,
          topicList: settings.topics
        });
        if (resp && resp.ok && Array.isArray(resp.results)) {
          state.sessionStatus = "ready";
          return resp.results;
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

    const countsMap = new Map();
    for (const c of hist) countsMap.set(c, (countsMap.get(c) || 0) + 1);

    let topCat = null;
    let topN = 0;
    const counts = [];
    for (const [k, v] of countsMap.entries()) {
      counts.push(v);
      if (v > topN) { topN = v; topCat = k; }
    }

    const dominance = topN / hist.length;
    const ent = normalizedEntropy(counts, hist.length);
    const trigger = (dominance >= settings.bubbleDominance) || (ent <= settings.bubbleEntropy);
    if (!trigger) return;

    state.lastBubbleTs = now;
    log("info","[BUBBLE]","trigger", { topCat, dominance, entropy: ent, samples: hist.length });

    // If Prompt API is available, we could do nicer suggestions. If not, use underrepresented topics.
    let suggestions = pickUnderrepresentedTopics(3);
    if (state.sessionStatus === "ready" && state.session && settings.bubbleUseLLM) {
      // Still keep costs low: do not call extra prompt unless user enables bubbleUseLLM.
      suggestions = await suggestSearchesLLM(topCat || "最近の話題", suggestions);
    }

    showBubbleCard(topCat || "最近の話題", dominance, ent, suggestions.slice(0, 3));
    addXp(2);
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
    const ov = document.getElementById("follone-overlay");
    const text = document.getElementById("follone-ov-text");
    const badge = document.getElementById("follone-ov-badge");
    const muted = document.getElementById("follone-ov-muted");
    if (!ov || !text || !badge || !muted) return;

    const score = Number(res.riskScore || 0);
    const cat = String(res.riskCategory || "なし");
    const sev = severityFor(score);

    badge.textContent = `${cat} / ${score}`;

    const searches = Array.isArray(res.suggestedSearches) ? res.suggestedSearches.slice(0, 3) : [];
    const searchLine = searches.length ? `検索候補: ${searches.map(s => `「${s}」`).join("、")}` : "検索候補:（なし）";

    text.innerHTML = `
      <div style="font-weight:900; margin-bottom:8px;">…ちょい待って。ここ、気になる匂いがする。</div>
      <div style="margin-bottom:10px;">${escapeHtml(res.explanation || "")}</div>
      <div style="opacity:0.9; padding:10px 12px; border-radius:12px; background:rgba(255,255,255,0.08);">
        <div style="font-weight:900;">要約</div>
        <div style="margin-top:4px;">${escapeHtml(res.summary || "")}</div>
      </div>
    `;
    muted.textContent = `${searchLine}（誘導先はX内検索）`;

    const backBtn = document.getElementById("follone-ov-back");
    const searchBtn = document.getElementById("follone-ov-search");
    const contBtn = document.getElementById("follone-ov-continue");

    const close = () => {
      ov.style.display = "none";
      lockScroll(false);
    };

    backBtn.onclick = () => {
      elem.style.filter = "blur(8px)";
      elem.style.pointerEvents = "none";
      close();
      addXp(xpForIntervention(sev));
      window.scrollBy({ top: -Math.min(900, window.innerHeight), behavior: "smooth" });
    };

    searchBtn.onclick = () => {
      close();
      addXp(xpForIntervention(sev) + 2);
      const q = searches[0] || "別の視点";
      openXSearch(q);
    };

    contBtn.onclick = () => {
      close();
      addXp(1);
    };

    ov.style.display = "block";
    if (sev === "hard") lockScroll(true);
  }

  // -----------------------------
  // Processing loop
  // -----------------------------
  function enqueue(post) {
    if (!post || !post.id) return;
    if (state.riskCache.has(post.id)) return;
    state.queue.push(post);
    state.elemById.set(post.id, post.elem);
  }

  function scheduleProcess() {
    if (state.inFlight) return;
    const wait = Math.max(0, settings.idleMs - (Date.now() - state.lastScrollTs));
    setTimeout(processQueue, wait);
  }

  async function processQueue() {
    log("debug","[PROCESS]","tick", { enabled: settings.enabled, inFlight: state.inFlight, queue: state.queue.length, status: state.sessionStatus });
    if (!settings.enabled) return;
    if (state.inFlight) return;

    if (Date.now() - state.lastScrollTs < settings.idleMs) {
      scheduleProcess();
      return;
    }

    // Ensure backend in auto/mock
    await ensureBackend(false);
    renderWidget();

    if (state.sessionStatus === "off") return;

    const batch = [];
    while (batch.length < settings.batchSize && state.queue.length) {
      const p = state.queue.shift();
      if (!p) continue;
      if (state.riskCache.has(p.id)) continue;
      batch.push(p);
    }
    if (!batch.length) return;

    state.inFlight = true;
    try {
      log("info","[CLASSIFY]","batch", batch.map(x=>x.id));
      const results = await classifyBatch(batch);
      log("info","[CLASSIFY]","results", results.map(x=>({id:x.id, risk:x.riskScore, cat:x.riskCategory, topic:x.topicCategory})));
      for (const r of results) {
        if (!r || !r.id) continue;
        state.riskCache.set(r.id, r);

        const elem = state.elemById.get(r.id);
        if (!elem) continue;

        const topic = String(r.topicCategory || "その他");
        updateTopicStats(topic);

        const score = Number(r.riskScore || 0);
        const cat = String(r.riskCategory || "なし");
        const sev = severityFor(score);

        if (cat !== "なし" && sev !== "none") {
          log("warn","[INTERVENE]","show", { id: r.id, cat, score, sev, backend: state.sessionStatus });
          elem.classList.add("follone-danger");
          state.riskCount += 1;
          showIntervention(elem, r);
        }

        await maybeShowFilterBubble();
      }
    } catch (_e) {
      log("error","[BACKEND]","create() failed -> mock", String(_e));
      // ignore errors to avoid breaking timeline
    } finally {
      state.inFlight = false;
      if (state.queue.length) scheduleProcess();
    }
  }

  // -----------------------------
  // Inactive report suggestion
  // -----------------------------
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
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const article = e.target;
        if (state.processed.has(article)) continue;
        state.processed.add(article);

        setTimeout(() => {
          log("debug","[OBSERVE]","article visible -> extract");
          const post = extractPostFromArticle(article);
          if (!post) return;
          enqueue(post);
          log("debug","[QUEUE]","enqueue", { id: post.id, q: state.queue.length });
          scheduleProcess();
        }, 350);
      }
    }, { root: null, threshold: 0.55 });

    const attach = () => {
      for (const a of findTweetArticles()) {
        if (state.processed.has(a)) continue;
        io.observe(a);
      }
    };

    const mo = new MutationObserver(() => attach());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    attach();

    const onUserActivity = () => {
      state.lastScrollTs = Date.now();
      state.lastUserActivityTs = Date.now();
    };

    window.addEventListener("scroll", onUserActivity, { passive: true });
    window.addEventListener("mousemove", onUserActivity, { passive: true });
    window.addEventListener("keydown", onUserActivity, { passive: true });
    window.addEventListener("pointerdown", onUserActivity, { passive: true });

    setInterval(maybeSuggestInactiveReport, 2000);
  }

  // -----------------------------
  // Boot
  // -----------------------------
  (async () => {
    await loadSettings();
    log("info","[SETTINGS]","loaded", { enabled: settings.enabled, aiMode: settings.aiMode, debug: settings.debug, logLevel: settings.logLevel, batchSize: settings.batchSize, idleMs: settings.idleMs });
    mountUI();
    chrome.runtime.sendMessage({ type: "FOLLONE_PING" }, (res) => {
      if (chrome.runtime.lastError) {
        log("warn","[SW]","ping failed", chrome.runtime.lastError.message);
      } else {
        log("info","[SW]","ping", res);
      }
    });
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
