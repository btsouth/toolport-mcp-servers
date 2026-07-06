'use strict';
// A self-contained MCP stdio server that serves a vendor's CURATED tools and routes each
// call to the real API. VENDOR selects the vendor (stripe default, clerk, ...).
//
//   VENDOR=clerk CLERK_SECRET_KEY=sk_... node src/server.js
//
// With no API key set it runs DRY-RUN (returns the HTTP request it WOULD make), so the
// wiring is verifiable without credentials. Reads build artifacts from out/ (run the build).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { stripeForm } = require('./stripeForm');

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
  process.stderr.write(`toolport-${VENDOR}-mcp: build artifacts missing - run \`VENDOR=${VENDOR} npm run build\` (${e.message})\n`);
  process.exit(1);
}

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
  const meta = operations[op];
  if (!meta) throw new Error(`no routing for ${op}`);
  const a = { ...(args || {}) };
  let p = meta.path;
  for (const pp of meta.pathParams) {
    if (a[pp] === undefined) throw new Error(`missing path parameter: ${pp}`);
    p = p.replace(`{${pp}}`, encodeURIComponent(String(a[pp])));
    delete a[pp];
  }
  const query = [];
  for (const qp of meta.queryParams) {
    if (a[qp] !== undefined) { const enc = stripeForm({ [qp]: a[qp] }); if (enc) query.push(enc); delete a[qp]; }
  }
  const url = BASE + p + (query.length ? `?${query.join('&')}` : '');
  return { method: meta.method, url, body: a.body };
}

function encodeBody(body) {
  if (body === undefined) return {};
  if (cfg.bodyFormat === 'json') return { encoded: JSON.stringify(body), contentType: 'application/json' };
  return { encoded: stripeForm(body), contentType: 'application/x-www-form-urlencoded' };
}

async function callTool(name, args) {
  const op = opByName[name];
  if (!op) throw new Error(`unknown tool: ${name}`);
  const { method, url, body } = buildRequest(op, args);
  const { encoded, contentType } = method !== 'GET' ? encodeBody(body) : {};
  if (!API_KEY) return { dryRun: true, op, method, url, body: encoded || '' };
  const headers = { Authorization: `Bearer ${API_KEY}` };
  if (contentType) headers['Content-Type'] = contentType;
  const res = await fetch(url, { method, headers, body: encoded });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return result(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: NAME, version: '0.0.0' } });
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: curated });
    case 'tools/call': {
      const name = params && params.name;
      try {
        const out = await callTool(name, (params && params.arguments) || {});
        const text = out.dryRun
          ? `DRY RUN (no ${cfg.apiKeyEnv} set). Would call:\n${out.method} ${out.url}\n${out.body ? 'body: ' + out.body : '(no body)'}\n\n[curated tool ${name} -> ${out.op}]`
          : JSON.stringify(out.body, null, 2);
        return result(id, { content: [{ type: 'text', text }], isError: !out.dryRun && out.status >= 400 });
      } catch (e) {
        return result(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (id !== undefined) error(id, -32601, `method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
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
