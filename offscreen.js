// follone offscreen document (Prompt API / LanguageModel)
// Handles Prompt API calls in a DOM-capable extension context.

'use strict';

const VERSION = '0.4.36-a';

const RISK_ENUM = [
  'ok',
  'light',
  'medium',
  'high',
  'critical',
  'violent',
  'sexual',
  'hate',
  'scam'
];

const LM_OPTIONS = {
  // Model behavior
  temperature: 0.2,
  topK: 40,

  // IMPORTANT: specify expected input/output languages to avoid Chrome's LanguageModel
  // "No output language was specified" warning and to improve stability.
  expectedInputs: [
    { type: "text", languages: ["ja", "en"] }
  ],
  expectedOutputs: [
    { type: "text", languages: ["ja"] }
  ],

};

const OUTPUT_LANGUAGE = 'ja'; // MUST be specified per request to satisfy LanguageModel API warning
const PROMPT_TIMEOUT_MS = 18000; // keep below content-script message timeout
const CREATE_TIMEOUT_MS = 60000; // avoid infinite loading when create() hangs

function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function isGenericLMFailure(err) {
  const msg = String(err?.message || err || '');
  const name = String(err?.name || '');
  return (
    /Other generic failures occurred/i.test(msg) ||
    /generic failures occurred/i.test(msg) ||
    /UnknownError/i.test(name) ||
    /UnknownError/i.test(msg)
  );
}

let session = null;
let lastAvailability = 'unknown';
let lastError = null;
// The built-in Prompt API session does not guarantee safe concurrent prompt() calls.
// Serialize all prompts to avoid sporadic UnknownError / generic failures.
let promptQueue = Promise.resolve();

function now() { return Date.now(); }

async function availability() {
  try {
    if (typeof LanguageModel === 'undefined' || !LanguageModel?.availability) {
      lastAvailability = 'unavailable';
      return lastAvailability;
    }
    lastAvailability = await LanguageModel.availability(LM_OPTIONS);
    return lastAvailability;
  } catch (e) {
    lastError = String(e);
    lastAvailability = 'unavailable';
    return lastAvailability;
  }
}

async function ensureSession() {
  const avail = await availability();

  if (avail !== 'available') {
    session = null;
    return { ok: false, availability: avail, status: avail, error: lastError };
  }

  if (session) return { ok: true, availability: avail, status: 'ready' };

  try {
    session = await withTimeout(LanguageModel.create(LM_OPTIONS), CREATE_TIMEOUT_MS, 'create_timeout');
    // create() can change availability (e.g., trigger download). Refresh best-effort.
    try { lastAvailability = await LanguageModel.availability(LM_OPTIONS); } catch (_) {}
    return { ok: true, availability: lastAvailability || avail, status: 'ready' };
  } catch (e) {
    session = null;
    lastError = String(e);
    return { ok: false, availability: avail, status: 'create_failed', error: lastError };
  }
}

function buildSchema(topicList) {
  const topicEnum = Array.isArray(topicList) && topicList.length
    ? topicList.slice(0, 80)
    : ['general'];

  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      results: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            riskScore: { type: 'number', minimum: 0, maximum: 1 },
            riskCategory: { type: 'string', enum: RISK_ENUM },
            topicCategory: { type: 'string', enum: topicEnum },
            reasons: {
              type: 'array',
              maxItems: 3,
              items: { type: 'string' }
            }
          },
          required: ['id', 'riskScore', 'riskCategory', 'topicCategory', 'reasons']
        }
      }
    },
    required: ['results']
  };
}

function safeJsonParse(txt) {
  try {
    return JSON.parse(txt);
  } catch (_) {
    // Try to extract a JSON object substring.
    const s = String(txt || '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
    }
    return null;
  }
}

function buildPrompt(batch, topicList) {
  const topicEnum = Array.isArray(topicList) && topicList.length
    ? topicList.slice(0, 80)
    : ['general'];

  // Keep per-item content short and safe.
  const items = batch.map((x) => ({
    id: String(x.id || ''),
    text: String(x.text || '').slice(0, 800)
  }));

  return [
    'You are a safety-focused classifier for short social media posts.',
    '',
    'Task:',
    '- For each item, output: riskScore (0..1), riskCategory, topicCategory, reasons (0..3).',
    '- riskCategory is one of: ' + RISK_ENUM.join(', '),
    '- topicCategory must be one of: ' + topicEnum.join(', '),
    '',
    'Guidance:',
    '- ok: benign / normal discussion.',
    '- light: mild negativity, sarcasm, mild harassment, mild misinformation.',
    '- medium: explicit slurs? threats? targeted harassment? self-harm mention? (keep non-graphic).',
    '- high/critical: credible threats, explicit violence intent, doxxing, severe hate, explicit scam instructions.',
    '- hate: hateful content against protected groups.',
    '- scam: phishing, fraud, impersonation, suspicious links, investment scams.',
    '- violent: encouragement or details of violence.',
    '- sexual: explicit sexual content.',
    '',
    'Output JSON only.',
    '',
    'Input:',
    JSON.stringify({ items }, null, 2)
  ].join('\n');
}

function serializePrompt(fn) {
  const run = promptQueue.then(fn, fn);
  // Keep the queue alive even if a prompt fails.
  promptQueue = run.catch(() => {});
  return run;
}

function isProbablyTransientPromptError(err) {
  const msg = String(err?.message || err || '');
  const name = String(err?.name || '');
  // Chrome surfaces a lot of Prompt API failures as "UnknownError" / "Other generic failures".
  return (
    name.includes('UnknownError') ||
    msg.includes('UnknownError') ||
    msg.includes('generic failures') ||
    msg.includes('Other generic failures') ||
    msg.includes('aborted') ||
    msg.includes('Abort')
  );
}

async function promptWithFallback(prompt, schema) {
  // Ensure session exists; recreate at most once per request on generic failures/timeouts.
  let recreated = false;

  while (true) {
    const ses = await ensureSession();
    if (!ses.ok || !session) {
      throw new Error(ses?.error || 'No Prompt API session');
    }

    // Provide schema (preferred) but keep compatibility variants.
    const variants = [
      { responseConstraint: schema, omitResponseConstraintInput: true, outputLanguage: OUTPUT_LANGUAGE },
      { responseConstraint: schema, outputLanguage: OUTPUT_LANGUAGE },
      { outputLanguage: OUTPUT_LANGUAGE },
    ];

    let last = null;

    for (const opts of variants) {
      try {
        return await withTimeout(session.prompt(prompt, opts), PROMPT_TIMEOUT_MS, 'timeout');
      } catch (e) {
        last = e;
        lastError = String(e?.message || e || e);

        const shouldRecover = /timeout/i.test(lastError) || isGenericLMFailure(e) || isProbablyTransientPromptError(e);

        if (!recreated && shouldRecover) {
          recreated = true;
          // Hard reset session and retry from outer while-loop.
          try { session = null; } catch (_) {}
          continue;
        }
        // Otherwise try next variant; if all variants fail, throw at the end.
      }
    }

    // All variants failed.
    if (recreated) {
      throw last || new Error('Prompt failed');
    }
    // If we haven't recreated yet, do one session reset then retry.
    recreated = true;
    session = null;
  }
}



async function classifyBatch(batch, topicList) {
  const ses = await ensureSession();
  if (!ses.ok) return { ok: false, ...ses };

  const schema = buildSchema(topicList);
  const prompt = buildPrompt(batch, topicList);

  // Serialize prompts to avoid concurrency issues, and auto-recover from transient failures.
  return serializePrompt(async () => {
    try {
      const t0 = now();
      const raw = await promptWithFallback(prompt, schema);
      const t1 = now();
      const obj = safeJsonParse(raw);

      if (!obj || !Array.isArray(obj.results)) {
        lastError = 'invalid_json';
        return {
          ok: false,
          availability: lastAvailability,
          status: 'parse_failed',
          error: lastError,
          raw: String(raw || '').slice(0, 3000),
          latencyMs: t1 - t0
        };
      }

      lastError = null;
      return {
        ok: true,
        availability: lastAvailability,
        status: 'ready',
        engine: 'prompt_api',
        results: obj.results,
        latencyMs: t1 - t0
      };
    } catch (e) {
      // 1st failure: if it looks transient, recreate the session once and retry.
      const msg = String(e?.message || e);
      if (isProbablyTransientPromptError(e)) {
        try {
          session = null;
          await ensureSession();
          const t0 = now();
          const raw = await promptWithFallback(prompt, schema);
          const t1 = now();
          const obj = safeJsonParse(raw);
          if (obj && Array.isArray(obj.results)) {
            lastError = null;
            return { ok: true, availability: lastAvailability, status: 'ready', engine: 'prompt_api', results: obj.results, latencyMs: t1 - t0, recovered: true };
          }
          lastError = 'invalid_json';
          return { ok: false, availability: lastAvailability, status: 'parse_failed', error: lastError, raw: String(raw || '').slice(0, 3000), latencyMs: t1 - t0 };
        } catch (e2) {
          lastError = String(e2?.message || e2);
          return { ok: false, availability: lastAvailability, status: 'prompt_failed', error: lastError };
        }
      }

      lastError = msg;
      return { ok: false, availability: lastAvailability, status: 'prompt_failed', error: lastError };
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.to !== 'offscreen') return;

    switch (msg.type) {
      case 'FOLLONE_BACKEND_STATUS': {
        const avail = await availability();
        sendResponse({
          ok: true,
          version: VERSION,
          availability: avail,
          status: (session && avail === 'available') ? 'ready' : avail,
          hasSession: !!session,
          lastError
        });
        return;
      }

      case 'FOLLONE_BACKEND_WARMUP': {
        const res = await ensureSession();
        sendResponse({ ...res, version: VERSION, hasSession: !!session });
        return;
      }

      case 'FOLLONE_CLASSIFY_BATCH': {
        const batch = Array.isArray(msg.batch) ? msg.batch : [];
        const topicList = Array.isArray(msg.topicList) ? msg.topicList : [];
        if (!batch.length) {
          sendResponse({ ok: true, availability: lastAvailability, status: 'ready', engine: 'prompt_api', results: [] });
          return;
        }
        const res = await classifyBatch(batch, topicList);
        sendResponse(res);
        return;
      }

      default:
        sendResponse({ ok: false, error: 'unknown_message_type', type: msg.type });
        return;
    }
  })().catch((e) => {
    try { sendResponse({ ok: false, error: String(e) }); } catch (_) {}
  });

  return true;
});
