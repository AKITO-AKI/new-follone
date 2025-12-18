// follone content script (MV3)
// Notes:
// - This file intentionally avoids unusual invisible characters.
// - If your editor shows "invalid character", delete/re-download this file and ensure UTF-8.

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

  // Prompt API language options (prevents "No output language" warnings)
  const LM_OPTIONS = {
    expectedInputs: [{ type: "text", languages: ["ja", "en"] }],
    expectedOutputs: [{ type: "text", languages: ["ja"] }]
  };

  // Structured output schema for classification
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

  // -----------------------------
  // Settings
  // -----------------------------
  const settings = {
    enabled: true,
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
      "follone_topics"
    ]);

    if (cur.follone_enabled !== undefined) settings.enabled = !!cur.follone_enabled;
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
    sessionStatus: "not_ready", // not_ready | downloading | ready | unavailable
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
      await ensureSession(true);
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
      parts.push(`LanguageModel: ${typeof LanguageModel}`);
      if (typeof LanguageModel !== "undefined") {
        try {
          const a = await LanguageModel.availability(LM_OPTIONS);
          parts.push(`availability: ${a}`);
        } catch (e) {
          parts.push(`availability error: ${String(e)}`);
        }
      }
      parts.push(`userActivation: ${navigator.userActivation?.isActive ? "active" : "inactive"}`);
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
    let sub = `${enabled} / soft:${settings.riskSoft} hard:${settings.riskHard}`;

    if (state.sessionStatus === "downloading") sub = `モデルDL中… ${enabled}`;
    if (state.sessionStatus === "ready") sub = `起動中 ${enabled}`;
    if (state.sessionStatus === "unavailable") sub = `利用不可（環境要件）`;
    if (state.sessionStatus === "not_ready") sub = `起動待ち ${enabled}`;

    setSub(sub);

    if (meta) {
      const sec = Math.floor((Date.now() - state.sessionStartMs) / 1000);
      meta.textContent = `可視tweetのみ / batch:${settings.batchSize} / idle:${settings.idleMs}ms / session:${sec}s`;
    }
  }

  // -----------------------------
  // Prompt API session
  // -----------------------------
  async function ensureSession(userInitiated) {
    if (state.session) return true;

    if (typeof LanguageModel === "undefined") {
      state.sessionStatus = "unavailable";
      return false;
    }

    let availability = "unavailable";
    try {
      availability = await LanguageModel.availability(LM_OPTIONS);
    } catch (_e) {
      availability = "unavailable";
    }

    if (availability === "unavailable") {
      state.sessionStatus = "unavailable";
      return false;
    }

    // avoid auto-starting download without user action
    if ((availability === "downloadable" || availability === "downloading") && !userInitiated) {
      state.sessionStatus = "not_ready";
      return false;
    }

    try {
      state.sessionStatus = availability === "downloading" ? "downloading" : "not_ready";
      renderWidget();

      // Must be under user activation in many setups.
      state.session = await LanguageModel.create({
        ...LM_OPTIONS,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            state.sessionStatus = "downloading";
            const pct = Math.round((e.loaded || 0) * 100);
            setSub(`モデルDL中… ${pct}% / ${settings.enabled ? "ON" : "OFF"}`);
          });
        }
      });

      state.sessionStatus = "ready";
      renderWidget();
      return true;
    } catch (_e) {
      state.sessionStatus = "unavailable";
      renderWidget();
      return false;
    }
  }

  // -----------------------------
  // Tweet extraction
  // -----------------------------
  function findTweetArticles() {
    // X DOM changes frequently; use broad + safe selectors.
    const list = Array.from(document.querySelectorAll('article[data-testid="tweet"], article'));
    return list;
  }

  function extractPostFromArticle(article) {
    // Find status ID
    const anchors = Array.from(article.querySelectorAll('a[href*="/status/"]'));
    const a = anchors.find(x => /\/status\/\d+/.test(x.getAttribute("href") || "")) || anchors[0];
    if (!a) return null;

    const href = a.getAttribute("href") || "";
    const m = href.match(/\/status\/(\d+)/);
    if (!m) return null;
    const id = m[1];

    // Collect tweetText nodes (for quotes there can be multiple)
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
      // Media-only posts sometimes have no tweetText. Use alt text if present.
      const imgs = Array.from(article.querySelectorAll("img[alt]")).map(x => (x.getAttribute("alt") || "").trim()).filter(Boolean);
      if (imgs.length) text = `【画像】${imgs.slice(0, 2).join(" / ")}`;
      else text = "【本文なし（メディア投稿の可能性）】";
    }

    // meta - user handle if available
    let handle = "";
    const userNameEl = article.querySelector('div[data-testid="User-Name"] a[href^="/"]');
    if (userNameEl) handle = (userNameEl.getAttribute("href") || "").replace("/", "").trim();
    const meta = `@${handle || "unknown"}`;

    return { id, text, meta, elem: article };
  }

  // -----------------------------
  // Classification prompt
  // -----------------------------
  function buildClassifyPrompt(batch, topicList) {
    const persona = "あなたは「ふぉろね（follone）」です。少し気怠そうだがユーザーには優しく、介入時は説明重視。";
    const rules = [
      "次のX投稿（複数）について「危険カテゴリ」「危険度」「トピックカテゴリ」を判定し、説明と安全な検索誘導を作る。",
      `危険カテゴリ: ${RISK_ENUM.join(" / ")}`,
      "危険度: 0〜100（高いほど危険）",
      `トピックカテゴリ: ${topicList.join(" / ")}`,
      "制約: 出力はJSONのみ（responseConstraintに合致）。余計な文は出さない。",
      "summary: 100文字目安。差別語・罵倒語・露骨な性的表現はそのまま再掲せず、言い換える。",
      "explanation: なぜ注意か、どう行動するとよいかを説明重視で。断定しすぎず、可能性として述べる。",
      "suggestedSearches: X内検索に使える安全で中立な語句を最大3つ。学習/検証/別視点を促す。"
    ].join("\n");

    const payload = batch.map(p => `ID:${p.id}\nTEXT:${p.text}\nMETA:${p.meta}`).join("\n\n---\n\n");
    return `${persona}\n${rules}\n\n${payload}`;
  }

  async function classifyBatch(batch) {
    if (!state.session) return [];
    const topicList = settings.topics.length ? settings.topics : FALLBACK_TOPICS;
    const schema = buildSchema(topicList);
    const prompt = buildClassifyPrompt(batch, topicList);

    // The prompt call should inherit LM_OPTIONS (languages).
    const raw = await state.session.prompt(prompt, { responseConstraint: schema });
    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch (_e) {
      return [];
    }
    const results = Array.isArray(obj && obj.results) ? obj.results : [];
    return results;
  }

  // -----------------------------
  // Bubble detection
  // -----------------------------
  function normalizedEntropy(counts, total) {
    // entropy in [0,1] (1 = uniform)
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

    // Trigger when too concentrated:
    // - dominance high, or
    // - entropy low
    const trigger = (dominance >= settings.bubbleDominance) || (ent <= settings.bubbleEntropy);
    if (!trigger) return;

    state.lastBubbleTs = now;

    const others = (settings.topics.length ? settings.topics : FALLBACK_TOPICS).filter(c => c !== topCat);
    const fallback = others.slice(0, 3);

    let suggestions = fallback;
    if (settings.bubbleUseLLM && state.session) {
      suggestions = await suggestSearchesLLM(topCat, fallback);
    }

    showBubbleCard(topCat || "最近の話題", dominance, ent, suggestions.slice(0, 3));
    addXp(2);
  }

  async function suggestSearchesLLM(topCat, fallback) {
    try {
      const schema = {
        type: "object",
        properties: {
          queries: { type: "array", maxItems: 3, items: { type: "string" } }
        },
        required: ["queries"],
        additionalProperties: false
      };

      const prompt = [
        "あなたは「ふぉろね（follone）」です。説明重視だが短く。",
        "X内検索に使う、偏りをほぐすための安全で中立な検索語句を3つ提案してください。",
        `偏りが強いカテゴリ: ${topCat}`,
        `フォールバック候補: ${fallback.join(" / ")}`,
        "制約: 誹謗中傷や差別を助長する語は避ける。成人向けの露骨語も避ける。学習/検証/別視点を促す。",
        "出力はJSONのみ。"
      ].join("\n");

      const raw = await state.session.prompt(prompt, { responseConstraint: schema });
      const obj = JSON.parse(raw);
      const qs = Array.isArray(obj && obj.queries) ? obj.queries : [];
      const cleaned = qs.map(s => String(s).trim()).filter(Boolean).slice(0, 3);
      return cleaned.length ? cleaned : fallback;
    } catch (_e) {
      return fallback;
    }
  }

  function showBubbleCard(topCat, dominance, ent, suggestions) {
    const body = document.getElementById("follone-body");
    if (!body) return;

    // Replace previous bubble card
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
        偏りは悪じゃないけど、情報の精度を上げるなら別ジャンルを少し混ぜとこ。
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

  function showIntervention(post, res) {
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

    // Explanation-heavy message, but still readable.
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
      post.elem.style.filter = "blur(8px)";
      post.elem.style.pointerEvents = "none";
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
    if (!settings.enabled) return;
    if (state.inFlight) return;

    if (Date.now() - state.lastScrollTs < settings.idleMs) {
      scheduleProcess();
      return;
    }

    // session must be created via user click
    if (!state.session) return;

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
      const results = await classifyBatch(batch);
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
          elem.classList.add("follone-danger");
          state.riskCount += 1;
          showIntervention({ id: r.id, elem }, r);
        }

        await maybeShowFilterBubble();
      }
    } catch (_e) {
      // ignore errors to avoid breaking timeline
    } finally {
      state.inFlight = false;
      if (state.queue.length) scheduleProcess();
    }
  }

  // -----------------------------
  // Session report (minimal)
  // -----------------------------
  function sessionSeconds() {
    return Math.floor((Date.now() - state.sessionStartMs) / 1000);
  }

  function buildReportText() {
    const sec = sessionSeconds();
    if (sec < settings.reportMinSeconds) {
      return `まだ${settings.reportMinSeconds}秒未満だよ。もう少し見てからの方が、ちゃんと役に立つレポートになる。`;
    }

    // Top 3 topics from topicCounts
    const entries = Array.from(state.topicCounts.entries()).sort((a, b) => b[1] - a[1]);
    const top3 = entries.slice(0, 3).map(([k, v]) => `${k}:${v}`).join(" / ") || "（未集計）";
    return [
      "今日のミニレポートだよ。",
      `閲覧時間: ${sec}秒`,
      `危険判定の介入回数: ${state.riskCount}`,
      `上位トピック: ${top3}`,
      "偏りが出たら、たまに別ジャンルも混ぜると情報の精度が上がるよ。"
    ].join("\n");
  }

  function maybeSuggestInactiveReport() {
    if (!state.session) return;
    const now = Date.now();
    const inactiveMs = now - state.lastUserActivityTs;
    if (inactiveMs < settings.inactiveSuggestSeconds * 1000) return;
    if (now - state.lastInactiveSuggestTs < settings.inactiveCooldownMs) return;

    state.lastInactiveSuggestTs = now;

    const body = document.getElementById("follone-body");
    if (!body) return;

    // Replace prior suggestion
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
          const post = extractPostFromArticle(article);
          if (!post) return;
          enqueue(post);
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
    mountUI();
    renderWidget();
    startObservers();

    // Show availability without triggering download
    try {
      if (typeof LanguageModel === "undefined") {
        state.sessionStatus = "unavailable";
      } else {
        const a = await LanguageModel.availability(LM_OPTIONS);
        state.sessionStatus = a === "unavailable" ? "unavailable" : "not_ready";
      }
    } catch (_e) {
      state.sessionStatus = "unavailable";
    }
    renderWidget();
  })();
})();
