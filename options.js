'use strict';

const STORAGE_KEYS = {
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
};

function $(id) { return document.getElementById(id); }

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
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


async function getAll() {
  const keys = Object.values(STORAGE_KEYS);
  return await chrome.storage.local.get(keys);
}

async function setOne(key, val) {
  await chrome.storage.local.set({ [key]: val });
}

async function refreshDiag() {
  const resp = await sendMessageSafe({ type: 'FOLLONE_BACKEND_STATUS' }, 8000);

  if (!resp || typeof resp !== 'object') {
    $('avail').textContent = '--';
    $('status').textContent = 'no_response';
    $('hasSession').textContent = '--';
    $('lastError').textContent = '--';
    return;
  }

  // Prefer explicit backend payload fields; fall back to ok/error.
  $('avail').textContent = resp.availability ?? '--';
  $('status').textContent = resp.status ?? (resp.ok ? 'ok' : 'error');
  $('hasSession').textContent = String(resp.hasSession ?? '--');
  $('lastError').textContent = resp.lastError ? String(resp.lastError)
    : (resp.ok ? '--' : String(resp.error || '--'));
}

async function warmup() {
  const resp = await sendMessageSafe({ type: 'FOLLONE_BACKEND_WARMUP' }, 120000);
  await refreshDiag();
  return resp;
}

async function init() {
  $('ver').textContent = `options`;

  const data = await getAll();

  $('enabled').checked = data[STORAGE_KEYS.enabled] ?? true;
  $('debug').checked = data[STORAGE_KEYS.debug] ?? true;
  $('logLevel').value = data[STORAGE_KEYS.logLevel] ?? 'info';
  $('aiMode').value = data[STORAGE_KEYS.aiMode] ?? 'auto';
  $('enableSpotlight').checked = data[STORAGE_KEYS.enableSpotlight] ?? true;

  $('minRiskToIntervene').value = data[STORAGE_KEYS.minRiskToIntervene] ?? 0.65;
  $('minRiskToPromptSearch').value = data[STORAGE_KEYS.minRiskToPromptSearch] ?? 0.55;

  $('batchSize').value = data[STORAGE_KEYS.batchSize] ?? 5;
  $('idleMs').value = data[STORAGE_KEYS.idleMs] ?? 20000;
  $('maxTextChars').value = data[STORAGE_KEYS.maxTextChars] ?? 140;

  // Bind
  $('enabled').addEventListener('change', (e) => setOne(STORAGE_KEYS.enabled, !!e.target.checked));
  $('debug').addEventListener('change', (e) => setOne(STORAGE_KEYS.debug, !!e.target.checked));
  $('logLevel').addEventListener('change', (e) => setOne(STORAGE_KEYS.logLevel, String(e.target.value)));
  $('aiMode').addEventListener('change', (e) => setOne(STORAGE_KEYS.aiMode, String(e.target.value)));
  $('enableSpotlight').addEventListener('change', (e) => setOne(STORAGE_KEYS.enableSpotlight, !!e.target.checked));

  $('minRiskToIntervene').addEventListener('change', (e) => setOne(STORAGE_KEYS.minRiskToIntervene, clamp(Number(e.target.value || 0.65), 0, 1)));
  $('minRiskToPromptSearch').addEventListener('change', (e) => setOne(STORAGE_KEYS.minRiskToPromptSearch, clamp(Number(e.target.value || 0.55), 0, 1)));

  $('batchSize').addEventListener('change', (e) => setOne(STORAGE_KEYS.batchSize, clamp(Math.round(Number(e.target.value || 5)), 1, 10)));
  $('idleMs').addEventListener('change', (e) => setOne(STORAGE_KEYS.idleMs, clamp(Math.round(Number(e.target.value || 20000)), 2000, 600000)));
  $('maxTextChars').addEventListener('change', (e) => setOne(STORAGE_KEYS.maxTextChars, clamp(Math.round(Number(e.target.value || 140)), 40, 400)));

  $('refresh').addEventListener('click', refreshDiag);
  $('warmup').addEventListener('click', warmup);

  await refreshDiag();
}

document.addEventListener('DOMContentLoaded', init);
