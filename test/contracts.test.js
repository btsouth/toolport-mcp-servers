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

test('referenced string branches accept native strings and preserve nullable input', () => {
  const c = compileContract({ properties: { value: { anyOf: [{ $ref: '#/$defs/string' }, { type: 'object', properties: { id: { type: 'integer' } } }] } }, $defs: { string: { type: 'string', nullable: true } } }, { path: '/', pathParams: [] });
  for (const value of ['acct_123', '123', 'null', '']) assert.equal(c.decode({ value }).value, value);
  assert.equal(c.decode({ value: null }).value, null);
  assert.deepEqual(c.decode({ value: '{"id":2}' }).value, '{"id":2}');
});

test('Cloudflare scalar allOf account IDs and annotation-only parts stay plain', () => {
  const name = 'patch_access_seats';
  const tool = require('../data/cloudflare-curated.tools.json').find(x => x.name === name);
  const map = require('../data/cloudflare.namemap.json'), ops = require('../data/cloudflare.operations.json');
  const c = compileContract(tool.inputSchema, routingFor(ops, Object.keys(map).find(k => map[k] === name)));
  const account_id = '023e105f4ecef8ad9ca31a8372d0c353';
  assert.equal(c.inputSchema.properties.account_id.type, 'string');
  assert.doesNotMatch(c.inputSchema.properties.account_id.description || '', /JSON-encoded/);
  assert.equal(c.decode({ account_id, body: [] }).account_id, account_id);
  const nested = compileContract({ properties: { value: { allOf: [{ $ref: '#/$defs/str' }, { example: 'abc' }] } }, $defs: { str: { anyOf: [{ type: 'string' }, { type: 'string', enum: [''] }] } } }, { path: '/', pathParams: [] });
  assert.equal(nested.inputSchema.properties.value.type, 'string');
  assert.equal(nested.decode({ value: '123' }).value, '123');
});
test('budget-exhausted Stripe scalars advertise and decode literal values', () => {
  const name = 'create_payment_intent';
  const tool = require('../data/stripe-curated.tools.json').find(x => x.name === name);
  const map = require('../data/stripe.namemap.json'), ops = require('../data/stripe.operations.json');
  const c = compileContract(tool.inputSchema, routingFor(ops, Object.keys(map).find(k => map[k] === name)));
  const field = c.inputSchema.properties.body.properties.statement_descriptor_suffix;
  assert.equal(field.type, 'string');
  assert.doesNotMatch(field.description || '', /JSON-encoded/);
  assert.equal(c.decode({ body: { amount: 100, currency: 'usd', statement_descriptor_suffix: 'ACME' } }).body.statement_descriptor_suffix, 'ACME');
  const wide = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field${i}`, { type: 'integer' }]));
  const budget = compileContract({ properties: { wide: { type: 'object', properties: wide }, count: { type: 'integer', enum: Array.from({ length: 501 }, (_, i) => i) }, enabled: { allOf: [{ type: 'boolean' }, { description: 'annotation' }] } } }, { path: '/', pathParams: [] });
  assert.equal(budget.inputSchema.properties.count.type, 'integer');
  assert.equal(budget.inputSchema.properties.count.enum, undefined);
  assert.equal(budget.inputSchema.properties.enabled.type, 'boolean');
  assert.deepEqual(budget.decode({ count: 1, enabled: true }), { count: 1, enabled: true });
  assert.throws(() => budget.decode({ count: 501 }), /allowed values/);
});
test('additional-property errors identify the rejected key at root and nested paths', () => {
  const c = compileContract({ properties: { body: { type: 'object', properties: {}, additionalProperties: false } } }, { path: '/', pathParams: [] });
  assert.throws(() => c.decode({ typo: 1 }), /at \/typo: must NOT have additional properties/);
  assert.throws(() => c.decode({ body: { typo: 1 } }), /at \/body\/typo: must NOT have additional properties/);
});

test('overlapping object unions decode known fields from nested intersections', () => {
  const schema = { properties: { policy: { anyOf: [
    { type: 'object', properties: { id: { type: 'string' } } },
    { allOf: [{ type: 'object' }, { allOf: [
      { properties: { id: { type: 'string' } } },
      { properties: { detail: { not: { type: 'number' }, type: 'object', properties: { enabled: { type: 'boolean' } } } } },
    ] }] },
    { type: 'string' },
  ] } } };
  const c = compileContract(schema, { path: '/', pathParams: [] });
  assert.deepEqual(c.decode({ policy: { detail: '{"enabled":true}' } }), { policy: { detail: { enabled: true } } });
  for (const policy of ['plain', '123', '{"enabled":true}']) assert.equal(c.decode({ policy }).policy, policy);
  assert.ok(c.inputSchema.properties.policy.anyOf.some(x => x.properties?.detail));
});

test('long structured descriptions always retain JSON encoding guidance', () => {
  const c = compileContract({ properties: { body: { description: 'guidance '.repeat(150), type: 'object', not: { type: 'number' } } } }, { path: '/', pathParams: [] });
  assert.match(c.inputSchema.properties.body.description, /JSON-encoded value:/);
  assert.deepEqual(c.decode({ body: '{"enabled":true}' }), { body: { enabled: true } });
});

test('Vercel DNS, expiration, Edge Config and attack-mode source repairs retain constraints', () => {
  const tools = require('../data/vercel-curated.tools.json');
  const map = require('../data/vercel.namemap.json'), ops = require('../data/vercel.operations.json');
  const contract = name => {
    const tool = tools.find(x => x.name === name);
    return compileContract(tool.inputSchema, routingFor(ops, Object.keys(map).find(k => map[k] === name)));
  };
  for (const body of [
    { name: '_service', type: 'SRV', srv: { priority: 10, weight: 10, port: 443, target: 'example.com' } },
    { name: 'text', type: 'TXT', value: 'plain' },
    { name: 'secure', type: 'HTTPS', https: { priority: 10, target: 'example.com' } },
  ]) {
    const c = contract('create_record');
    assert.deepEqual(c.decode({ domain: 'example.com', body }).body, body);
    const { name, ...missingName } = body;
    assert.throws(() => c.decode({ domain: 'example.com', body: missingName }), /Invalid arguments/);
    assert.throws(() => c.decode({ domain: 'example.com', body: { ...body, typo: true } }), /Invalid arguments/);
  }
  for (const name of ['create_sandbox', 'update_sandbox', 'create_session_snapshot']) {
    const tool = tools.find(x => x.name === name), c = contract(name);
    const meta = routingFor(ops, Object.keys(map).find(k => map[k] === name));
    const paths = Object.fromEntries(meta.pathParams.map(k => [k, 'fixture']));
    const key = name === 'create_session_snapshot' ? 'expiration' : 'snapshotExpiration';
    const args = { ...paths, body: { [key]: 604800000 } };
    assert.deepEqual(c.decode(args), args);
    assert.throws(() => c.decode({ ...paths, body: { [key]: {} } }), /Invalid arguments/);
    const { applySchemaOverrides } = require('../src/schemaOverrides');
    const source = structuredClone(tool.inputSchema);
    source.properties.body.properties[key] = { oneOf: [{}, { type: 'integer' }] };
    applySchemaOverrides('vercel', Object.keys(map).find(k => map[k] === name), source);
    assert.equal(source.properties.body.properties[key].type, 'integer');
    assert.equal(source.properties.body.properties[key].oneOf, undefined);
  }
  const item = { operation: 'create', key: 'fixture', value: {}, description: 'plain' };
  assert.deepEqual(contract('update_edge_config_item').decode({ edgeConfigId: 'ecfg_fixture', body: { items: [item] } }).body.items[0], item);
  assert.throws(() => contract('update_edge_config_item').decode({ edgeConfigId: 'ecfg_fixture', body: { items: [{ ...item, description: {} }] } }), /Invalid arguments/);
  assert.throws(() => contract('update_edge_config_item').decode({ edgeConfigId: 'ecfg_fixture', body: { items: [{ ...item, description: 'a'.repeat(513) }] } }), /Invalid arguments/);
  const body = { projectId: 'fixture', attackModeEnabled: true, attackModeActiveUntil: 100 };
  assert.deepEqual(contract('update_attack_challenge_mode').decode({ body }).body, body);
});

test('Vercel project check source follows the official SDK non-exclusive union', () => {
  const tool = require('../data/vercel-curated.tools.json').find(t => t.name === 'create_project_check');
  const meta = require('../data/vercel.operations.json').createProjectCheck;
  const c = compileContract(tool.inputSchema, meta);
  for (const source of [{ kind: 'integration', externalResourceId: 'resource_fixture' }, { kind: 'webhook', webhookId: 'hook_fixture' }, { kind: 'git-provider', provider: 'github', externalCheckName: 'fixture' }]) {
    assert.deepEqual(c.decode({ projectIdOrName: 'project_fixture', body: { name: 'fixture', source, requires: 'deployment-url', blocks: 'deployment-alias', timeout: 300 } }).body.source, source);
  }
  const { tools } = generate({ paths: { '/projects/{projectIdOrName}/checks': { post: { operationId: 'createProjectCheck', requestBody: { content: { 'application/json': { schema: { properties: { source: { type: 'object', oneOf: [{ properties: { kind: { type: 'string' } } }, { properties: { kind: { type: 'string' } }, required: ['kind'] }] } } } } } } } } } }, 'vercel');
  assert.ok(tools[0].inputSchema.properties.body.properties.source.anyOf);
  assert.equal(tools[0].inputSchema.properties.body.properties.source.oneOf, undefined);
});
test('referenced scalar compositions advertise plain types and preserve exact values', () => {
  const schema = { properties: {
    string: { allOf: [{ $ref: '#/$defs/text' }, { example: 'plain' }] },
    number: { anyOf: [{ $ref: '#/$defs/count' }, { type: 'number', minimum: 1 }] },
    boolean: { oneOf: [{ type: 'boolean', enum: [true] }, { type: 'boolean', enum: [false] }] },
  }, $defs: { text: { type: 'string', pattern: '^[a-z]+$' }, count: { type: 'integer', minimum: 1 } } };
  const c = compileContract(schema, { path: '/', pathParams: [] });
  const values = { string: 'plain', number: 1.5, boolean: false };
  assert.deepEqual(c.decode(values), values);
  for (const field of Object.values(c.inputSchema.properties)) assert.doesNotMatch(JSON.stringify(field), /JSON-encoded/);
  assert.throws(() => c.decode({ string: '123' }), /pattern/);
});

test('deep scalar arrays in Vercel firewall unions remain distinct from literal strings', () => {
  const tool = require('../data/vercel-curated.tools.json').find(x => x.name === 'update_firewall_config');
  const c = compileContract(tool.inputSchema, require('../data/vercel.operations.json').updateFirewallConfig);
  for (const value of [[], ['plain'], '[]', '123', 123]) {
    const args = { projectId: 'fixture', body: { action: 'rules.insert', value: { name: 'fixture', active: true, action: {}, conditionGroup: [{ conditions: [{ type: 'host', op: 're', value }] }] } } };
    assert.deepEqual(c.decode(args), args);
  }
});
