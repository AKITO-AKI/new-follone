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
  topics: "follone_topics"
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

  const lines = $("topics").value.split("\n").map(s => s.trim()).filter(Boolean);
  out[KEYMAP.topics] = lines.slice(0, 30);

  await chrome.storage.local.set(out);
  $("status").textContent = "保存しました。";
  setTimeout(() => $("status").textContent = "", 1500);
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
});
