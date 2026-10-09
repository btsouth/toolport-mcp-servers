'use strict';
// The full-API generator lives with its adapter so both use the same parameter and
// operation identity rules. It accepts a fetched JSON OpenAPI spec, without credentials.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { opKey, compileContract } = require('./contracts');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
function pointer(spec, ref) {
  if (!ref.startsWith('#/')) throw new Error('Only local OpenAPI references are supported');
  const value = ref.slice(2).split('/').reduce((x, key) => x?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
  if (!value) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
  return value;
}
function dereference(spec, value, seen = new Set()) {
  if (!value?.$ref) return value;
  if (seen.has(value.$ref)) throw new Error(`Circular parameter reference: ${value.$ref}`);
  return dereference(spec, { ...pointer(spec, value.$ref), ...Object.fromEntries(Object.entries(value).filter(([k]) => k !== '$ref')) }, new Set([...seen, value.$ref]));
}
function extractOperations(spec) {
  const entries = [];
  for (const [p, itemRef] of Object.entries(spec.paths || {})) {
    const item = dereference(spec, itemRef);
    for (const [method, operationRef] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      const operation = dereference(spec, operationRef);
      if (!operation?.operationId) continue;
      const params = new Map();
      for (const param of [...(item.parameters || []), ...(operation.parameters || [])]) {
        const resolved = dereference(spec, param);
        params.set(`${resolved.in}:${resolved.name}`, resolved);
      }
      entries.push({ id: operation.operationId, method: method.toUpperCase(), path: p, operation, params: [...params.values()] });
    }
  }
  const counts = new Map();
  for (const entry of entries) counts.set(opKey(entry.id), (counts.get(opKey(entry.id)) || 0) + 1);
  const seen = new Set();
  return entries.map(entry => {
    let key = opKey(entry.id);
    if (counts.get(key) > 1) key = key.slice(0, 53) + '_' + crypto.createHash('sha256').update(entry.id).digest('hex').slice(0, 10);
    if (seen.has(key)) throw new Error(`Duplicate operation identity: ${entry.id}`);
    seen.add(key);
    return { ...entry, key };
  });
}
function generate(spec) {
  const tools = [], operations = {};
  for (const entry of extractOperations(spec)) {
    const { key, method, path: p, operation, params } = entry;
    const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
    const definitions = {};
    const refs = new Map();
    function resolveSchema(s) {
      if (!s || typeof s !== 'object') return s;
      if (s.$ref) {
        const ref = s.$ref;
        if (!refs.has(ref)) {
          const name = `ref${refs.size}`;
          refs.set(ref, name);
          definitions[name] = {}; // reserve before descending into recursive schemas
          definitions[name] = resolveSchema(pointer(spec, ref));
        }
        return { ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$ref')), $ref: `#/$defs/${refs.get(ref)}` };
      }
      const out = { ...s };
      for (const k of ['properties', 'patternProperties']) if (out[k]) out[k] = Object.fromEntries(Object.entries(out[k]).map(([n, x]) => [n, resolveSchema(x)]));
      for (const k of ['items', 'additionalProperties', 'not']) if (typeof out[k] === 'object') out[k] = resolveSchema(out[k]);
      for (const k of ['oneOf', 'allOf', 'anyOf']) if (out[k]) out[k] = out[k].map(resolveSchema);
      return out;
    }
    for (const param of params) {
      if (!['path', 'query', 'header'].includes(param.in)) continue;
      if (Object.hasOwn(schema.properties, param.name)) throw new Error(`Parameter location collision: ${param.name}`);
      schema.properties[param.name] = resolveSchema({ ...(param.schema || { type: 'string' }), ...(param.description ? { description: param.description } : {}) });
      if (param.required || param.in === 'path') schema.required.push(param.name);
    }
    for (const [, name] of p.matchAll(/\{([^}]+)\}/g)) {
      schema.properties[name] ||= { type: 'string' };
      if (!schema.required.includes(name)) schema.required.push(name);
    }
    const body = operation.requestBody && dereference(spec, operation.requestBody);
    if (body) {
      const content = body.content || {};
      const media = content['application/json'] || content['application/x-www-form-urlencoded'] || Object.values(content)[0];
      if (!media) throw new Error(`Missing request content type for ${key}`);
      schema.properties.body = resolveSchema(media.schema || {});
      if (body.required) schema.required.push('body');
    }
    if (Object.keys(definitions).length) schema.$defs = definitions;
    const meta = { method, path: p,
      pathParams: [...p.matchAll(/\{([^}]+)\}/g)].map(x => x[1]),
      queryParams: params.filter(x => x.in === 'query').map(x => x.name),
      headerParams: params.filter(x => x.in === 'header').map(x => x.name),
      ...(body ? { contentType: Object.keys(body.content).find(k => ['application/json', 'application/x-www-form-urlencoded'].includes(k)) || Object.keys(body.content)[0] } : {}),
    };
    compileContract(schema, meta); // fail generation if it cannot be served faithfully
    tools.push({ name: key, description: [...new Set([operation.summary, operation.description].filter(Boolean))].join('. '), inputSchema: schema });
    operations[key] = meta;
  }
  return { tools, operations };
}
if (require.main === module) {
  const cfg = require(`../vendors/${process.env.VENDOR || 'stripe'}`);
  const root = path.join(__dirname, '..');
  const { tools, operations } = generate(JSON.parse(fs.readFileSync(path.resolve(root, cfg.specFile), 'utf8')));
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.writeFileSync(path.resolve(root, cfg.toolsFile), JSON.stringify(tools, null, 2));
  fs.writeFileSync(path.join(root, 'out', cfg.out.operations), JSON.stringify(operations, null, 2));
  console.log(`Generated ${tools.length} tools and routes`);
}
module.exports = { generate, extractOperations };
