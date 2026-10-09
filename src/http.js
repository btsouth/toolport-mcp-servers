'use strict';
const { compact } = require('./contracts');
const MAX_BYTES = 8 * 1024 * 1024;
const LOG_BYTES = 2 * 1024 * 1024;
const REQUEST_MS = 20000;
const LOG_MS = 10000;
const LOG_IDLE_MS = 750;

function safeMessage(message, secrets = []) {
  let text = String(message || 'Request failed');
  for (const secret of secrets.filter(x => typeof x === 'string' && x.length)) text = text.split(secret).join('[redacted]');
  text = text.replace(/Bearer\s+\S+|\b(?:sk|rk)_(?:live|test)_\w+|\b(?:token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '[redacted]');
  return compact(text, 300);
}
function apiError(status, body, secrets) {
  const error = body?.error || body?.errors?.[0] || body;
  return { error: { status, code: safeMessage(error?.code || error?.type || 'http_error', secrets),
    message: safeMessage(error?.message || (typeof error === 'string' ? error : `HTTP ${status}`), secrets),
    ...Object.fromEntries(['param', 'decline_code', 'long_message', 'type', 'request_id', 'documentation_url'].filter(k => typeof error?.[k] === 'string').map(k => [k, safeMessage(error[k], secrets)])) } };
}
async function readText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) { const e = new Error('API response exceeded the bounded byte limit'); e.code = 'response_too_large'; throw e; }
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function readLogs(response, options, controller, budget = {}) {
  const reader = response.body?.getReader();
  const entries = [];
  let reason = 'eof', buffer = '', bytes = 0, finished = false, skippedLines = 0;
  const decoder = new TextDecoder();
  const idleMs = budget.idleMs ?? LOG_IDLE_MS;
  const maxBytes = budget.maxBytes ?? LOG_BYTES;
  if (!reader) return { entries, stopped: reason, skippedLines, ...options };
  function line(text) {
    text = text.trim();
    if (!text || text.startsWith(':') || /^(event|id|retry):/.test(text)) return;
    if (text.startsWith('data:')) text = text.slice(5).trim();
    if (text === '[DONE]') { finished = true; return; }
    let entry;
    try { entry = JSON.parse(text); } catch { skippedLines++; return; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { skippedLines++; return; }
    const timestamp = entry.timestampInMs;
    if (typeof timestamp === 'number' && (timestamp < options.since || timestamp > options.until)) return;
    entries.push(entry);
    if (entries.length >= options.limit) reason = 'limit';
  }
  try {
    for (;;) {
      let timer;
      let next;
      try {
        next = await Promise.race([
          reader.read(),
          new Promise(resolve => { timer = setTimeout(() => resolve({ idle: true }), idleMs); }),
        ]);
      } catch (e) {
        if (controller.signal.reason?.code === 'log_deadline') { reason = 'deadline'; break; }
        throw e;
      } finally { clearTimeout(timer); }
      if (next.idle) { reason = 'idle'; break; }
      if (next.done) {
        buffer += decoder.decode();
        if (buffer.trim()) line(buffer);
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) { reason = 'byte_limit'; break; }
      buffer += decoder.decode(next.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (reason === 'limit' || finished) break;
      }
      if (reason === 'limit' || finished) break;
    }
    if (controller.signal.aborted && controller.signal.reason?.code !== 'log_deadline') throw controller.signal.reason;
    return { entries, stopped: reason, skippedLines, ...options };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function request({ url, method, headers, body, signal, logs, secrets = [], budget = {} }) {
  const controller = new AbortController();
  const cancel = () => controller.abort(Object.assign(new Error('Cancelled by caller'), { code: 'cancelled' }));
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('API request deadline reached'), {
    code: logs ? 'log_deadline' : 'request_timeout',
  })), budget.requestMs ?? (logs ? LOG_MS : REQUEST_MS));
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
    if (response.ok && logs) return { status: response.status, body: await readLogs(response, logs, controller, budget) };
    const text = await readText(response, MAX_BYTES);
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (controller.signal.aborted) throw controller.signal.reason;
    const result = response.ok ? parsed : apiError(response.status, parsed, secrets);
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      // Drop token-bearing queries/fragments and URL credentials before reporting.
      let location = response.headers.get('location').split(/[?#]/)[0];
      try { const target = new URL(location); target.username = ''; target.password = ''; location = target.toString(); } catch { /* Relative Location is valid too. */ }
      result.error.location = safeMessage(location, secrets);
    }
    return { status: response.status, body: result };
  } catch (e) {
    const reason = controller.signal.aborted ? controller.signal.reason : e;
    if (reason?.code === 'log_deadline') reason.code = 'request_timeout';
    return { status: 0, body: { error: { status: null, code: reason?.code || 'network_error',
      ...(typeof reason?.cause?.code === 'string' ? { cause: safeMessage(reason.cause.code, secrets) } : {}),
      message: safeMessage(reason?.code ? reason.message : 'API network request failed', secrets),
      ...(method !== 'GET' && method !== 'HEAD' ? { completion: 'unknown; do not retry automatically' } : {}) } } };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
module.exports = { request, safeMessage, apiError };
