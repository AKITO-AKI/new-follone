(() => {
  // Prevent multiple follone copies (different extension IDs) from running at once on the same page.
  try {
    const key = "folloneActiveVersion";
    const root = document.documentElement;
    const prev = root.dataset[key];
    if (prev) return;
    root.dataset[key] = "0.4.2";
  } catch (_) {}

  const IS_X = /(^|\.)x\.com$/i.test(location.hostname) || /(^|\.)twitter\.com$/i.test(location.hostname);
  if (!IS_X) return;

  // ----------------------------
  // Topic taxonomy (default 20)
  // ----------------------------
  const TOPIC_CATEGORIES = [
    "社会", "政治", "経済", "国際", "テック", "科学", "教育", "健康",
    "スポーツ", "エンタメ", "音楽", "映画/アニメ", "ゲーム", "趣味",
    "創作", "生活", "旅行", "歴史", "ビジネス", "その他"
  ];

  // Seed queries (fallback) – neutral, viewpoint-diversifying, safe
  const TOPIC_SEEDS = {
    "社会": ["一次情報 まとめ", "統計 データ", "現場 取材"],
    "政治": ["政策 解説 仕組み", "一次資料 公式 発表", "ファクトチェック 方法"],
    "経済": ["指標 解説", "統計 データ", "景気 指標 まとめ"],
    "国際": ["現地 報道", "公式発表 まとめ", "背景 解説"],
    "テック": ["技術 解説", "仕様 まとめ", "セキュリティ 注意点"],
    "科学": ["研究 解説", "査読 論文 まとめ", "根拠 データ"],
    "教育": ["学習法 まとめ", "教材 おすすめ", "受験 情報"],
    "健康": ["医療 機関 解説", "根拠 研究", "相談 目安"],
    "スポーツ": ["試合 ハイライト", "戦術 解説", "選手 インタビュー"],
    "エンタメ": ["作品 評価", "制作 裏話", "新作 情報"],
    "音楽": ["レビュー", "ライブ レポ", "プレイリスト"],
    "映画/アニメ": ["考察", "レビュー", "制作 まとめ"],
    "ゲーム": ["攻略 初心者", "開発 インタビュー", "レビュー"],
    "趣味": ["入門", "道具 おすすめ", "コミュニティ"],
    "創作": ["作品 制作術", "アイデア 発想", "レビュー 依頼"],
    "生活": ["節約", "家事 コツ", "便利グッズ"],
    "旅行": ["モデルコース", "注意点", "現地情報"],
    "歴史": ["史料", "時代 解説", "年表"],
    "ビジネス": ["事例", "分析", "キャリア"],
    "その他": ["別の視点", "初心者向け", "まとめ"]
  };

  // ----------------------------
  // Risk categories
  // ----------------------------
  const RISK_ENUM = ["誹謗中傷", "政治", "偏見", "差別", "詐欺", "成人向け", "なし"];

  // Prompt API language/modality options (keep consistent across availability/create)
  const LM_OPTIONS = {
    expectedInputs: [
      { type: "text", languages: ["ja", "en"] }
    ],
    expectedOutputs: [
      { type: "text", languages: ["ja"] }
    ]
  };

  // ----------------------------
  // Structured output schemas
  // ----------------------------
  const CLASSIFY_SCHEMA = {
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
            topicCategory: { type: "string", enum: TOPIC_CATEGORIES },
            summary: { type: "string" },
            explanation: { type: "string" },
            suggestedSearches: {
              type: "array",
              maxItems: 3,
              items: { type: "string" }
            }
          },
          required: ["id", "riskScore", "riskCategory", "topicCategory", "summary", "explanation", "suggestedSearches"],
          additionalProperties: false
        }
      }
    },
    required: ["results"],
    additionalProperties: false
  };

  const BUBBLE_SUGGEST_SCHEMA = {
    type: "object",
    properties: {
      searches: {
        type: "array",
        maxItems: 3,
        items: { type: "string" }
      },
      note: { type: "string" }
    },
    required: ["searches", "note"],
    additionalProperties: false
  };

  // ----------------------------
  // Settings (loaded from storage)
  // ----------------------------
  const settings = {
    enabled: true,
    riskSoft: 65,
    riskHard: 80,
    batchSize: 3,
    idleMs: 700,
    maxQueue: 30,

    topicWindow: 40,
    bubbleDominance: 0.58,
    bubbleEntropy: 0.55,
    bubbleMinSamples: 18,
    bubbleCooldownMs: 10 * 60 * 1000,
    bubbleUseLLM: true,

    sessionMinSec: 60,
    inactiveSec: 180,
    reportCooldownSec: 600,
    autoReportSuggest: true,

    personaLazyKind: true,
    explainMode: true
  };

  const state = {
    processed: new WeakSet(),
    elemById: new Map(),
    queue: [],
    inFlight: false,
    session: null,
    sessionStatus: "not_ready",
    riskCache: new Map(),

    lastScrollTs: Date.now(),
    lastActivityTs: Date.now(),
    lastReportSuggestTs: 0,

    sessionStartTs: Date.now(),
    topicHistory: [],
    riskCount: 0,
    softWarnCount: 0,
    hardWarnCount: 0,
    bubbleCount: 0,
    lastBubbleTs: 0
  };

  function clamp(n, a, b) {
    n = Number(n);
    if (!Number.isFinite(n)) return a;
    return Math.max(a, Math.min(b, n));
  }

  function now() { return Date.now(); }

  async function loadSettings() {
    const cur = await chrome.storage.local.get([
      "follone_enabled",
      "follone_riskThresholdSoft",
      "follone_riskThresholdHard",
      "follone_batchSize",
      "follone_idleMs",
      "follone_maxQueue",
      "follone_topicWindow",
      "follone_bubbleDominance",
      "follone_bubbleEntropy",
      "follone_bubbleMinSamples",
      "follone_bubbleCooldownMs",
      "follone_bubbleUseLLMSuggest",
      "follone_sessionMinSec",
      "follone_inactiveSec",
      "follone_reportCooldownSec",
      "follone_autoReportSuggest",
      "follone_personaLazyKind",
      "follone_explainMode"
    ]);

    if (cur.follone_enabled !== undefined) settings.enabled = !!cur.follone_enabled;
    if (cur.follone_riskThresholdSoft !== undefined) settings.riskSoft = clamp(cur.follone_riskThresholdSoft, 0, 100);
    if (cur.follone_riskThresholdHard !== undefined) settings.riskHard = clamp(cur.follone_riskThresholdHard, 0, 100);
    if (settings.riskSoft > settings.riskHard) [settings.riskSoft, settings.riskHard] = [settings.riskHard, settings.riskSoft];

    if (cur.follone_batchSize !== undefined) settings.batchSize = clamp(cur.follone_batchSize, 1, 8);
    if (cur.follone_idleMs !== undefined) settings.idleMs = clamp(cur.follone_idleMs, 100, 5000);
    if (cur.follone_maxQueue !== undefined) settings.maxQueue = clamp(cur.follone_maxQueue, 10, 200);

    if (cur.follone_topicWindow !== undefined) settings.topicWindow = clamp(cur.follone_topicWindow, 10, 200);
    if (cur.follone_bubbleDominance !== undefined) settings.bubbleDominance = clamp(cur.follone_bubbleDominance, 0.30, 0.95);
    if (cur.follone_bubbleEntropy !== undefined) settings.bubbleEntropy = clamp(cur.follone_bubbleEntropy, 0.10, 0.99);
    if (cur.follone_bubbleMinSamples !== undefined) settings.bubbleMinSamples = clamp(cur.follone_bubbleMinSamples, 8, 100);
    if (cur.follone_bubbleCooldownMs !== undefined) settings.bubbleCooldownMs = clamp(cur.follone_bubbleCooldownMs, 30_000, 7_200_000);
    if (cur.follone_bubbleUseLLMSuggest !== undefined) settings.bubbleUseLLM = !!cur.follone_bubbleUseLLMSuggest;

    if (cur.follone_sessionMinSec !== undefined) settings.sessionMinSec = clamp(cur.follone_sessionMinSec, 10, 600);
    if (cur.follone_inactiveSec !== undefined) settings.inactiveSec = clamp(cur.follone_inactiveSec, 30, 1800);
    if (cur.follone_reportCooldownSec !== undefined) settings.reportCooldownSec = clamp(cur.follone_reportCooldownSec, 30, 7200);
    if (cur.follone_autoReportSuggest !== undefined) settings.autoReportSuggest = !!cur.follone_autoReportSuggest;

    if (cur.follone_personaLazyKind !== undefined) settings.personaLazyKind = !!cur.follone_personaLazyKind;
    if (cur.follone_explainMode !== undefined) settings.explainMode = !!cur.follone_explainMode;
  }

  chrome.storage.onChanged.addListener((changes) => {
    const map = {
      follone_enabled: "enabled",
      follone_riskThresholdSoft: "riskSoft",
      follone_riskThresholdHard: "riskHard",
      follone_batchSize: "batchSize",
      follone_idleMs: "idleMs",
      follone_maxQueue: "maxQueue",
      follone_topicWindow: "topicWindow",
      follone_bubbleDominance: "bubbleDominance",
      follone_bubbleEntropy: "bubbleEntropy",
      follone_bubbleMinSamples: "bubbleMinSamples",
      follone_bubbleCooldownMs: "bubbleCooldownMs",
      follone_bubbleUseLLMSuggest: "bubbleUseLLM",
      follone_sessionMinSec: "sessionMinSec",
      follone_inactiveSec: "inactiveSec",
      follone_reportCooldownSec: "reportCooldownSec",
      follone_autoReportSuggest: "autoReportSuggest",
      follone_personaLazyKind: "personaLazyKind",
      follone_explainMode: "explainMode"
    };
    for (const [k, v] of Object.entries(changes)) {
      if (!(k in map)) continue;
      settings[map[k]] = v.newValue;
    }
    if (settings.riskSoft > settings.riskHard) [settings.riskSoft, settings.riskHard] = [settings.riskHard, settings.riskSoft];
    renderWidget();
  });

  // ----------------------------
  // UI
  // ----------------------------
  function openOptionsSafe() {
    try {
      chrome.runtime.sendMessage({ type: "FOLLONE_OPEN_OPTIONS" }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          const url = chrome.runtime.getURL("options.html");
          window.open(url, "_blank", "noopener,noreferrer");
        }
      });
    } catch (_e) {
      const url = chrome.runtime.getURL("options.html");
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  
  async function runDiagnostics() {
    const lines = [];
    const uaActive = !!(navigator.userActivation && navigator.userActivation.isActive);
    lines.push(`userActivation: ${uaActive ? "active" : "inactive"}`);
    lines.push(`LanguageModel: ${typeof LanguageModel}`);

    if (typeof LanguageModel !== "undefined") {
      try {
        const a = await LanguageModel.availability(LM_OPTIONS);
        lines.push(`availability: ${a}`);
      } catch (e) {
        lines.push(`availability error: ${e?.name || e}`);
      }
    }

    lines.push("hint: X側のFedCM/GraphQL/Install-banner系ログはサイト由来で、Prompt APIとは無関係。");
    lines.push("hint: unavailable の場合は chrome://flags で optimization-guide-on-device-model と prompt-api-for-gemini-nano を有効化し、chrome://on-device-internals の Model Status を確認。");

    const el = document.getElementById("follone-diag");
    if (el) el.textContent = lines.join("\n");
  }

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
          <div id="follone-greet"></div>
          <div class="row">
            <button id="follone-start">AI開始</button>
            <button id="follone-toggle" class="secondary">ON/OFF</button>
          </div>
          <div class="row">
            <button id="follone-report-btn" class="secondary">レポート</button>
            <button id="follone-end-btn" class="secondary">セッション終了</button>
          </div>
          <div class="row">
            <button id="follone-settings-btn" class="secondary">設定</button>
            <button id="follone-diag-btn" class="secondary">診断</button>
          </div>
          <div class="meta" id="follone-meta"></div>
          <div class="meta" id="follone-diag"></div>
          <div id="follone-pills"></div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(w);

    const overlay = document.createElement("div");
    overlay.id = "follone-overlay";
    overlay.innerHTML = `
      <div class="card">
        <div class="cardHeader">
          <div class="avatar"></div>
          <div>
            <div class="title">follone</div>
            <div class="sub" id="follone-ov-sub">ちょい待って</div>
          </div>
          <div class="badge" id="follone-ov-badge">注意</div>
        </div>
        <div class="cardBody">
          <div id="follone-ov-text"></div>
          <div class="muted" id="follone-ov-muted"></div>
        </div>
        <div class="actions">
          <button id="follone-ov-back">戻る</button>
          <button id="follone-ov-search">検索へ</button>
          <button id="follone-ov-continue">表示する</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(overlay);

    const report = document.createElement("div");
    report.id = "follone-report";
    report.innerHTML = `
      <div class="card">
        <div class="cardHeader">
          <div class="avatar"></div>
          <div>
            <div class="title">follone</div>
            <div class="sub">ミニレポート</div>
          </div>
          <div class="badge" id="follone-report-badge">session</div>
        </div>
        <div class="grid" id="follone-report-grid"></div>
        <div class="actions">
          <button id="follone-report-close" class="secondary">閉じる</button>
          <button id="follone-report-end">ここで終了</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(report);

    // bind
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

    w.querySelector("#follone-report-btn").addEventListener("click", () => openReport(false));
    w.querySelector("#follone-end-btn").addEventListener("click", () => openReport(true));

    w.querySelector("#follone-settings-btn").addEventListener("click", openOptionsSafe);
    w.querySelector("#follone-diag-btn").addEventListener("click", runDiagnostics);

    document.getElementById("follone-report-close").addEventListener("click", closeReport);
    document.getElementById("follone-report-end").addEventListener("click", () => {
      closeReport();
      endSession(true);
    });

    renderWidget();
  }

  function setSub(text) {
    const el = document.getElementById("follone-sub");
    if (el) el.textContent = text;
  }

  function pill(text) {
    const el = document.createElement("span");
    el.className = "pill";
    el.textContent = text;
    return el;
  }

  async function renderWidget() {
    const greet = document.getElementById("follone-greet");
    if (greet) {
      greet.textContent = settings.personaLazyKind
        ? "こんにちは、ふぉろねだよ～。君と一緒に、タイムライン見ちゃお～。"
        : "こんにちは。folloneです。";
    }

    const st = state.sessionStatus;
    const enabled = settings.enabled ? "ON" : "OFF";
    const soft = settings.riskSoft, hard = settings.riskHard;

    let sub = `${enabled} / 閾値 ${soft}/${hard}`;
    if (st === "downloading") sub = `モデルDL中… / ${enabled}`;
    if (st === "ready") sub = `起動中 / ${enabled} / ${soft}/${hard}`;
    if (st === "unavailable") sub = `利用不可（Prompt API）`;
    if (st === "not_ready") sub = `起動待ち / ${enabled} / ${soft}/${hard}`;
    setSub(sub);

    const meta = document.getElementById("follone-meta");
    if (meta) {
      const sec = Math.max(0, Math.floor((now() - state.sessionStartTs) / 1000));
      const p = await new Promise((res) => chrome.runtime.sendMessage({ type: "FOLLONE_GET_PROGRESS" }, res));
      const lv = p?.level ?? 1;
      const xp = p?.xp ?? 0;

      meta.textContent = `可視投稿のみ / batch:${settings.batchSize} / idle:${settings.idleMs}ms / session:${sec}s / Lv:${lv} XP:${xp}`;
    }

    const pills = document.getElementById("follone-pills");
    if (pills) {
      pills.innerHTML = "";
      pills.appendChild(pill(`危険:${state.riskCount}`));
      pills.appendChild(pill(`soft:${state.softWarnCount}`));
      pills.appendChild(pill(`hard:${state.hardWarnCount}`));
      pills.appendChild(pill(`bubble:${state.bubbleCount}`));
    }
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

  function openXSearch(q) {
    const url = `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=top`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function addXp(amount) {
    chrome.runtime.sendMessage({ type: "FOLLONE_ADD_XP", amount });
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showIntervention(post, res, severity) {
    const ov = document.getElementById("follone-overlay");
    const text = document.getElementById("follone-ov-text");
    const badge = document.getElementById("follone-ov-badge");
    const muted = document.getElementById("follone-ov-muted");
    if (!ov || !text || !badge || !muted) return;

    // Restore default labels (bubble overlay may have changed them)
    const backBtn = document.getElementById("follone-ov-back");
    const searchBtn = document.getElementById("follone-ov-search");
    const contBtn = document.getElementById("follone-ov-continue");
    backBtn.textContent = "戻る";
    searchBtn.textContent = "検索へ";
    contBtn.textContent = "表示する";

    const cat = res.riskCategory;
    const score = Number(res.riskScore || 0);
    badge.textContent = `${cat} / ${score}`;

    const searches = (res.suggestedSearches || []).slice(0, 3);
    const searchLine = searches.length ? `検索候補: ${searches.map(s => `「${s}」`).join("、")}` : `検索候補:（なし）`;

    const explain = settings.explainMode
      ? (res.explanation || "ちょい危ない匂いがする。深呼吸して、次の行動だけ一緒に決めよ。")
      : ((res.explanation || "").split("。")[0] || "ちょい危ないかも。");

    const header = settings.personaLazyKind
      ? "…ちょい待って。ここ、気になる匂いがする。"
      : "注意: リスクの可能性があります。";

    text.innerHTML = `
      <div style="font-weight:900; margin-bottom:8px;">${escapeHtml(header)}</div>
      <div style="margin-bottom:10px;">${escapeHtml(explain)}</div>
      <div style="opacity:0.92; padding:10px 12px; border-radius:12px; background:rgba(255,255,255,0.08);">
        <div style="font-weight:900;">要約</div>
        <div style="margin-top:4px;">${escapeHtml(res.summary || "")}</div>
      </div>
    `;

    muted.textContent = `${searchLine}（誘導先はX内検索）`;

    const close = () => {
      ov.style.display = "none";
      lockScroll(false);
    };

    backBtn.onclick = () => {
      post.elem.style.filter = "blur(8px)";
      post.elem.style.pointerEvents = "none";
      close();
      addXp(xpForIntervention(severity));
      window.scrollBy({ top: -Math.min(900, window.innerHeight), behavior: "smooth" });
    };

    searchBtn.onclick = () => {
      close();
      addXp(8);
      const q = searches[0] || "別の視点";
      openXSearch(q);
    };

    contBtn.onclick = () => {
      close();
      addXp(2);
    };

    ov.style.display = "block";
    if (severity === "hard") lockScroll(true);
  }
function xpForIntervention(sev) { return sev === "hard" ? 10 : 6; }

  // ----------------------------
  // Report UI
  // ----------------------------
  function closeReport() {
    const rp = document.getElementById("follone-report");
    if (rp) rp.style.display = "none";
    lockScroll(false);
  }

  function openReport(isEndFlow) {
    const elapsedSec = Math.floor((now() - state.sessionStartTs) / 1000);
    if (elapsedSec < settings.sessionMinSec && !isEndFlow) {
      toast(settings.personaLazyKind
        ? "まだ短いかも。もう少し見てからでもいいよ～。"
        : "セッション時間が短いため、レポートは控えめにします。");
    }
    const rp = document.getElementById("follone-report");
    const grid = document.getElementById("follone-report-grid");
    const badge = document.getElementById("follone-report-badge");
    if (!rp || !grid || !badge) return;

    badge.textContent = `${elapsedSec}s`;

    const topicCounts = countTopics(state.topicHistory);
    const topTopics = Object.entries(topicCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);

    const risk = state.riskCount;
    const soft = state.softWarnCount;
    const hard = state.hardWarnCount;
    const bubble = state.bubbleCount;

    const entropy = normalizedEntropyFromCounts(topicCounts);
    const dom = dominanceFromCounts(topicCounts);

    grid.innerHTML = "";
    grid.appendChild(reportBox("閲覧時間", `<div class="big">${elapsedSec}s</div><div class="muted">無操作提案: ${settings.autoReportSuggest ? "ON" : "OFF"}</div>`));
    grid.appendChild(reportBox("警告", `<div class="big">${risk}</div><div class="muted">soft:${soft} / hard:${hard}</div>`));
    grid.appendChild(reportBox("偏り指標", `<div class="big">${Math.round(dom*100)}%</div><div class="muted">entropy:${entropy.toFixed(2)} / bubble:${bubble}</div>`));
    grid.appendChild(reportBox("上位カテゴリ", `<ol class="list">${topTopics.map(([k,v])=>`<li>${escapeHtml(k)} (${v})</li>`).join("")}</ol>`));

    // mild guidance (non-prescriptive)
    const guidance = buildReportGuidance(dom, entropy, topTopics[0]?.[0]);
    grid.appendChild(reportBox("folloneの一言", `<div>${escapeHtml(guidance)}</div>`));

    rp.style.display = "block";
    lockScroll(true);

    if (isEndFlow) {
      toast(settings.personaLazyKind ? "区切りつける？レポート見てからでもいいよ～。" : "セッション終了しますか。");
    }
  }

  function reportBox(title, innerHtml) {
    const div = document.createElement("div");
    div.className = "box";
    div.innerHTML = `<h3>${escapeHtml(title)}</h3>${innerHtml}`;
    return div;
  }

  function buildReportGuidance(dom, entropy, topCat) {
    if (!topCat) return settings.personaLazyKind ? "今日はのんびりでいいよ。" : "記録が少ないため、総評は控えます。";
    if (dom >= settings.bubbleDominance || entropy <= settings.bubbleEntropy) {
      return settings.personaLazyKind
        ? `最近「${topCat}」が多め。疲れない範囲で、別ジャンルも少し混ぜとくと心がラクかも。`
        : `「${topCat}」への集中が見られます。別ジャンルを少量混ぜると情報の偏りを抑えられます。`;
    }
    return settings.personaLazyKind ? "いい感じに散ってる。バランス良いよ～。" : "カテゴリ分布は概ねバランス良好です。";
  }

  // ----------------------------
  // Toast (small)
  // ----------------------------
  let toastTimer = null;
  function toast(text) {
    let el = document.getElementById("follone-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "follone-toast";
      el.style.position = "fixed";
      el.style.left = "18px";
      el.style.bottom = "18px";
      el.style.zIndex = "2147483647";
      el.style.padding = "10px 12px";
      el.style.borderRadius = "12px";
      el.style.background = "rgba(20, 20, 22, 0.92)";
      el.style.border = "1px solid rgba(255,255,255,0.12)";
      el.style.color = "rgba(255,255,255,0.92)";
      el.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans JP", sans-serif';
      el.style.boxShadow = "0 16px 50px rgba(0,0,0,0.35)";
      el.style.maxWidth = "min(520px, calc(100vw - 36px))";
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    el.style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = "none"; }, 2600);
  }

  // ----------------------------
  // Session / inactivity
  // ----------------------------
  function markActivity() {
    state.lastActivityTs = now();
  }

  function endSession(resetStatsOnly) {
    state.sessionStartTs = now();
    state.topicHistory = [];
    state.riskCount = 0;
    state.softWarnCount = 0;
    state.hardWarnCount = 0;
    state.bubbleCount = 0;
    state.lastBubbleTs = 0;
    state.lastReportSuggestTs = 0;

    if (!resetStatsOnly) {
      state.riskCache.clear();
      state.queue = [];
    }
    renderWidget();
    toast(settings.personaLazyKind ? "おつかれ～。また一緒に見よ。" : "セッションを終了しました。");
  }

  function startInactivityLoop() {
    setInterval(() => {
      if (!settings.autoReportSuggest) return;
      const elapsedSec = Math.floor((now() - state.sessionStartTs) / 1000);
      if (elapsedSec < settings.sessionMinSec) return;

      const inactive = (now() - state.lastActivityTs) / 1000;
      if (inactive < settings.inactiveSec) return;

      const sinceLast = (now() - state.lastReportSuggestTs) / 1000;
      if (sinceLast < settings.reportCooldownSec) return;

      state.lastReportSuggestTs = now();
      toast(settings.personaLazyKind ? "ちょい休憩する？レポート見る？" : "無操作が続いています。レポートを表示しますか。");
      openReport(false);
    }, 1500);
  }

  // ----------------------------
  // Prompt API session
  // ----------------------------
  async function ensureSession(userInitiated) {
    if (state.session) return true;

    if (typeof LanguageModel === "undefined") {
      state.sessionStatus = "unavailable";
      renderWidget();
      return false;
    }

    let availability = "unavailable";
    try { availability = await LanguageModel.availability(LM_OPTIONS); } catch (_e) {}

    if (availability === "unavailable") {
      state.sessionStatus = "unavailable";
      renderWidget();
      return false;
    }

    if ((availability === "downloadable" || availability === "downloading") && !userInitiated) {
      state.sessionStatus = availability === "downloading" ? "downloading" : "not_ready";
      renderWidget();
      return false;
    }

    try {
      state.sessionStatus = (availability === "downloading") ? "downloading" : "not_ready";
      renderWidget();

      state.session = await LanguageModel.create({
        ...LM_OPTIONS,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            state.sessionStatus = "downloading";
            const pct = Math.round((e.loaded || 0) * 100);
            setSub(`モデルDL中… ${pct}
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

  function buildPersonaLine() {
    if (!settings.personaLazyKind) return "あなたは支援アシスタントです。";
    return "あなたは「ふぉろね（follone）」です。少し気怠そうだがユーザーには優しく、介入時は説明重視。";
  }

  function buildClassifyPrompt(batch) {
    // Safety constraints: no explicit adult content, no slur repetition.
    return `
${buildPersonaLine()}
次のX投稿（複数）について「危険カテゴリ」「危険度」「トピックカテゴリ」を判定し、説明と安全な検索誘導を作ってください。

【危険カテゴリ】${RISK_ENUM.join(" / ")}
【危険度】0〜100（高いほど危険）
【トピックカテゴリ】${TOPIC_CATEGORIES.join(" / ")}

制約:
- 出力はresponseConstraint に合致する JSON のみ（余計な文は禁止）
- summaryは日本語で短く（100文字目安）。差別語・罵倒語・露骨な性的表現をそのまま再掲しない（言い換える）
- explanationは「なぜ注意なのか」「どう行動するとよいか」を説明重視で。断定しすぎず、可能性として述べる
- suggestedSearchesは、X内検索に使える安全な語句を最大3つ（中立・学習/検証/別視点のため）
- 投稿の政治的主張に同調/反対の誘導はしない（検証・一次情報・複数視点の提示に留める）

${batch.map(p => `ID:${p.id}\nTEXT:${p.text}\nMETA:${p.meta}`).join("\n\n---\n\n")}
`.trim();
  }

  async function classifyBatch(batch) {
    if (!state.session) return [];
    const prompt = buildClassifyPrompt(batch);
    const raw = await state.session.prompt(prompt, { responseConstraint: CLASSIFY_SCHEMA });
    try {
      const obj = JSON.parse(raw);
      return Array.isArray(obj?.results) ? obj.results : [];
    } catch (_e) {
      return [];
    }
  }

  function buildBubbleSuggestPrompt(context) {
    const { topCat, topRatio, entropy, leastCats } = context;
    return `
${buildPersonaLine()}
ユーザーのタイムラインが特定カテゴリに偏り気味です。
X内検索へ誘導する「安全で中立な検索語句」を最大3つ提案してください。
目的は、別ジャンル/別視点の探索で、政治的誘導や過激な表現は避けます。

状況:
- 最頻カテゴリ: ${topCat}
- 偏り率(dominance): ${(topRatio*100).toFixed(0)}%
- 集中度(entropy): ${entropy.toFixed(2)} (0..1)
- 直近で少ないカテゴリ候補: ${leastCats.join(" / ")}

制約:
- 出力は responseConstraint に合致する JSON のみ
- searches はX検索にそのまま使える語句（短め）
- note はユーザーへの一言（説明重視、落ち着いた口調）

`.trim();
  }

  async function suggestSearchesForBubble(context) {
    // Fallback first
    const least = context.leastCats || [];
    const picks = [];
    for (const c of least.slice(0, 3)) {
      const seed = TOPIC_SEEDS[c]?.[0];
      if (seed) picks.push(seed);
    }
    while (picks.length < 3) picks.push("別の視点 まとめ");

    if (!settings.bubbleUseLLM || !state.session) {
      return { searches: picks.slice(0,3), note: settings.personaLazyKind ? "ちょい違う空気も混ぜとこ。" : "別カテゴリも参照してください。" };
    }

    try {
      const raw = await state.session.prompt(buildBubbleSuggestPrompt(context), { responseConstraint: BUBBLE_SUGGEST_SCHEMA });
      const obj = JSON.parse(raw);
      const searches = Array.isArray(obj.searches) ? obj.searches.slice(0,3) : picks.slice(0,3);
      const note = typeof obj.note === "string" ? obj.note : "";
      return { searches, note: note || (settings.personaLazyKind ? "ちょい違う空気も混ぜとこ。" : "別カテゴリも参照してください。") };
    } catch (_e) {
      return { searches: picks.slice(0,3), note: settings.personaLazyKind ? "ちょい違う空気も混ぜとこ。" : "別カテゴリも参照してください。" };
    }
  }

  // ----------------------------
  // DOM extraction (more robust)
  // ----------------------------
  function findTweetArticles() {
    return Array.from(document.querySelectorAll('article[data-testid="tweet"], article'));
  }

  function extractFromArticle(article) {
    // Prefer status anchors
    const anchors = Array.from(article.querySelectorAll('a[href*="/status/"]'));
    const a = anchors.find(x => /\/status\/\d+/.test(x.getAttribute("href") || "")) || anchors[0];
    if (!a) return null;

    const href = a.getAttribute("href") || "";
    const m = href.match(/\/status\/(\d+)/);
    if (!m) return null;
    const id = m[1];

    // tweet text(s)
    const textEls = Array.from(article.querySelectorAll('div[data-testid="tweetText"]'));
    let parts = [];
    if (textEls.length) {
      // If quote exists, capture up to 2 blocks
      for (let i = 0; i < Math.min(2, textEls.length); i++) {
        const t = (textEls[i].innerText || "").trim();
        if (t) parts.push(i === 0 ? t : `[引用] ${t}`);
      }
    }

    // media-only fallback (alt text)
    if (!parts.length) {
      const imgs = Array.from(article.querySelectorAll('img[alt]'));
      const alts = imgs.map(x => (x.getAttribute("alt") || "").trim()).filter(Boolean);
      if (alts.length) {
        parts.push(`【画像】${alts.slice(0, 2).join(" / ")}`);
      } else {
        const hasVideo = !!article.querySelector('video, div[data-testid="videoPlayer"]');
        if (hasVideo) parts.push("【動画/音声の投稿】");
      }
    }

    const text = parts.join("\n").trim();
    if (!text) return null;

    // meta: handle
    let handle = "";
    const userNameEl = article.querySelector('div[data-testid="User-Name"] a[href^="/"]');
    if (userNameEl) handle = (userNameEl.getAttribute("href") || "").replace("/", "").trim();
    const meta = `@${handle || "unknown"}`;

    return { id, text, meta, elem: article };
  }

  // ----------------------------
  // Queue and processing
  // ----------------------------
  function enqueue(post) {
    if (state.riskCache.has(post.id)) return;
    if (state.queue.length >= settings.maxQueue) state.queue.shift();
    state.queue.push(post);
    state.elemById.set(post.id, post.elem);
  }

  function scheduleProcess() {
    if (state.inFlight) return;
    const wait = Math.max(0, settings.idleMs - (now() - state.lastScrollTs));
    window.setTimeout(processQueue, wait);
  }

  async function processQueue() {
    if (!settings.enabled) return;
    if (state.inFlight) return;

    if (now() - state.lastScrollTs < settings.idleMs) {
      scheduleProcess();
      return;
    }

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
        if (!r?.id) continue;
        state.riskCache.set(r.id, r);

        const elem = state.elemById.get(r.id);
        if (!elem) continue;

        // update topic history
        const topic = r.topicCategory || "その他";
        state.topicHistory.push(topic);
        if (state.topicHistory.length > settings.topicWindow) state.topicHistory.shift();

        // handle risk
        const score = Number(r.riskScore || 0);
        const cat = r.riskCategory || "なし";
        if (cat !== "なし") {
          state.riskCount += 1;

          if (score >= settings.riskHard) {
            state.hardWarnCount += 1;
            elem.classList.add("follone-danger-hard");
            showIntervention({ id: r.id, elem }, r, "hard");
            addXp(3);
          } else if (score >= settings.riskSoft) {
            state.softWarnCount += 1;
            elem.classList.add("follone-danger-soft");
            // soft: no lock, no overlay
            addXp(1);
          }
        }

        // bubble detection (v0.4: dominance + entropy)
        await maybeTriggerBubble();
      }

      renderWidget();
    } catch (_e) {
      // ignore
    } finally {
      state.inFlight = false;
      if (state.queue.length) scheduleProcess();
    }
  }

  function countTopics(arr) {
    const counts = {};
    for (const c of arr) counts[c] = (counts[c] || 0) + 1;
    return counts;
  }

  function dominanceFromCounts(counts) {
    const entries = Object.values(counts);
    const total = entries.reduce((a,b)=>a+b, 0);
    if (!total) return 0;
    const max = entries.reduce((a,b)=>Math.max(a,b), 0);
    return max / total;
  }

  function normalizedEntropyFromCounts(counts) {
    const entries = Object.entries(counts);
    const total = entries.reduce((a,[_k,v])=>a+v, 0);
    const k = entries.length || 1;
    if (!total || k <= 1) return 0;
    let H = 0;
    for (const [_k, v] of entries) {
      const p = v / total;
      H += -p * Math.log(p);
    }
    const Hmax = Math.log(k);
    return Hmax ? (H / Hmax) : 0;
  }

  function leastSeenCategories(counts, n=6) {
    const all = TOPIC_CATEGORIES.slice();
    const pairs = all.map(c => [c, counts[c] || 0]);
    pairs.sort((a,b)=>a[1]-b[1]);
    return pairs.slice(0, n).map(x => x[0]);
  }

  async function maybeTriggerBubble() {
    const t = now();
    if (t - state.lastBubbleTs < settings.bubbleCooldownMs) return;
    if (state.topicHistory.length < settings.bubbleMinSamples) return;

    const counts = countTopics(state.topicHistory);
    const dom = dominanceFromCounts(counts);
    const ent = normalizedEntropyFromCounts(counts);

    const topCat = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || "その他";

    const concentrated = (dom >= settings.bubbleDominance) || (ent <= settings.bubbleEntropy);
    if (!concentrated) return;

    state.lastBubbleTs = t;
    state.bubbleCount += 1;

    const leastCats = leastSeenCategories(counts, 6).filter(c => c !== topCat);
    const ctx = { topCat, topRatio: dom, entropy: ent, leastCats: leastCats.slice(0, 4) };

    const { searches, note } = await suggestSearchesForBubble(ctx);
    showBubbleOverlay(ctx, searches, note);
    addXp(4);
  }

  function showBubbleOverlay(ctx, searches, note) {
    // reuse main overlay UI but with "bubble" badge
    const ov = document.getElementById("follone-overlay");
    const text = document.getElementById("follone-ov-text");
    const badge = document.getElementById("follone-ov-badge");
    const muted = document.getElementById("follone-ov-muted");
    if (!ov || !text || !badge || !muted) return;

    badge.textContent = `偏り検知`;

    const header = settings.personaLazyKind ? "…ねえ。最近、同じ空気が続いてるかも。" : "フィルターバブルの可能性があります。";
    const explain = settings.explainMode
      ? note || `「${ctx.topCat}」が多め。疲れない範囲で別ジャンルも混ぜると、見え方が安定するよ。`
      : (note || "").split("。")[0];

    const lines = searches.slice(0,3).map(s => `「${escapeHtml(s)}」`).join("、");

    text.innerHTML = `
      <div style="font-weight:900; margin-bottom:8px;">${escapeHtml(header)}</div>
      <div style="margin-bottom:10px;">${escapeHtml(explain || "")}</div>
      <div style="opacity:0.92; padding:10px 12px; border-radius:12px; background:rgba(255,255,255,0.08);">
        <div style="font-weight:900;">検索で空気を変える</div>
        <div style="margin-top:6px;">候補: ${lines}</div>
      </div>
    `;

    muted.textContent = `dominance:${Math.round(ctx.topRatio*100)}% / entropy:${ctx.entropy.toFixed(2)} / X内検索へ誘導`;

    const backBtn = document.getElementById("follone-ov-back");
    const searchBtn = document.getElementById("follone-ov-search");
    const contBtn = document.getElementById("follone-ov-continue");

    const close = () => {
      ov.style.display = "none";
      lockScroll(false);
    };

    backBtn.textContent = "閉じる";
    contBtn.textContent = "このまま";
    searchBtn.textContent = "検索へ";

    backBtn.onclick = () => close();
    contBtn.onclick = () => close();
    searchBtn.onclick = () => {
      close();
      openXSearch(searches[0] || "別の視点 まとめ");
    };

    ov.style.display = "block";
    // bubble is advisory: no scroll lock
  }

  // ----------------------------
  // Observers
  // ----------------------------
  function startObservers() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const article = e.target;
        if (state.processed.has(article)) continue;

        state.processed.add(article);
        window.setTimeout(() => {
          const post = extractFromArticle(article);
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

    const activityEvents = ["scroll", "mousemove", "keydown", "touchstart", "click"];
    for (const ev of activityEvents) {
      window.addEventListener(ev, () => { markActivity(); }, { passive: true });
    }
    window.addEventListener("scroll", () => { state.lastScrollTs = now(); }, { passive: true });
  }

  // ----------------------------
  // Boot
  // ----------------------------
  (async () => {
    await loadSettings();
    mountUI();
    startObservers();
    startInactivityLoop();

    // show availability but don't start download until user click
    try {
      if (typeof LanguageModel !== "undefined") {
        const a = await LanguageModel.availability(LM_OPTIONS);
        state.sessionStatus = (a === "unavailable") ? "unavailable" : "not_ready";
      } else {
        state.sessionStatus = "unavailable";
      }
    } catch (_e) {
      state.sessionStatus = "unavailable";
    }
    renderWidget();
  })();
})();
