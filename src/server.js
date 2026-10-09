'use strict';
// A self-contained MCP stdio server that serves a vendor's CURATED tools and routes each
// call to the real API. VENDOR selects the vendor (stripe default, clerk, ...).
//
//   VENDOR=clerk CLERK_SECRET_KEY=sk_... node src/server.js
//
// With no API key set it runs DRY-RUN (returns the HTTP request it WOULD make), so the
// wiring is verifiable without credentials. Reads bundled data/ artifacts, falling back to out/ for development.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { stripeForm } = require('./stripeForm');
const { compileContract, routingFor, compact } = require('./contracts');
const { request, safeMessage } = require('./http');

const VENDOR = process.env.VENDOR || 'stripe';
const cfg = require(`../vendors/${VENDOR}`);
// Bundled artifacts ship in data/; fall back to out/ for local dev builds.
const DATA = path.join(__dirname, '..', 'data');
const OUT = fs.existsSync(DATA) ? DATA : path.join(__dirname, '..', 'out');
const load = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));

// TOOLSET=core serves the leaner subset; default full.
const TOOLSET = (process.env.TOOLSET || process.env.STRIPE_TOOLSET || 'full').toLowerCase();
let curated, opByName, operations;
try {
  curated = load(TOOLSET === 'core' ? cfg.out.core : cfg.out.tools);
  const nameMap = load(cfg.out.namemap);
  operations = load(cfg.out.operations);
  opByName = Object.fromEntries(Object.entries(nameMap).map(([op, n]) => [n, op]));
} catch (e) {
  process.stderr.write(`toolport-${VENDOR}-mcp: build artifacts missing - regenerate the vendor artifacts (${e.message})\n`);
  process.exit(1);
}

const contracts = new Map();
curated = curated.map(tool => {
  const meta = routingFor(operations, opByName[tool.name]);
  if (VENDOR === 'vercel' && tool.name === 'list_runtime_logs') {
    tool = structuredClone(tool);
    Object.assign(tool.inputSchema.properties, {
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum entries; default 100.' },
      since: { type: 'integer', minimum: 0, description: 'Inclusive local timestamp filter in Unix milliseconds; default 15 minutes ago.' },
      until: { type: 'integer', minimum: 0, description: 'Inclusive local timestamp filter in Unix milliseconds; default call start.' },
    });
    tool.description = 'Query a bounded snapshot of deployment runtime logs. Filters streamed entries locally by since/until; no historical backfill guarantee. Default limit 100, 750 ms idle gap, 10 s total, 2 MiB cap. Returns entries and stopped reason; never follows indefinitely.';
  }
  const contract = compileContract(tool.inputSchema, meta);
  contracts.set(tool.name, contract);
  return { ...tool, description: compact(tool.description, 500), inputSchema: contract.inputSchema };
});

const API_KEY = process.env[cfg.apiKeyEnv] || '';
const BASE = process.env.API_BASE_OVERRIDE || cfg.apiBase;
const NAME = `toolport-${VENDOR}-mcp`;
const PROTOCOL = '2024-11-05';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const result = (id, res) => send({ jsonrpc: '2.0', id, result: res });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

// Curated tool call -> concrete HTTP request: path params fill the URL, query params become
// the query string, and `body` is the request payload (encoded per the vendor's bodyFormat).
function buildRequest(op, args) {
  const meta = routingFor(operations, op);
  if (!meta) throw new Error(`no routing for ${op}`);
  const a = { ...(args || {}) };
  let p = meta.path;
  for (const pp of meta.pathParams) {
    if (a[pp] === undefined || a[pp] === null || a[pp] === '') throw new Error(`missing path parameter: ${pp}`);
    p = p.split(`{${pp}}`).join(encodeURIComponent(String(a[pp])));
    delete a[pp];
  }
  const query = [];
  for (const qp of meta.queryParams) {
    if (a[qp] !== undefined) { const enc = stripeForm({ [qp]: a[qp] }); if (enc) query.push(enc); delete a[qp]; }
  }
  const url = BASE + p + (query.length ? `?${query.join('&')}` : '');
  const headers = {};
  for (const hp of meta.headerParams || []) {
    const key = Object.keys(a).find(k => k.toLowerCase() === hp.toLowerCase());
    if (key !== undefined) headers[hp] = String(a[key]);
  }
  return { method: meta.method, url, body: a.body, headers, contentType: meta.contentType };
}

function encodeBody(body, contentType) {
  if (body === undefined) return {};
  if (contentType && !['application/json', 'application/x-www-form-urlencoded'].includes(contentType)) {
    if (contentType === 'text/plain' || contentType === 'application/octet-stream') return { encoded: body, contentType };
    throw Object.assign(new Error(`Unsupported request content type: ${contentType}`), { code: 'unsupported_content_type' });
  }
  if (contentType === 'application/json' || (!contentType && cfg.bodyFormat === 'json')) return { encoded: JSON.stringify(body), contentType: 'application/json' };
  return { encoded: stripeForm(body), contentType: 'application/x-www-form-urlencoded' };
}

async function callTool(name, args, signal) {
  const op = opByName[name];
  if (!op) throw new Error(`unknown tool: ${name}`);
  args = contracts.get(name).decode(args);
  const { method, url, body, headers: parameterHeaders, contentType: bodyType } = buildRequest(op, args);
  const { encoded, contentType } = method !== 'GET' ? encodeBody(body, bodyType) : {};
  const headers = { ...parameterHeaders, Authorization: `Bearer ${API_KEY}` };
  if (contentType) headers['Content-Type'] = contentType;
  let logs;
  if (VENDOR === 'vercel' && name === 'list_runtime_logs') {
    const now = Date.now();
    logs = { limit: args.limit ?? 100, since: args.since ?? now - 15 * 60 * 1000, until: args.until ?? now };
    if (logs.since > logs.until) throw Object.assign(new Error('since must be at or before until'), { code: 'invalid_arguments' });
  }
  if (!API_KEY) return { dryRun: true, op, method, url, body: encoded || '' };
  const secrets = [API_KEY];
  function collect(value, key = '') {
    if (typeof value === 'string' && (value.length >= 4 || /secret|token|password|authorization|cookie|api.?key|private.?key/i.test(key))) secrets.push(value);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
  }
  collect(args);
  return request({ url, method, headers, body: encoded, signal, logs, secrets });
}

const pending = new Map();
async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return result(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: NAME, version: require('../package.json').version } });
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'notifications/cancelled':
      pending.get(params?.requestId)?.abort();
      return;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: curated });
    case 'tools/call': {
      const name = params && params.name;
      const controller = new AbortController();
      pending.set(id, controller);
      try {
        const out = await callTool(name, (params && params.arguments) || {}, controller.signal);
        const text = out.dryRun
          ? `DRY RUN (no ${cfg.apiKeyEnv} set). Would call:\n${out.method} ${out.url}\n${out.body ? 'body: ' + out.body : '(no body)'}\n\n[curated tool ${name} -> ${out.op}]`
          : JSON.stringify(out.body, null, 2);
        return result(id, { content: [{ type: 'text', text }], isError: !out.dryRun && (out.status === 0 || out.status >= 400) });
      } catch (e) {
        return result(id, { content: [{ type: 'text', text: JSON.stringify({ error: { status: null, code: e.code || 'invalid_arguments', message: safeMessage(e.message, [API_KEY]), ...(e.field ? { field: e.field } : {}) } }) }], isError: true });
      } finally { pending.delete(id); }
    }
    default:
      if (id !== undefined) error(id, -32601, `method not found: ${method}`);
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on('close', () => { for (const controller of pending.values()) controller.abort(); });
input.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  Promise.resolve(handle(msg)).catch((e) => { if (msg && msg.id !== undefined) error(msg.id, -32603, e.message); });
});

process.stderr.write(
  `${NAME} ready: ${curated.length} curated ${VENDOR} tools (${TOOLSET})` +
  (API_KEY ? '\n' : ` (DRY-RUN: set ${cfg.apiKeyEnv} for live calls)\n`)
);
