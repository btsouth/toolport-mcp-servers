'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { compileContract, routingFor } = require('../src/contracts');
const { fixtures } = require('./helpers/schemaValues');
const vendors = ['stripe', 'vercel', 'clerk', 'cloudflare'];

async function dryClient(t, vendor) {
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
    env: { PATH: process.env.PATH, VENDOR: vendor }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let next = 0, stderr = '';
  const pending = new Map();
  child.stderr.on('data', b => { stderr += b; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line);
    const done = pending.get(response.id); pending.delete(response.id); done?.(response);
  });
  child.on('exit', () => { for (const done of pending.values()) done({ error: { message: stderr } }); pending.clear(); });
  t.after(async () => {
    if (child.exitCode === null) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; }
  });
  return async (method, params) => {
    const id = next++;
    const response = new Promise(resolve => pending.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return response;
  };
}
const alias = k => k.replace(/^['"]|['"]$/g, '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) || 'field';
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
function wireSchema(s, value) {
  if (!s.anyOf) return s;
  return s.anyOf.find(x => x.type === kind(value) || (kind(value) === 'number' && x.type === 'integer')) || s.anyOf.find(x => x.anyOf) || s.anyOf[0];
}
function wireValue(s, value, encoded) {
  s = wireSchema(s, value);
  if (/JSON-encoded value:/.test(s.description || '')) { encoded.count++; return JSON.stringify(value); }
  if (Array.isArray(value)) return value.map(x => wireValue(s.items, x, encoded));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    const name = alias(k), child = s.properties?.[name] || (typeof s.additionalProperties === 'object' ? s.additionalProperties : null);
    return [name, child ? wireValue(child, v, encoded) : v];
  }));
  return value;
}
function advertisedAt(s, keys, value) {
  for (const k of keys) {
    s = wireSchema(s, typeof k === 'number' ? [] : {});
    if (/JSON-encoded value:/.test(s.description || '')) return null; // Scalar remains plain inside the encoded container.
    s = typeof k === 'number' ? s.items : s.properties?.[alias(k)] || (typeof s.additionalProperties === 'object' ? s.additionalProperties : null);
    if (!s) return null;
  }
  return wireSchema(s, value);
}
function flatPairs(value, prefix = '', out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'object') for (const [k, v] of Object.entries(value)) flatPairs(v, prefix ? `${prefix}[${k}]` : k, out);
  else out.push([prefix, String(value)]);
  return out;
}
const form = value => flatPairs(value).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
function expectedRequest(vendor, cfg, meta, args) {
  const urlPath = meta.path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(String(args[key])));
  const query = meta.queryParams.filter(k => args[k] !== undefined).map(k => form({ [k]: args[k] })).filter(Boolean).join('&');
  const headers = Object.fromEntries((meta.headerParams || []).filter(k => args[k] !== undefined).map(k => [k, String(args[k])]));
  let body = '';
  if (args.body !== undefined && meta.method !== 'GET') {
    const type = meta.contentType || (cfg.bodyFormat === 'json' ? 'application/json' : 'application/x-www-form-urlencoded');
    body = type === 'application/json' ? JSON.stringify(args.body) : type === 'application/x-www-form-urlencoded' ? form(args.body) : args.body;
  }
  return { url: cfg.apiBase + urlPath + (query ? '?' + query : ''), body, headers };
}
for (const vendor of vendors) test(`${vendor}: every scalar and JSON-encoded field round-trips through MCP dry runs`, { timeout: 300000 }, async t => {
  const cfg = require(`../vendors/${vendor}`), tools = require(`../data/${cfg.out.tools}`);
  const map = require(`../data/${cfg.out.namemap}`), ops = require(`../data/${cfg.out.operations}`);
  const reverse = Object.fromEntries(Object.entries(map).map(([id, name]) => [name, id]));
  const call = await dryClient(t, vendor);
  const listed = (await call('tools/list')).result.tools;
  let scalarFields = 0, scalarCases = 0, encodedFields = 0, encodedCases = 0;
  for (const tool of tools) {
    const meta = routingFor(ops, reverse[tool.name]);
    const source = structuredClone(tool.inputSchema);
    for (const key of meta.pathParams) {
      source.properties[key] ||= { type: 'string' };
      if (!source.required.includes(key)) source.required.push(key);
    }
    const f = fixtures(source), contract = compileContract(source, meta);
    const wire = listed.find(x => x.name === tool.name).inputSchema;
    const scalarSeen = new Set(), encodedSeen = new Set();
    for (const node of f.nodes().filter(x => x.path.length)) {
      const label = `${vendor}/${tool.name}/${node.path.join('/')}`;
      let value;
      try { value = f.sample(node.schema); } catch (e) { throw new Error(`${label}: ${e.message}`); }
      const advertised = advertisedAt(wire, node.path, value);
      const isEncoded = advertised && /JSON-encoded value:/.test(advertised.description || '');
      if (!node.scalar && !isEncoded) continue;
      if (node.scalar) {
        assert.ok(value !== null && ['string', 'number', 'boolean'].includes(typeof value), label);
        if (advertised) assert.doesNotMatch(advertised.description || '', /JSON-encoded value:/, label);
        scalarSeen.add(JSON.stringify(node.path)); scalarCases++;
      }
      if (isEncoded) { encodedSeen.add(JSON.stringify(node.path)); encodedCases++; }
      let args;
      try { args = f.sample(source, node.path, value, node.choices); } catch (e) { throw new Error(`${label}: ${e.message}`); }
      assert.equal(f.valid(source, args), true, `${label}: generated source fixture must be valid`);
      const encoded = { count: 0 };
      const input = wireValue(wire, args, encoded);
      assert.deepEqual(contract.decode(input), args, `${label}: decoded value changed`);
      if (isEncoded) assert.ok(encoded.count > 0, label);
      const response = await call('tools/call', { name: tool.name, arguments: input });
      assert.equal(response.result?.isError, false, `${label}: ${JSON.stringify(response)}`);
      const request = expectedRequest(vendor, cfg, meta, args);
      const expected = `DRY RUN (no ${cfg.apiKeyEnv} set). Would call:\n${meta.method} ${request.url}\n${request.body !== '' ? 'body: ' + request.body : '(no body)'}${Object.keys(request.headers).length ? '\nheaders: ' + JSON.stringify(request.headers) : ''}\n\n[curated tool ${tool.name} -> ${reverse[tool.name]}]`;
      assert.equal(response.result.content[0].text, expected, label);
    }
    scalarFields += scalarSeen.size; encodedFields += encodedSeen.size;
  }
  t.diagnostic(JSON.stringify({ vendor, tools: tools.length, scalarFields, scalarCases, encodedFields, encodedCases }));
});
