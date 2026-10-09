'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { compileContract, routingFor, nativeSchema } = require('../src/contracts');
const { generate } = require('../src/generate');

// Standard JSON Schema subset for Anthropic, OpenAI non-strict tools and
// Gemini parametersJsonSchema. Required lists contain only API-required fields.
const allowed = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf']);
function dialect(s, root = true, depth = 0, totals = { properties: 0, enums: 0, strings: 0 }) {
  assert.ok(depth <= 10);
  for (const k of Object.keys(s)) assert.ok(allowed.has(k), `unsupported keyword ${k}`);
  if (root) { assert.equal(s.type, 'object'); assert.equal(s.anyOf, undefined); }
  if (s.anyOf) { s.anyOf.forEach(x => dialect(x, false, depth, totals)); return totals; }
  assert.ok(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(s.type));
  if (s.type === 'object') {
    assert.ok(typeof s.additionalProperties === 'boolean' || typeof s.additionalProperties === 'object');
    if (typeof s.additionalProperties === 'object') dialect(s.additionalProperties, false, depth + 1, totals);
    for (const key of s.required) assert.ok(Object.hasOwn(s.properties, key));
    for (const [k, v] of Object.entries(s.properties)) {
      assert.match(k, /^[a-zA-Z0-9_.-]{1,64}$/);
      totals.properties++; totals.strings += k.length;
      dialect(v, false, depth + 1, totals);
    }
  }
  if (s.type === 'array') { assert.ok(s.items); dialect(s.items, false, depth + 1, totals); }
  if (s.enum) { totals.enums += s.enum.length; totals.strings += s.enum.join('').length; }
  assert.ok(totals.properties <= 5000); assert.ok(totals.enums <= 1000); assert.ok(totals.strings <= 120000);
  return totals;
}
for (const vendor of ['stripe', 'vercel', 'clerk', 'cloudflare']) {
  test(`${vendor}: every full/core tool has a client-safe schema and required path fields`, () => {
    const ops = require(`../data/${vendor}.operations.json`);
    const map = require(`../data/${vendor}.namemap.json`);
    const rev = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
    const ajv = new Ajv({ strict: true });
    for (const subset of ['', '-core']) {
      const tools = require(`../data/${vendor}-curated${subset}.tools.json`);
      assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
      for (const tool of tools) {
        assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
        const meta = routingFor(ops, rev[tool.name]);
        const { inputSchema } = compileContract(tool.inputSchema, meta);
        dialect(inputSchema);
        new Ajv({ strict: false, validateFormats: false, logger: false }).compile(nativeSchema(tool.inputSchema));
        assert.equal(ajv.validateSchema(inputSchema), true, tool.name);
        for (const [, field] of meta.path.matchAll(/\{([^}]+)\}/g)) {
          assert.ok(inputSchema.properties[field], `${tool.name}: ${field}`);
          assert.ok(inputSchema.required.includes(field));
          assert.equal(inputSchema.properties[field].anyOf, undefined, 'path must not become optional');
          assert.ok(meta.pathParams.includes(field));
        }
      }
    }
  });
}
test('generator resolves inherited/referenced parameters and recursive/deep refs', () => {
  const spec = { components: { parameters: { Id: { name: 'projectId', in: 'path', schema: { type: 'string' } } }, schemas: {
    First: { $ref: '#/components/schemas/Second' }, Second: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, next: { $ref: '#/components/schemas/Second' } } },
  } }, paths: { '/projects/{projectId}/{entryId}': {
    parameters: [{ $ref: '#/components/parameters/Id' }], post: { operationId: 'createEntry', parameters: [{ name: 'entryId', in: 'path', schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/First' } } } } },
  } } };
  const { tools, operations } = generate(spec);
  const contract = compileContract(tools[0].inputSchema, operations.createEntry);
  dialect(contract.inputSchema);
  assert.deepEqual(contract.decode({ projectId: 'p', entryId: 'e', body: { label: 'one', next: '{"label":"two"}' } }).body, { label: 'one', next: { label: 'two' } });
  assert.throws(() => contract.decode({ entryId: 'e', body: '{}' }), /projectId/);
  assert.throws(() => contract.decode({ projectId: 'p', entryId: 'e', body: { label: 1 } }), /Invalid arguments/);
});
test('oneOf, allOf, formats, enums and explicit nullable values retain API validation', () => {
  const schema = { type: 'object', properties: {
    payload: { oneOf: [{ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }, { type: 'integer' }] },
    count: { type: 'integer', minimum: 1, exclusiveMinimum: true },
    page: { type: 'integer', maximum: '5e+06' },
    email: { type: 'string', format: 'email' },
    value: { type: 'string', nullable: true },
    mode: { enum: ['preview', 'production'] },
    options: { allOf: [{ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, { type: 'object', properties: { id: { minLength: 2 } } }] },
  }, required: ['payload', 'count', 'mode', 'options'] };
  const contract = compileContract(schema, { path: '/items', pathParams: [] });
  dialect(contract.inputSchema);
  const good = { payload: '{"name":"app"}', count: 2, value: null, mode: 'preview', options: '{"id":"ok"}' };
  assert.equal(contract.decode(good).value, null);
  assert.equal(contract.decode({ ...good, value: 'legacy string' }).value, 'legacy string');
  assert.equal(contract.decode({ ...good, value: null }).value, null);
  for (const bad of [{ ...good, page: 5000001 }, { ...good, email: 'invalid email' }, { ...good, mode: 'bad' }, { ...good, count: 1 }, { ...good, options: '{"id":"x"}' }, { ...good, payload: '{"unknown":true}' }]) assert.throws(() => contract.decode(bad), /Invalid arguments/);
});
test('aliases restore original fields and reject ambiguous keys', () => {
  const contract = compileContract({ properties: { "'x-Cwd'": { type: 'string' } } }, { path: '/file', pathParams: [] });
  assert.deepEqual(contract.decode({ 'x-Cwd': 'app' }), { "'x-Cwd'": 'app' });
  assert.throws(() => contract.decode({ 'x-Cwd': 'app', "'x-Cwd'": 'other' }), /both original and alias/);
  assert.throws(() => compileContract({ properties: { "'x-Cwd'": {}, 'x-Cwd': {} } }, { path: '/file', pathParams: [] }), /collision/);
});
test('generator preserves full internal IDs and rejects duplicate operations', () => {
  const prefix = 'a'.repeat(70);
  const spec = { paths: { '/a': { get: { operationId: prefix + 'A' } }, '/b': { get: { operationId: prefix + 'B' } } } };
  const out = generate(spec);
  assert.equal(new Set(out.tools.map(t => t.name)).size, 2);
  assert.deepEqual(out.tools.map(t => t.name), [prefix + 'A', prefix + 'B']);
  spec.paths['/b'].get.operationId = prefix + 'A';
  assert.throws(() => generate(spec), /Duplicate operation identity/);
});
module.exports = { dialect };
test('numeric string exclusive bounds remain strict and request media matches its schema', () => {
  const contract = compileContract({ properties: { count: { type: 'integer', minimum: '2', exclusiveMinimum: true } }, required: ['count'] }, { path: '/items', pathParams: [] });
  assert.throws(() => contract.decode({ count: 2 }), /Invalid arguments/);
  assert.deepEqual(contract.decode({ count: 3 }), { count: 3 });
  const { tools, operations } = generate({ paths: { '/items': { post: { operationId: 'createItem', requestBody: { content: {
    'application/x-www-form-urlencoded': { schema: { type: 'string' } },
    'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false } },
  } } } } } });
  assert.equal(operations.createItem.contentType, 'application/json');
  assert.equal(tools[0].inputSchema.properties.body.type, 'object');
});
test('real nested inputs advertise their key fields and string-or-empty unions accept plain strings', () => {
  for (const [vendor, name, keys] of [
    ['vercel', 'create_project_env', ['key', 'value', 'target', 'type']],
    ['vercel', 'add_project_member', ['uid', 'role']],
    ...['create_dns_record', 'update_dns_record', 'patch_dns_record'].map(name => ['cloudflare', name, ['type', 'name', 'content', 'ttl', 'proxied']]),
  ]) {
    const tool = require(`../data/${vendor}-curated.tools.json`).find(t => t.name === name);
    const map = require(`../data/${vendor}.namemap.json`), ops = require(`../data/${vendor}.operations.json`);
    const op = Object.keys(map).find(k => map[k] === name);
    const { inputSchema } = compileContract(tool.inputSchema, routingFor(ops, op));
    const body = inputSchema.properties.body;
    assert.notEqual(body.type, 'string', name);
    for (const key of keys) assert.match(JSON.stringify(body), new RegExp(`"${key}"`), name);
  }
  const tools = require('../data/stripe-curated.tools.json');
  const map = require('../data/stripe.namemap.json'), ops = require('../data/stripe.operations.json');
  const tool = tools.find(t => t.name === 'preview_invoices_create');
  const op = Object.keys(map).find(k => map[k] === tool.name);
  const contract = compileContract(tool.inputSchema, routingFor(ops, op));
  assert.equal(contract.inputSchema.properties.body.properties.on_behalf_of.type, 'string');
  assert.equal(contract.decode({ body: { on_behalf_of: 'acct_123' } }).body.on_behalf_of, 'acct_123');
});
test('fallback summaries resolve refs, name required fields, and JSON errors include paths', () => {
  const schema = { properties: { body: { not: { type: 'null' }, anyOf: [{ type: 'object' }], properties: { key: { type: 'string' }, value: { $ref: '#/$defs/value' } }, required: ['key'] } }, $defs: { value: { enum: ['a', 'b'] } } };
  const c = compileContract(schema, { path: '/', pathParams: [] });
  assert.match(c.inputSchema.properties.body.description, /key \(required\): string/);
  assert.match(c.inputSchema.properties.body.description, /value\?: "a"\|"b"/);
  assert.throws(() => c.decode({ body: 'not JSON' }), /at \/body/);
});
test('validation errors describe expected types, enum values and missing properties', () => {
  const c = compileContract({ properties: { body: { type: 'object', properties: { count: { type: 'integer' }, mode: { enum: ['a', 'b'] } }, required: ['count'] } }, required: ['body'] }, { path: '/', pathParams: [] });
  assert.throws(() => c.decode({ body: { count: 'wrong' } }), /\/body\/count: must be integer/);
  assert.throws(() => c.decode({ body: {} }), /\/body\/count: must have required property/);
  assert.throws(() => c.decode({ body: { count: 1, mode: 'bad' } }), /allowed values: \["a","b"\]/);
});
test('union decoding selects the valid branch and nullable refs preserve explicit null', () => {
  const c = compileContract({ properties: { body: { oneOf: [
    { type: 'object', properties: { kind: { enum: ['a'] }, payload: { type: 'integer' } }, required: ['kind', 'payload'] },
    { type: 'object', properties: { kind: { enum: ['b'] }, payload: { type: 'object', properties: { name: { type: 'string' } } } }, required: ['kind', 'payload'] },
  ] }, note: { $ref: '#/$defs/note' } }, $defs: { note: { type: 'string', nullable: true } } }, { path: '/', pathParams: [] });
  assert.deepEqual(c.decode({ body: { kind: 'b', payload: '{"name":"valid"}' }, note: null }), { body: { kind: 'b', payload: { name: 'valid' } }, note: null });
});
test('plain strings still decode after schema expansion reaches its budget', () => {
  const wide = Object.fromEntries(Array.from({ length: 399 }, (_, i) => [`field${i}`, { type: 'integer' }]));
  const c = compileContract({ properties: { wide: { type: 'object', properties: wide }, account: { anyOf: [{ type: 'string' }, { type: 'string', enum: [''] }] }, label: { type: 'string' } } }, { path: '/', pathParams: [] });
  assert.equal(c.inputSchema.properties.account.type, 'string');
  assert.equal(c.decode({ account: 'acct_123', label: 'plain label' }).account, 'acct_123');
  for (const label of ['plain label', '123', 'true', 'null', '"quoted"', '']) assert.equal(c.decode({ label }).label, label);
});
test('generator excludes all controlled headers, including required and mixed-case ones', () => {
  const headers = ['Content-Length', 'Host', 'aUtHoRiZaTiOn', 'Content-Type', 'Transfer-Encoding'];
  const { tools, operations } = generate({ paths: { '/upload': { post: { operationId: 'upload', parameters: headers.map(name => ({ name, in: 'header', required: true, schema: { type: 'string' } })) } } } });
  assert.deepEqual(operations.upload.headerParams, []);
  assert.deepEqual(tools[0].inputSchema.properties, {});
  assert.deepEqual(tools[0].inputSchema.required, []);
});
