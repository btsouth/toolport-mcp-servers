'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { compileContract, routingFor, nativeSchema } = require('../src/contracts');
const { generate } = require('../src/generate');

// An independent allowlist for the closed JSON Schema subset, including OpenAI
// strict required/closed-object rules and Anthropic property-name restrictions.
const allowed = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf']);
function dialect(s, root = true, depth = 0, totals = { properties: 0, enums: 0, strings: 0 }) {
  assert.ok(depth <= 10);
  for (const k of Object.keys(s)) assert.ok(allowed.has(k), `unsupported keyword ${k}`);
  if (root) { assert.equal(s.type, 'object'); assert.equal(s.anyOf, undefined); }
  if (s.anyOf) { s.anyOf.forEach(x => dialect(x, false, depth, totals)); return totals; }
  assert.ok(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(s.type));
  if (s.type === 'object') {
    assert.equal(s.additionalProperties, false);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
    for (const [k, v] of Object.entries(s.properties)) {
      assert.match(k, /^[a-zA-Z0-9_.-]{1,64}$/);
      totals.properties++; totals.strings += k.length;
      dialect(v, false, depth + 1, totals);
    }
  }
  if (s.type === 'array') { assert.ok(s.items); dialect(s.items, false, depth + 1, totals); }
  if (s.enum) { assert.ok(s.enum.every(x => typeof x === 'string')); totals.enums += s.enum.length; totals.strings += s.enum.join('').length; }
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
  const good = { payload: '{"name":"app"}', count: 2, value: 'null', mode: 'preview', options: '{"id":"ok"}' };
  assert.equal(contract.decode(good).value, null);
  assert.equal(contract.decode({ ...good, value: 'legacy string' }).value, 'legacy string');
  assert.equal(Object.hasOwn(contract.decode({ ...good, value: null }), 'value'), false);
  for (const bad of [{ ...good, page: 5000001 }, { ...good, email: 'invalid email' }, { ...good, mode: 'bad' }, { ...good, count: 1 }, { ...good, options: '{"id":"x"}' }, { ...good, payload: '{"unknown":true}' }]) assert.throws(() => contract.decode(bad), /Invalid arguments/);
});
test('aliases restore original fields and reject ambiguous keys', () => {
  const contract = compileContract({ properties: { "'x-Cwd'": { type: 'string' } } }, { path: '/file', pathParams: [] });
  assert.deepEqual(contract.decode({ 'x-Cwd': 'app' }), { "'x-Cwd'": 'app' });
  assert.throws(() => contract.decode({ 'x-Cwd': 'app', "'x-Cwd'": 'other' }), /both original and alias/);
  assert.throws(() => compileContract({ properties: { "'x-Cwd'": {}, 'x-Cwd': {} } }, { path: '/file', pathParams: [] }), /collision/);
});
test('generator disambiguates long IDs and rejects duplicate operations', () => {
  const prefix = 'a'.repeat(70);
  const spec = { paths: { '/a': { get: { operationId: prefix + 'A' } }, '/b': { get: { operationId: prefix + 'B' } } } };
  const out = generate(spec);
  assert.equal(new Set(out.tools.map(t => t.name)).size, 2);
  assert.ok(out.tools.every(t => t.name.length <= 64));
  spec.paths['/b'].get.operationId = prefix + 'A';
  assert.throws(() => generate(spec), /Duplicate operation identity/);
});
module.exports = { dialect };
