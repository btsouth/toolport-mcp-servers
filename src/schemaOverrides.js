'use strict';
const { isDeepStrictEqual } = require('node:util');
// Exact validation shapes from the bundled source catalog and the cached
// official Vercel spec. Alternatives explicitly cover those two snapshots.
const sources = require('./schemaOverrideSources.json');
// Keep validation keywords and property names; documentation may change freely.
function sourceShape(s) {
  if (Array.isArray(s)) return s.map(sourceShape);
  if (!s || typeof s !== 'object') return s;
  return Object.fromEntries(Object.entries(s)
    .filter(([key]) => !['description', 'example', 'examples', 'title'].includes(key))
    .map(([key, value]) => [key, ['properties', 'patternProperties', '$defs', 'definitions'].includes(key)
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, sourceShape(child)])) : sourceShape(value)]));
}
function inclusive(s) { s.anyOf = s.oneOf; delete s.oneOf; }
function applySchemaOverrides(vendor, operation, schema) {
  if (vendor !== 'vercel') return;
  const rules = sources.filter(x => x.operation === operation);
  // Validate all sources before mutating any of them. Unknown shapes need review.
  const targets = rules.map(rule => {
    const target = rule.path.reduce((s, key) => s?.[key], schema);
    if (![rule.source, ...(rule.alternatives || [])].some(s => isDeepStrictEqual(s, sourceShape(target)))) {
      throw new Error(`Schema override source changed: ${operation}/${rule.path.join('/')}`);
    }
    return target;
  });
  rules.forEach((rule, i) => {
    const target = targets[i];
    // SDK smartUnion, preserving every branch and its constraints:
    // https://github.com/vercel/sdk/blob/main/src/models/createprojectcheckop.ts
    // https://github.com/vercel/sdk/blob/main/src/models/updateattackchallengemodeop.ts
    // https://github.com/vercel/sdk/blob/main/src/models/updateprojectsourcesprojects2.ts
    if (rule.repair === 'union') inclusive(target);
    // Both nested and outer drain unions are non-exclusive in the SDK:
    // https://github.com/vercel/sdk/blob/main/src/models/createdrainop.ts
    // https://github.com/vercel/sdk/blob/main/src/models/updatedrainop.ts
    if (rule.repair === 'drain') { inclusive(target.oneOf[0]); inclusive(target); }
    // https://vercel.com/docs/rest-api/dns/create-a-dns-record
    if (rule.repair === 'dns') {
      const name = target.anyOf[0].properties.name;
      for (const branch of target.anyOf) if (branch.required.includes('name') && !branch.properties.name) branch.properties.name = structuredClone(name);
    }
    // Optional milliseconds in the official SDK; retain outer constraints.
    // https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/src/sandbox.ts
    if (rule.repair === 'expiration') { Object.assign(target, target.oneOf[1]); delete target.oneOf; }
    // https://github.com/vercel/sdk/blob/main/src/models/patchedgeconfigitemsop.ts
    // The cached newer spec already has the exact nullable string shape. It is
    // explicitly recorded as an alternative, not accepted as arbitrary drift.
    if (rule.repair === 'description' && target.oneOf) {
      Object.assign(target, target.oneOf.find(x => x.type === 'string'));
      delete target.oneOf;
    }
  });
}
module.exports = { applySchemaOverrides };
