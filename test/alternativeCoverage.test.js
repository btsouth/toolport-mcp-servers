'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtures } = require('./helpers/schemaValues');
const { alternativeKey, missingAlternatives } = require('./helpers/alternativeCoverage');
test('success at one path never masks an omitted union alternative at that path', () => {
  const f = fixtures({ type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'string' }] } } });
  const nodes = f.nodes().filter(x => x.scalar);
  assert.equal(nodes.length, 2);
  const expected = new Map(nodes.map(node => [alternativeKey(node), { field: 'value' }]));
  assert.equal(expected.size, 2);
  const checked = new Set([alternativeKey(nodes[0])]);
  const failures = new Map([[alternativeKey(nodes[1]), { field: 'value branch 1', error: 'No valid fixture' }]]);
  assert.deepEqual(missingAlternatives(expected, checked, failures), [{ field: 'value branch 1', error: 'No valid fixture' }]);
  assert.equal(missingAlternatives(expected, checked, new Map()).length, 1, 'empty candidate lists also fail coverage');
  checked.add(alternativeKey(nodes[1]));
  assert.deepEqual(missingAlternatives(expected, checked, failures), []);
});
test('fixtures cannot fall back to a different union alternative after selected-branch failure', () => {
  const schema = { type: 'object', properties: { value: { anyOf: [{ type: 'string', enum: [] }, { type: 'integer' }] } }, required: ['value'] };
  const f = fixtures(schema), node = f.nodes().find(x => x.scalar && x.schema.type === 'string');
  assert.throws(() => f.sample(schema, [], undefined, node.choices), /No union fixture/);
});
test('fixtures try every enum value when the first value overlaps another alternative', () => {
  const schema = { type: 'object', required: ['value'], properties: { value: { oneOf: [{ type: 'string', enum: ['shared', 'unique'] }, { type: 'string', enum: ['shared'] }] } } };
  const f = fixtures(schema), node = f.nodes().find(x => x.scalar && x.alternatives[0].index === 0);
  const args = f.values(node.schema).map(value => {
    try { return f.sample(schema, node.path, value, node.choices); } catch { return null; }
  }).find(Boolean);
  assert.deepEqual(args, { value: 'unique' });
  assert.equal(f.valid(schema, args), true);
});
test('fixture discriminators respect maxProperties while keeping the forced field', () => {
  const schema = { type: 'object', minProperties: 1, maxProperties: 1, properties: { all: { type: 'boolean', enum: [true] }, list: { type: 'array', minItems: 1, items: { type: 'string' } } } };
  const f = fixtures(schema);
  const args = f.sample(schema, ['list', 0], 'plain');
  assert.deepEqual(args, { list: ['plain'] });
  assert.equal(f.valid(schema, args), true);
});
