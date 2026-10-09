'use strict';
// Independent deterministic OpenAPI fixtures. Every generated call is also checked
// against the untouched source schema, so fixture mistakes cannot hide rejections.
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { nativeSchema } = require('../../src/contracts');
const formats = {
  email: 'fixture@example.com', uri: 'https://example.com', hostname: 'example.com',
  ipv4: '192.0.2.1', ipv6: '2001:db8::1', uuid: '123e4567-e89b-42d3-a456-426614174000',
  'date-time': '2026-01-01T00:00:00Z', regex: '^fixture$', currency: 'usd', decimal: '1.5',
};
const strings = ['fixture', 'abc', 'a', '', '0', '123', 'example.com', 'https://example.com', '/fixture',
  '12345678', '+12345678901', 'aa', 'AA', 'a'.repeat(10) + '.proxy.cloudflare-gateway.com',
  'a'.repeat(32), 'a'.repeat(40), '#abcdef', 'ecfg_fixture', 'icfg_fixture', 'iap_fixture', 'ag_fixture',
  'org_' + 'a'.repeat(27), 'user_' + 'a'.repeat(27), 'mch_' + 'a'.repeat(27),
  'ak_' + 'a'.repeat(32), 'aplt_' + 'a'.repeat(32), 'mt_' + 'a'.repeat(32), 'flags/fixture'];
function resolve(s, root) {
  if (!s.$ref) return s;
  const target = s.$ref.slice(2).split('/').reduce((x, k) => x[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  return resolve({ ...target, ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$ref')) }, root);
}
function merge(a, b) {
  const out = { ...a, ...b };
  if (a.properties || b.properties) {
    out.properties = { ...a.properties };
    for (const [k, s] of Object.entries(b.properties || {})) out.properties[k] = out.properties[k] ? { allOf: [out.properties[k], s] } : s;
  }
  if (a.required || b.required) out.required = [...new Set([...(a.required || []), ...(b.required || [])])];
  for (const k of ['minLength', 'minimum', 'minItems', 'minProperties']) if (a[k] !== undefined && b[k] !== undefined) out[k] = Math.max(Number(a[k]), Number(b[k]));
  for (const k of ['maxLength', 'maximum', 'maxItems', 'maxProperties']) if (a[k] !== undefined && b[k] !== undefined) out[k] = Math.min(Number(a[k]), Number(b[k]));
  if (a.enum && b.enum) out.enum = a.enum.filter(x => b.enum.includes(x));
  return out;
}
function flatten(s, root) {
  s = resolve(s, root);
  if (!s.allOf) return s;
  const base = { ...s }; delete base.allOf;
  return s.allOf.reduce((a, b) => merge(a, flatten(b, root)), base);
}
function fixtures(root) {
  const ajv = new Ajv({ strict: false, validateFormats: true, logger: false });
  addFormats(ajv);
  const validators = new WeakMap(), shapes = new WeakMap(), unions = new WeakMap();
  function shape(original) {
    if (!shapes.has(original)) shapes.set(original, flatten(original, root));
    return shapes.get(original);
  }
  function unionShapes(s) {
    if (!unions.has(s)) {
      const base = { ...s }; delete base.anyOf; delete base.oneOf;
      unions.set(s, (s.anyOf || s.oneOf).map(branch => merge(base, branch)));
    }
    return unions.get(s);
  }
  function valid(s, value) {
    if (!validators.has(s)) validators.set(s, ajv.compile({ ...nativeSchema(s), ...(root.$defs ? { $defs: nativeSchema(root.$defs) } : {}), ...(root.definitions ? { definitions: root.definitions } : {}) }));
    return validators.get(s)(value);
  }
  function sample(original, target = [], forced, choices = new Map(), here = [], depth = 0) {
    if (depth > 20) throw new Error('Fixture recursion exceeded');
    if (target.length && JSON.stringify(target) === JSON.stringify(here)) return forced;
    const s = shape(original);
    const union = s.anyOf || s.oneOf;
    if (union) {
      const selected = choices.get(union);
      const failures = [];
      for (const branch of selected === undefined ? unionShapes(s) : [unionShapes(s)[selected]]) {
        try { const value = sample(branch, target, forced, choices, here, depth + 1); if (valid(original, value)) return value; failures.push(JSON.stringify(validators.get(original).errors)); } catch (e) { failures.push(e.message); }
      }
      throw new Error(`No union fixture at /${here.join('/')}: ${failures.slice(0, 2).join('; ')}`);
    }
    const type = s.type || (s.properties ? 'object' : s.items ? 'array' : s.enum ? typeof s.enum[0] : 'object');
    const types = [].concat(type).filter(x => x !== 'null');
    const candidates = [s.example, ...(s.examples || []), s.default, ...(s.enum || [])].filter(x => x !== undefined && x !== null);
    if (types.includes('object')) {
      const value = {};
      for (const [key, child] of Object.entries(s.properties || {})) {
        if (child.enum?.length === 1 || (s.required || []).includes(key) || (here.every((x, i) => target[i] === x) && target[here.length] === key)) value[key] = sample(child, target, forced, choices, [...here, key], depth + 1);
      }
      if (target[here.length] === 'fixture_key' && here.every((x, i) => target[i] === x)) value.fixture_key = sample(typeof s.additionalProperties === 'object' ? s.additionalProperties : {}, target, forced, choices, [...here, 'fixture_key'], depth + 1);
      for (let i = Object.keys(value).length; i < Number(s.minProperties || 0); i++) {
        const key = Object.keys(s.properties || {}).find(k => !(k in value));
        if (key) value[key] = sample(s.properties[key], [], undefined, choices, [...here, key], depth + 1);
        else value[`fixture_${i}`] = typeof s.additionalProperties === 'object' ? sample(s.additionalProperties, [], undefined, choices, [...here, `fixture_${i}`], depth + 1) : 'fixture';
      }
      candidates.unshift(value);
    }
    if (types.includes('array')) {
      const count = Math.max(Number(s.minItems || 0), here.every((x, i) => target[i] === x) && target[here.length] === 0 ? 1 : 0);
      candidates.unshift(Array.from({ length: count }, (_, i) => sample(s.items || {}, target, forced, choices, [...here, i], depth + 1)));
    }
    if (types.includes('string')) {
      if (formats[s.format]) candidates.push(formats[s.format]);
      candidates.push(...strings);
      for (const char of ['a', '0', 'A']) candidates.push(char.repeat(Math.max(1, Number(s.minLength || 0))));
    }
    if (types.some(x => ['number', 'integer'].includes(x))) {
      const min = Number(s.minimum ?? 0), max = Number(s.maximum ?? Math.max(1, min + 1));
      candidates.push(min, min + 1, max, Math.ceil((min + max) / 2), 1, 0);
    }
    if (types.includes('boolean')) candidates.push(true, false);
    if (s.nullable || [].concat(type).includes('null')) candidates.push(null);
    for (const value of candidates) {
      if (target.length && here.every((x, i) => target[i] === x)) {
        const actual = target.slice(here.length).reduce((x, key) => x?.[key], value);
        if (JSON.stringify(actual) !== JSON.stringify(forced)) continue;
      }
      if (valid(original, value)) return value;
    }
    throw new Error(`No valid ${type} fixture at /${here.join('/')}: ${JSON.stringify(s).slice(0, 300)}`);
  }
  function fields(original = root, here = [], choices = new Map(), active = new Set(), all = false) {
    if (original.$ref && active.has(original.$ref)) return [];
    if (original.$ref) active = new Set([...active, original.$ref]);
    const s = shape(original), union = s.anyOf || s.oneOf;
    if (union) {
      return unionShapes(s).flatMap((branch, i) => fields(branch, here, new Map([...choices, [union, i]]), active, all));
    }
    const type = s.type || (s.properties ? 'object' : s.items ? 'array' : s.enum ? typeof s.enum[0] : null);
    const scalar = [].concat(type).some(x => ['string', 'number', 'integer', 'boolean'].includes(x));
    const out = scalar || all ? [{ path: here, schema: original, choices, scalar }] : [];
    for (const [key, child] of Object.entries(s.properties || {})) out.push(...fields(child, [...here, key], choices, active, all));
    if (s.items) out.push(...fields(s.items, [...here, 0], choices, active, all));
    if (typeof s.additionalProperties === 'object') out.push(...fields(s.additionalProperties, [...here, 'fixture_key'], choices, active, all));
    return out;
  }
  return { sample, fields, nodes: () => fields(root, [], new Map(), new Set(), true), valid, flatten: shape };
}
module.exports = { fixtures };
