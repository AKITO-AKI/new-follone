const DEFAULT_KEYS = [
  "follone_enabled",
  "follone_riskThresholdSoft",
  "follone_riskThresholdHard",
  "follone_batchSize",
  "follone_idleMs",
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
];

function $(id) { return document.getElementById(id); }
function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

async function load() {
  const cur = await chrome.storage.local.get(DEFAULT_KEYS);

  $("enabled").checked = cur.follone_enabled ?? true;
  $("autoReportSuggest").checked = cur.follone_autoReportSuggest ?? true;

  $("batchSize").value = cur.follone_batchSize ?? 3;
  $("idleMs").value = cur.follone_idleMs ?? 700;

  $("riskSoft").value = cur.follone_riskThresholdSoft ?? 65;
  $("riskHard").value = cur.follone_riskThresholdHard ?? 80;

  $("bubbleUseLLM").checked = cur.follone_bubbleUseLLMSuggest ?? true;
  $("topicWindow").value = cur.follone_topicWindow ?? 40;
  $("bubbleDominance").value = cur.follone_bubbleDominance ?? 0.58;
  $("bubbleEntropy").value = cur.follone_bubbleEntropy ?? 0.55;
  $("bubbleMinSamples").value = cur.follone_bubbleMinSamples ?? 18;
  $("bubbleCooldownSec").value = Math.round((cur.follone_bubbleCooldownMs ?? (10*60*1000)) / 1000);

  $("sessionMinSec").value = cur.follone_sessionMinSec ?? 60;
  $("inactiveSec").value = cur.follone_inactiveSec ?? 180;
  $("reportCooldownSec").value = cur.follone_reportCooldownSec ?? 600;

  $("personaLazyKind").checked = cur.follone_personaLazyKind ?? true;
  $("explainMode").checked = cur.follone_explainMode ?? true;
}

async function save() {
  const set = {};
  set.follone_enabled = $("enabled").checked;
  set.follone_autoReportSuggest = $("autoReportSuggest").checked;

  set.follone_batchSize = clamp($("batchSize").value, 1, 8);
  set.follone_idleMs = clamp($("idleMs").value, 100, 5000);

  set.follone_riskThresholdSoft = clamp($("riskSoft").value, 0, 100);
  set.follone_riskThresholdHard = clamp($("riskHard").value, 0, 100);

  set.follone_bubbleUseLLMSuggest = $("bubbleUseLLM").checked;
  set.follone_topicWindow = clamp($("topicWindow").value, 10, 200);
  set.follone_bubbleDominance = clamp($("bubbleDominance").value, 0.30, 0.95);
  set.follone_bubbleEntropy = clamp($("bubbleEntropy").value, 0.10, 0.99);
  set.follone_bubbleMinSamples = clamp($("bubbleMinSamples").value, 8, 100);
  set.follone_bubbleCooldownMs = clamp($("bubbleCooldownSec").value, 30, 7200) * 1000;

  set.follone_sessionMinSec = clamp($("sessionMinSec").value, 10, 600);
  set.follone_inactiveSec = clamp($("inactiveSec").value, 30, 1800);
  set.follone_reportCooldownSec = clamp($("reportCooldownSec").value, 30, 7200);

  set.follone_personaLazyKind = $("personaLazyKind").checked;
  set.follone_explainMode = $("explainMode").checked;

  // keep soft <= hard
  if (set.follone_riskThresholdSoft > set.follone_riskThresholdHard) {
    const tmp = set.follone_riskThresholdSoft;
    set.follone_riskThresholdSoft = set.follone_riskThresholdHard;
    set.follone_riskThresholdHard = tmp;
  }

  await chrome.storage.local.set(set);
  status("保存しました");
}

async function reset() {
  // easiest: clear only our keys so sw.js re-seeds defaults on next install/update
  // but clearing would also reset XP, so we reset config keys only.
  const toRemove = DEFAULT_KEYS.filter(k => !["follone_xp", "follone_level"].includes(k));
  await chrome.storage.local.remove(toRemove);
  await load();
  status("初期値に戻しました（XP/Lvは保持）");
}

let timer = null;
function status(text) {
  const el = $("status");
  el.textContent = text;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (el.textContent = ""), 2500);
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  $("save").addEventListener("click", save);
  $("reset").addEventListener("click", reset);
});
