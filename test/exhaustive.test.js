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
function shapeScore(s, value) {
  if (s.anyOf) return Math.max(...s.anyOf.map(x => shapeScore(x, value)));
  if (/JSON-encoded value:/.test(s.description || '')) return 0;
  if (s.type !== kind(value) && !(kind(value) === 'number' && s.type === 'integer')) return -100000;
  if (s.enum && !s.enum.includes(value)) return -100000;
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).reduce((score, [k, v]) => {
    const child = s.properties?.[alias(k)];
    return score + (child ? 10 + shapeScore(child, v) : 0);
  }, 1);
  return 1;
}
function wireSchema(s, value) {
  if (!s.anyOf) return s;
  return [...s.anyOf].sort((a, b) => shapeScore(b, value) - shapeScore(a, value))[0];
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
function advertisedAt(s, keys, args) {
  let value = args;
  for (const k of keys) {
    s = wireSchema(s, value);
    if (/JSON-encoded value:/.test(s.description || '')) return null; // Scalar remains plain inside the encoded container.
    s = typeof k === 'number' ? s.items : s.properties?.[alias(k)] || (typeof s.additionalProperties === 'object' ? s.additionalProperties : null);
    value = value?.[k];
    if (!s) return null;
  }
  return wireSchema(s, value);
}
function encodedPaths(s, here = [], out = new Set()) {
  if (/JSON-encoded value:/.test(s.description || '')) out.add(JSON.stringify(here));
  for (const [k, child] of Object.entries(s.properties || {})) encodedPaths(child, [...here, k], out);
  if (s.items) encodedPaths(s.items, [...here, 0], out);
  if (typeof s.additionalProperties === 'object') encodedPaths(s.additionalProperties, [...here, 'fixture_key'], out);
  for (const child of s.anyOf || []) encodedPaths(child, here, out);
  return out;
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
  const headers = {};
  for (const key of meta.headerParams || []) {
    const original = Object.keys(args).find(k => k.toLowerCase() === key.toLowerCase());
    if (original !== undefined) headers[key] = String(args[original]);
  }
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
  const fixtureFailures = [];
  for (const tool of tools) {
    const meta = routingFor(ops, reverse[tool.name]);
    const source = structuredClone(tool.inputSchema);
    for (const key of meta.pathParams) {
      source.properties[key] ||= { type: 'string' };
      if (!source.required.includes(key)) source.required.push(key);
    }
    const f = fixtures(source), contract = compileContract(source, meta);
    const wire = listed.find(x => x.name === tool.name).inputSchema;
    const scalarSeen = new Set(), encodedSeen = new Set(), expectedScalar = new Set();
    const expectedEncoded = encodedPaths(wire);
    const failures = new Map();
    for (const node of f.nodes().filter(x => x.path.length)) {
      const fieldKey = JSON.stringify(node.path);
      const advertisedKey = JSON.stringify(node.path.map(k => typeof k === 'number' ? k : alias(k)));
      if (node.scalar) expectedScalar.add(fieldKey);
      if (!node.scalar && !expectedEncoded.has(advertisedKey)) continue;
      const label = `${vendor}/${tool.name}/${node.path.join('/')}`;
      let value;
      try { value = f.sample(node.schema); } catch (e) { failures.set(fieldKey, { field: label, scalar: node.scalar, error: e.message }); continue; }
      let args;
      try { args = f.sample(source, node.path, value, node.choices); } catch (e) { failures.set(fieldKey, { field: label, scalar: node.scalar, error: e.message }); continue; }
      const advertised = advertisedAt(wire, node.path, args);
      const isEncoded = advertised && /JSON-encoded value:/.test(advertised.description || '');
      if (!node.scalar && !isEncoded) continue;
      if (node.scalar) {
        assert.ok(value !== null && ['string', 'number', 'boolean'].includes(typeof value), label);
        if (advertised) assert.doesNotMatch(advertised.description || '', /JSON-encoded value:/, label);
        scalarSeen.add(JSON.stringify(node.path)); scalarCases++;
      }
      if (isEncoded) { encodedSeen.add(advertisedKey); encodedCases++; }
      assert.deepEqual(node.path.reduce((x, key) => x?.[key], args), value, `${label}: fixture must include the field under test`);
      assert.equal(f.valid(source, args), true, `${label}: generated source fixture must be valid`);
      const encoded = { count: 0 };
      const input = wireValue(wire, args, encoded);
      let decoded;
      try { decoded = contract.decode(input); } catch (e) { throw new Error(`${label}: ${e.message}`); }
      assert.deepEqual(decoded, args, `${label}: decoded value changed`);
      if (isEncoded) assert.ok(encoded.count > 0, label);
      const response = await call('tools/call', { name: tool.name, arguments: input });
      assert.equal(response.result?.isError, false, `${label}: ${JSON.stringify(response)}`);
      const request = expectedRequest(vendor, cfg, meta, args);
      const output = response.result.content[0].text;
      const prefix = `DRY RUN (no ${cfg.apiKeyEnv} set). Would call:\n${meta.method} ${request.url}\n`;
      const suffix = `\n\n[curated tool ${tool.name} -> ${reverse[tool.name]}]`;
      assert.ok(output.startsWith(prefix), label);
      assert.ok(output.endsWith(suffix), label);
      let payload = output.slice(prefix.length, -suffix.length), headers = {};
      const headerStart = payload.lastIndexOf('\nheaders: ');
      if (headerStart !== -1) { headers = JSON.parse(payload.slice(headerStart + 10)); payload = payload.slice(0, headerStart); }
      assert.deepEqual(headers, request.headers, label);
      const body = payload === '(no body)' ? '' : payload.slice('body: '.length);
      const media = meta.contentType || (cfg.bodyFormat === 'json' ? 'application/json' : 'application/x-www-form-urlencoded');
      if (media === 'application/json' && request.body !== '') assert.deepEqual(JSON.parse(body), JSON.parse(request.body), label);
      else if (media === 'application/x-www-form-urlencoded') assert.deepEqual([...new URLSearchParams(body)].sort(), [...new URLSearchParams(request.body)].sort(), label);
      else assert.equal(body, String(request.body), label);

    }
    for (const key of expectedScalar) if (!scalarSeen.has(key)) fixtureFailures.push(failures.get(key) || { field: `${vendor}/${tool.name}/${JSON.parse(key).join('/')}`, scalar: true, error: 'No scalar fixture checked' });
    for (const key of expectedEncoded) if (!encodedSeen.has(key)) fixtureFailures.push({ field: `${vendor}/${tool.name}/${JSON.parse(key).join('/')}`, scalar: false, error: 'No encoded fixture checked' });
    scalarFields += scalarSeen.size; encodedFields += encodedSeen.size;
  }
  t.diagnostic(JSON.stringify({ vendor, tools: tools.length, scalarFields, scalarCases, encodedFields, encodedCases, failedScalarFields: new Set(fixtureFailures.filter(x => x.scalar).map(x => x.field)).size, failedFixtureCases: fixtureFailures.length }));
  assert.equal(fixtureFailures.length, 0, 'Every source field must have a valid fixture: ' + JSON.stringify(fixtureFailures.slice(0, 5)));
});
