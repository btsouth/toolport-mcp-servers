'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applySchemaOverrides } = require('../src/schemaOverrides');
const { generate } = require('../src/generate');
const rules = require('../src/schemaOverrideSources.json');
function sourceFor(operation) {
  const schema = { properties: { body: {} } };
  for (const rule of rules.filter(x => x.operation === operation)) {
    let parent = schema;
    for (const [i, key] of rule.path.slice(0, -1).entries()) parent = parent[key] ||= typeof rule.path[i + 1] === 'number' ? [] : {};
    parent[rule.path.at(-1)] = structuredClone(rule.source);
  }
  return schema;
}
for (const rule of rules) test(`override rejects source drift: ${rule.operation}/${rule.path.join('/')}`, () => {
  const source = sourceFor(rule.operation);
  const changed = rule.path.reduce((s, key) => s[key], source);
  changed.not = { type: 'boolean' };
  const before = structuredClone(source);
  assert.throws(() => applySchemaOverrides('vercel', rule.operation, source), /Schema override source changed/);
  assert.deepEqual(source, before, 'failure must leave the source untouched');
  const changedType = sourceFor(rule.operation);
  rule.path.reduce((s, key) => s[key], changedType).type = 'boolean';
  assert.throws(() => applySchemaOverrides('vercel', rule.operation, changedType), /Schema override source changed/);
  const missing = sourceFor(rule.operation);
  delete rule.path.slice(0, -1).reduce((s, key) => s[key], missing)[rule.path.at(-1)];
  assert.throws(() => applySchemaOverrides('vercel', rule.operation, missing), /Schema override source changed/);
});
test('Edge Config string/integer drift fails generation instead of dropping integer support', () => {
  const source = sourceFor('patchEdgeConfigItems');
  const rule = rules.find(x => x.operation === 'patchEdgeConfigItems');
  const description = rule.path.reduce((s, key) => s[key], source);
  description.oneOf = [{ type: 'string', maxLength: 512 }, { type: 'integer' }];
  assert.throws(() => generate({ paths: { '/edge': { patch: { operationId: rule.operation, requestBody: { content: { 'application/json': { schema: source.properties.body } } } } } } }, 'vercel'), /Schema override source changed/);
});
test('known repairs preserve sibling constraints and recorded branch constraints', () => {
  for (const operation of new Set(rules.map(x => x.operation))) {
    const source = sourceFor(operation);
    source.maxProperties = 100;
    applySchemaOverrides('vercel', operation, source);
    assert.equal(source.maxProperties, 100);
  }
});

test('every recorded source variant is explicitly supported', () => {
  for (const rule of rules) for (const variant of [rule.source, ...(rule.alternatives || [])]) {
    const source = sourceFor(rule.operation);
    rule.path.slice(0, -1).reduce((s, key) => s[key], source)[rule.path.at(-1)] = structuredClone(variant);
    applySchemaOverrides('vercel', rule.operation, source);
    const repaired = rule.path.reduce((s, key) => s[key], source);
    if (rule.repair === 'description') {
      assert.equal(repaired.type, 'string');
      assert.equal(repaired.maxLength, 512);
      assert.equal(repaired.nullable, true);
    }
    if (['union', 'drain'].includes(rule.repair)) assert.deepEqual(repaired.anyOf, variant.oneOf.map((branch, i) => {
      if (rule.repair !== 'drain' || i !== 0) return branch;
      const { oneOf, ...rest } = branch; return { ...rest, anyOf: oneOf };
    }));
  }
});
