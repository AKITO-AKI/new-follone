const KEYMAP = {
  enabled: "follone_enabled",
  aiMode: "follone_aiMode",
  riskSoft: "follone_riskSoftThreshold",
  riskHard: "follone_riskHardThreshold",
  batchSize: "follone_batchSize",
  idleMs: "follone_idleMs",
  topicWindow: "follone_topicWindow",
  bubbleMinSamples: "follone_bubbleMinSamples",
  bubbleDominance: "follone_bubbleDominance",
  bubbleEntropy: "follone_bubbleEntropy",
  bubbleCooldownMs: "follone_bubbleCooldownMs",
  bubbleUseLLM: "follone_bubbleUseLLM",
  reportMinSeconds: "follone_reportMinSeconds",
  inactiveSuggestSeconds: "follone_inactiveSuggestSeconds",
  inactiveCooldownMs: "follone_inactiveCooldownMs",
  topics: "follone_topics",
  debug: "follone_debug",
  logLevel: "follone_logLevel"
};

function $(id){ return document.getElementById(id); }

async function load() {
  const keys = Object.values(KEYMAP);
  const cur = await chrome.storage.local.get(keys);

  $("enabled").checked = cur[KEYMAP.enabled] ?? true;
  $("aiMode").value = cur[KEYMAP.aiMode] ?? "auto";

  $("riskSoft").value = cur[KEYMAP.riskSoft] ?? 60;
  $("riskHard").value = cur[KEYMAP.riskHard] ?? 75;
  $("batchSize").value = cur[KEYMAP.batchSize] ?? 3;
  $("idleMs").value = cur[KEYMAP.idleMs] ?? 650;

  $("topicWindow").value = cur[KEYMAP.topicWindow] ?? 30;
  $("bubbleMinSamples").value = cur[KEYMAP.bubbleMinSamples] ?? 16;
  $("bubbleDominance").value = cur[KEYMAP.bubbleDominance] ?? 0.62;
  $("bubbleEntropy").value = cur[KEYMAP.bubbleEntropy] ?? 0.55;
  $("bubbleCooldownMs").value = cur[KEYMAP.bubbleCooldownMs] ?? (10 * 60 * 1000);
  $("bubbleUseLLM").checked = cur[KEYMAP.bubbleUseLLM] ?? true;

  $("reportMinSeconds").value = cur[KEYMAP.reportMinSeconds] ?? 60;
  $("inactiveSuggestSeconds").value = cur[KEYMAP.inactiveSuggestSeconds] ?? 180;
  $("inactiveCooldownMs").value = cur[KEYMAP.inactiveCooldownMs] ?? (10 * 60 * 1000);

  $("debug").checked = cur[KEYMAP.debug] ?? true;
  $("logLevel").value = cur[KEYMAP.logLevel] ?? "info";

  const topics = cur[KEYMAP.topics];
  const fallback = [
    "社会","政治","経済","国際","テック","科学","教育","健康",
    "スポーツ","エンタメ","音楽","映画/アニメ","ゲーム","趣味",
    "創作","生活","旅行","歴史","ビジネス","その他"
  ];
  $("topics").value = (Array.isArray(topics) ? topics : fallback).slice(0, 30).join("\n");
}

async function save() {
  const out = {};
  out[KEYMAP.enabled] = $("enabled").checked;
  out[KEYMAP.aiMode] = $("aiMode").value;

  out[KEYMAP.riskSoft] = Number($("riskSoft").value || 60);
  out[KEYMAP.riskHard] = Number($("riskHard").value || 75);
  out[KEYMAP.batchSize] = Number($("batchSize").value || 3);
  out[KEYMAP.idleMs] = Number($("idleMs").value || 650);

  out[KEYMAP.topicWindow] = Number($("topicWindow").value || 30);
  out[KEYMAP.bubbleMinSamples] = Number($("bubbleMinSamples").value || 16);
  out[KEYMAP.bubbleDominance] = Number($("bubbleDominance").value || 0.62);
  out[KEYMAP.bubbleEntropy] = Number($("bubbleEntropy").value || 0.55);
  out[KEYMAP.bubbleCooldownMs] = Number($("bubbleCooldownMs").value || (10 * 60 * 1000));
  out[KEYMAP.bubbleUseLLM] = $("bubbleUseLLM").checked;

  out[KEYMAP.reportMinSeconds] = Number($("reportMinSeconds").value || 60);
  out[KEYMAP.inactiveSuggestSeconds] = Number($("inactiveSuggestSeconds").value || 180);
  out[KEYMAP.inactiveCooldownMs] = Number($("inactiveCooldownMs").value || (10 * 60 * 1000));

  out[KEYMAP.debug] = $("debug").checked;
  out[KEYMAP.logLevel] = $("logLevel").value;

  const lines = $("topics").value.split("\n").map(s => s.trim()).filter(Boolean);
  out[KEYMAP.topics] = lines.slice(0, 30);

  await chrome.storage.local.set(out);
  $("status").textContent = "保存しました。";
  setTimeout(() => $("status").textContent = "", 1500);
}



// -----------------------------
// Prompt API warm-up (one-time download trigger)
// -----------------------------
const LM_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["ja", "en"] }],
  expectedOutputs: [{ type: "text", languages: ["ja"] }]
};

function setAiStatus(text) {
  const el = $("aiStatus");
  if (el) el.textContent = String(text || "");
}

async function refreshAiStatus() {
  const lines = [];
  lines.push(`LanguageModel: ${typeof LanguageModel}`);

  if (typeof LanguageModel !== "undefined") {
    try {
      const a = await LanguageModel.availability(LM_OPTIONS);
      lines.push(`availability: ${a}`);
    } catch (e) {
      lines.push(`availability error: ${String(e)}`);
    }
  } else {
    lines.push("※このページでLanguageModelが見えない場合、Chrome/フラグ/配布状態が未対応の可能性があります。");
  }

  try {
    const b = await chrome.runtime.sendMessage({ type: "FOLLONE_BACKEND_STATUS" });
    if (b && b.ok) {
      lines.push(`offscreen availability: ${b.availability}`);
      lines.push(`offscreen status: ${b.status}`);
      lines.push(`offscreen hasSession: ${Boolean(b.hasSession)}`);
    } else {
      lines.push(`offscreen status: (no response)`);
    }
  } catch (e) {
    lines.push(`offscreen status error: ${String(e)}`);
  }

  setAiStatus(lines.join("\n"));
}

async function warmupModel() {
  const lines = [];
  lines.push("Warm-up start...");

  if (typeof LanguageModel === "undefined") {
    lines.push("LanguageModel is undefined in options page.");
    setAiStatus(lines.join("\n"));
    return;
  }

  let availability = "unknown";
  try {
    availability = await LanguageModel.availability(LM_OPTIONS);
    lines.push(`availability: ${availability}`);
  } catch (e) {
    lines.push(`availability error: ${String(e)}`);
    setAiStatus(lines.join("\n"));
    return;
  }

  // If model needs download, this click is treated as a user activation.
  try {
    const session = await LanguageModel.create({
      ...LM_OPTIONS,
      monitor(m) {
        try {
          m.addEventListener("downloadprogress", (e) => {
            const p = Math.round((e.loaded / e.total) * 100);
            setAiStatus(lines.concat([`download: ${p}% (${e.loaded}/${e.total})`]).join("\n"));
          });
        } catch (_) {}
      }
    });

    // Tiny verification prompt (kept neutral).
    try {
      await session.prompt("OK とだけ返して。");
      lines.push("prompt: ok");
    } catch (e) {
      lines.push(`prompt error: ${String(e)}`);
    }

    lines.push("Warm-up done. X上のfolloneはoffscreen経由でPrompt APIを使います。");
    setAiStatus(lines.join("\n"));
  } catch (e) {
    lines.push(`create() error: ${String(e)}`);
    lines.push("downloadable/downloading の場合は、Chrome再起動・フラグ確認後にもう一度押してください。");
    setAiStatus(lines.join("\n"));
  }

  await refreshAiStatus();
}


document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
  if ($("warmup")) $("warmup").addEventListener("click", warmupModel);
  if ($("backendStatus")) $("backendStatus").addEventListener("click", refreshAiStatus);
  refreshAiStatus();
});

// v0.4.14: clear cache not inserted due to missing DOMContentLoaded
