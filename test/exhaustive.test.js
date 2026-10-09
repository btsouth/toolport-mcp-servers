'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { createHash } = require('node:crypto');
const omissions = require('./helpers/fixtureOmissions.json');
const { compileContract, routingFor, schemaSummary, compact, nativeSchema } = require('../src/contracts');
const { fixtures } = require('./helpers/schemaValues');
const { alternativeKey: coverageKey, missingAlternatives } = require('./helpers/alternativeCoverage');
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
  if (s.type === 'object' && s.required?.some(k => !Object.hasOwn(value, k))) return -100000;
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).reduce((score, [k, v]) => {
    const child = s.properties?.[alias(k)];
    return score + (child ? 10 + shapeScore(child, v) : 0);
  }, 1);
  return 1;
}
function hasEncodedAt(s, keys, descriptions) {
  if (!s) return false;
  if (!keys.length && /JSON-encoded value:/.test(s.description || '')) return !descriptions || describes(s, descriptions);
  if (s.anyOf?.some(x => hasEncodedAt(x, keys, descriptions))) return true;
  if (!keys.length) return false;
  const [key, ...rest] = keys;
  return hasEncodedAt(typeof key === 'number' ? s.items : s.properties?.[alias(key)] || (typeof s.additionalProperties === 'object' ? s.additionalProperties : null), rest, descriptions);
}
function describes(s, summaries) {
  const at = s?.description?.indexOf('JSON-encoded value:');
  return at >= 0 && [...summaries].some(x => x.startsWith(s.description.slice(at)));
}
function wireSchema(s, value, encodedKeys, descriptions) {
  if (!s.anyOf) return s;
  const candidates = encodedKeys ? s.anyOf.filter(x => hasEncodedAt(x, encodedKeys, descriptions) && shapeScore(x, value) >= 0) : s.anyOf;
  return wireSchema([...(candidates.length ? candidates : s.anyOf)].sort((a, b) => shapeScore(b, value) - shapeScore(a, value))[0], value, encodedKeys, descriptions);
}
function wireValue(s, value, encoded, encodedKeys, descriptions) {
  s = wireSchema(s, value, encodedKeys, descriptions);
  if (/JSON-encoded value:/.test(s.description || '')) { encoded.count++; return JSON.stringify(value); }
  if (Array.isArray(value)) return value.map((x, i) => wireValue(s.items, x, encoded, encodedKeys?.[0] === i ? encodedKeys.slice(1) : undefined, descriptions));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    const name = alias(k), child = s.properties?.[name] || (typeof s.additionalProperties === 'object' ? s.additionalProperties : null);
    return [name, child ? wireValue(child, v, encoded, encodedKeys?.[0] === k ? encodedKeys.slice(1) : undefined, descriptions) : v];
  }));
  return value;
}
function advertisedAt(s, keys, args, preferEncoded = false, descriptions) {
  let value = args;
  for (const [i, k] of keys.entries()) {
    s = wireSchema(s, value, preferEncoded ? keys.slice(i) : undefined, descriptions);
    if (/JSON-encoded value:/.test(s.description || '')) return null; // Scalar remains plain inside the encoded container.
    s = typeof k === 'number' ? s.items : s.properties?.[alias(k)] || (typeof s.additionalProperties === 'object' ? s.additionalProperties : null);
    value = value?.[k];
    if (!s) return null;
  }
  return wireSchema(s, value, preferEncoded ? [] : undefined, descriptions);
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
  const requestFailures = [];
  const allowed = omissions.filter(x => x.vendor === vendor), omitted = new Set();
  let omittedCases = 0;
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
    const expectedEncoded = encodedPaths(wire), omittedEncoded = new Set(), eligibleEncoded = new Set();
    const failures = new Map(), expectedAlternatives = new Map(), checkedAlternatives = new Set();
    for (const node of f.nodes().filter(x => x.path.length)) {
      const fieldKey = JSON.stringify(node.path);
      const advertisedKey = JSON.stringify(node.path.map(k => typeof k === 'number' ? k : alias(k)));
      if (!node.scalar && !expectedEncoded.has(advertisedKey)) continue;
      const alternativeKey = coverageKey(node);
      const label = `${vendor}/${tool.name}/${node.path.join('/')} branches=${JSON.stringify(node.alternatives)}`;
      expectedAlternatives.set(alternativeKey, { field: label, scalar: node.scalar });
      let value, args;
      for (const candidate of f.values(node.schema)) {
        if (node.path.length === 1 && meta.pathParams.includes(node.path[0]) && (candidate === '' || candidate === null)) continue;
        try {
          args = f.sample(source, node.path, candidate, node.choices);
          value = candidate;
          break;
        } catch (e) { failures.set(alternativeKey, { field: label, scalar: node.scalar, error: e.message }); }
      }
      const omission = allowed.find(x => x.tool === tool.name && (x.subtree
        ? x.path.every((key, i) => node.path[i] === key) && x.alternatives.every(a => node.alternatives.some(b => JSON.stringify(a) === JSON.stringify(b)))
        : coverageKey(x) === alternativeKey));
      if (omission) {
        assert.ok(omission.reason, label);
        assert.equal(createHash('sha256').update(JSON.stringify(tool.inputSchema)).digest('hex'), omission.sourceHash, `${label}: omission source changed`);
        assert.equal(args, undefined, `${label}: omission is stale; this alternative now has a fixture`);
        omitted.add(omission); omittedCases++;
        omittedEncoded.add(advertisedKey);
        if (node.scalar) assert.doesNotMatch(JSON.stringify(compileContract({ properties: { field: node.schema } }, { path: '/', pathParams: [] }).inputSchema.properties.field), /JSON-encoded value:/, label);
        expectedAlternatives.delete(alternativeKey);
        continue;
      }
      if (node.scalar) expectedScalar.add(fieldKey);
      else eligibleEncoded.add(advertisedKey);
      if (!args) {
        failures.set(alternativeKey, failures.get(alternativeKey) || { field: label, scalar: node.scalar, error: 'No source-valid fixture for this alternative' });
        continue;
      }
      const preferEncoded = !node.scalar && expectedEncoded.has(advertisedKey);
      if (preferEncoded) args = f.scaffold(args, node, value);
      const descriptions = new Set([node.schema, f.flatten(node.schema), f.guidance(node.schema), nativeSchema(node.schema)].map(s => compact(`JSON-encoded value: ${schemaSummary(s, source)}.`, 100000)));
      let advertised = advertisedAt(wire, node.path, args, preferEncoded, descriptions);
      if (preferEncoded && !describes(advertised, descriptions)) advertised = advertisedAt(wire, node.path, args);
      const isEncoded = advertised && /JSON-encoded value:/.test(advertised.description || '');
      try {
        if (node.scalar) {
          assert.ok(value !== null && ['string', 'number', 'boolean'].includes(typeof value), label);
          if (advertised) assert.doesNotMatch(advertised.description || '', /JSON-encoded value:/, label);
        }
        assert.deepEqual(node.path.reduce((x, key) => x?.[key], args), value, `${label}: fixture must include the field under test`);
        assert.equal(f.valid(source, args), true, `${label}: generated source fixture must be valid`);
        const encoded = { count: 0 };
        const input = wireValue(wire, args, encoded, isEncoded ? node.path : undefined, descriptions);
        assert.equal(f.valid(wire, input), true, `${label}: encoded fixture must match the advertised schema`);
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
        checkedAlternatives.add(alternativeKey);
        if (node.scalar) { scalarSeen.add(JSON.stringify(node.path)); scalarCases++; }
        if (isEncoded) { encodedSeen.add(advertisedKey); encodedCases++; }
      } catch (e) { requestFailures.push({ field: label, error: e.message }); }
    }
    fixtureFailures.push(...missingAlternatives(expectedAlternatives, checkedAlternatives, failures));
    for (const key of expectedScalar) if (!scalarSeen.has(key)) fixtureFailures.push({ field: `${vendor}/${tool.name}/${JSON.parse(key).join('/')}`, scalar: true, error: 'No scalar fixture checked' });
    for (const key of expectedEncoded) if (!encodedSeen.has(key) && !(omittedEncoded.has(key) && !eligibleEncoded.has(key))) fixtureFailures.push({ field: `${vendor}/${tool.name}/${JSON.parse(key).join('/')}`, scalar: false, error: 'No encoded fixture checked' });
    scalarFields += scalarSeen.size; encodedFields += encodedSeen.size;
  }
  assert.equal(omitted.size, allowed.length, 'Every documented omission must still be encountered');
  t.diagnostic(JSON.stringify({ explainedOmissions: omittedCases, omissionRules: omitted.size, vendor, tools: tools.length, scalarFields, scalarCases, encodedFields, encodedCases, failedScalarFields: new Set(fixtureFailures.filter(x => x.scalar).map(x => x.field)).size, failedFixtureCases: fixtureFailures.length }));
  assert.equal(fixtureFailures.length + requestFailures.length, 0, 'Every field needs a source-valid fixture and an exact dry run: ' + JSON.stringify({ fixtureFailures, requestFailures }));
});

test('Vercel toast strings and self-served drain sources reach exact MCP dry-run requests', async t => {
  const cfg = require('../vendors/vercel'), tools = require('../data/vercel-curated.tools.json');
  const map = require('../data/vercel.namemap.json'), ops = require('../data/vercel.operations.json');
  const call = await dryClient(t, 'vercel');
  const cases = [
    ['updateProject', { idOrName: 'project_fixture', body: { dismissedToasts: [{ key: 'toast', dismissedAt: 100, action: 'accept', value: 'plain' }] } }],
    ['createDrain', { body: { name: 'fixture', projects: 'all', schemas: {}, source: { kind: 'self-served' } } }],
    ['updateDrain', { id: 'drain_fixture', body: { source: { kind: 'self-served' } } }],
  ];
  for (const [id, args] of cases) await t.test(id, async () => {
    const tool = tools.find(x => x.name === map[id]), meta = routingFor(ops, id);
    assert.deepEqual(compileContract(tool.inputSchema, meta).decode(args), args);
    const response = await call('tools/call', { name: tool.name, arguments: args });
    assert.equal(response.result?.isError, false, JSON.stringify(response));
    const expected = expectedRequest('vercel', cfg, meta, args);
    assert.equal(response.result.content[0].text,
      `DRY RUN (no ${cfg.apiKeyEnv} set). Would call:\n${meta.method} ${expected.url}\nbody: ${expected.body}\n\n[curated tool ${tool.name} -> ${id}]`);
    if (id === 'updateProject') {
      const invalid = structuredClone(args); invalid.body.dismissedToasts[0].value = {};
      assert.equal((await call('tools/call', { name: tool.name, arguments: invalid })).result.isError, true);
    } else {
      const invalid = structuredClone(args); invalid.body.source.kind = 100;
      assert.equal((await call('tools/call', { name: tool.name, arguments: invalid })).result.isError, true);
      invalid.body.source = { kind: 'self-served', typo: true };
      assert.equal((await call('tools/call', { name: tool.name, arguments: invalid })).result.isError, true);
    }
  });
});
