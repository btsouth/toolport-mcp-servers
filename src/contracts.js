'use strict';
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: true, logger: false });
addFormats(ajv);

const opKey = (id) => String(id).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 64);
const compact = (s, max = 280) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);
const keyName = (key) => {
  if (/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) return key;
  return key.replace(/^['"]|['"]$/g, '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) || 'field';
};

// Keep the source constraints for local validation. OpenAPI 3.0 exclusive bounds are
// booleans; JSON Schema uses numbers. References remain local and are validated by Ajv.
function nativeSchema(schema) {
  if (typeof schema === 'boolean') return schema;
  const out = { ...schema };
  for (const k of ['properties', '$defs', 'definitions', 'patternProperties']) {
    if (out[k]) out[k] = Object.fromEntries(Object.entries(out[k]).map(([n, s]) => [n, nativeSchema(s)]));
  }
  for (const k of ['items', 'additionalProperties', 'not']) {
    if (out[k] && typeof out[k] === 'object') out[k] = nativeSchema(out[k]);
  }
  for (const k of ['anyOf', 'allOf', 'oneOf']) if (out[k]) out[k] = out[k].map(nativeSchema);
  for (const k of ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (typeof out[k] === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(out[k]) && Number.isFinite(Number(out[k]))) out[k] = Number(out[k]);
  }
  for (const k of ['exclusiveMinimum', 'exclusiveMaximum']) {
    if (typeof out[k] === 'boolean') {
      const bound = k === 'exclusiveMinimum' ? 'minimum' : 'maximum';
      if (out[k] && typeof out[bound] === 'number') { out[k] = out[bound]; delete out[bound]; }
      else delete out[k];
    }
  }
  // OpenAPI nullable may appear on a composition or enum without a type.
  if (out.nullable) {
    delete out.nullable;
    return { anyOf: [out, { type: 'null' }] };
  }
  delete out.nullable;
  return out;
}

function resolveLocal(s, root) {
  if (!s.$ref?.startsWith('#/')) throw new Error(`Only local schema references are supported: ${s.$ref}`);
  const target = s.$ref.slice(2).split('/').reduce((x, key) => x?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  if (!target) throw new Error(`Unresolved schema reference: ${s.$ref}`);
  return { ...target, ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$ref')) };
}
function schemaSummary(s, root, depth = 0, seen = new Set(), budget = { remaining: 60 }) {
  if (depth > 4 || budget.remaining-- <= 0) return s.type || 'JSON';
  if (s.$ref && !seen.has(s.$ref)) return schemaSummary(resolveLocal(s, root), root, depth, new Set([...seen, s.$ref]), budget);
  if (s.properties) {
    const required = new Set(s.required || []);
    return '{' + Object.entries(s.properties).sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a))).map(([k, v]) => `${k}${required.has(k) ? ' (required)' : '?'}: ${schemaSummary(v, root, depth + 1, seen, budget)}`).join(', ') + '}';
  }
  if (s.enum) return s.enum.map(x => JSON.stringify(x)).join('|');
  for (const k of ['oneOf', 'anyOf', 'allOf']) if (s[k]) return s[k].map(x => schemaSummary(x, root, depth + 1, seen, budget)).join(k === 'allOf' ? ' and ' : ' or ');
  if (s.items) return `array of ${schemaSummary(s.items, root, depth + 1, seen, budget)}`;
  return s.type || 'JSON';
}
const forbiddenHeader = name => /^(content-length|host|authorization|content-type|transfer-encoding)$/i.test(name.replace(/^['"]|['"]$/g, ''));

// An empty list means annotation-only (no type constraint); null means structured
// or unresolved. Scalar intersections and unions never need JSON-text decoding.
function scalarTypes(s, root, active = new Set()) {
  if (s.$ref) {
    if (active.has(s.$ref)) return null;
    return scalarTypes(resolveLocal(s, root), root, new Set([...active, s.$ref]));
  }
  let types = s.type ? [].concat(s.type) : s.enum ? [...new Set(s.enum.map(x => x === null ? 'null' : typeof x))] : [];
  if (s.properties || s.items || types.some(x => !['string', 'number', 'integer', 'boolean', 'null'].includes(x))) return null;
  const intersect = (a, b) => !a.length ? b : !b.length ? a : a.flatMap(x => b.flatMap(y => x === y ? [x] : [x, y].every(t => ['number', 'integer'].includes(t)) ? ['integer'] : []));
  for (const kind of ['allOf', 'anyOf', 'oneOf']) {
    if (!s[kind]) continue;
    const parts = s[kind].map(x => scalarTypes(x, root, active));
    if (parts.some(x => x === null)) return null;
    const combined = kind === 'allOf' ? parts.reduce(intersect, []) : parts.some(x => !x.length) ? [] : parts.flat();
    types = intersect(types, combined);
  }
  if (s.nullable && types.length) types.push('null');
  return [...new Set(types)];
}

function compileContract(source, meta) {
  const schema = structuredClone(source);
  schema.type = 'object';
  schema.properties ||= {};
  schema.required ||= [];
  schema.additionalProperties = false;
  for (const header of meta.headerParams || []) {
    if (forbiddenHeader(header)) { delete schema.properties[header]; schema.required = schema.required.filter(x => x !== header); }
  }
  for (const [, name] of meta.path.matchAll(/\{([^}]+)\}/g)) {
    schema.properties[name] ||= { type: 'string' };
    schema.properties[name].description = compact(`${schema.properties[name].description || ''} Required path parameter ${name}.`);
    if (!schema.required.includes(name)) schema.required.push(name);
  }
  const native = nativeSchema(schema);
  let validate;
  const budget = { properties: 0, enums: 0, strings: 0 };
  function allowsNull(s, active = new Set()) {
    if (s.$ref && !active.has(s.$ref)) return allowsNull(resolveLocal(s, schema), new Set([...active, s.$ref]));
    return s.nullable || s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null')) ||
      (s.anyOf || s.oneOf || []).some(x => allowsNull(x, active));
  }
  function allowsString(s, active = new Set()) {
    const types = scalarTypes(s, schema, active);
    if (types) return !types.length || types.includes('string');
    if (s.$ref && !active.has(s.$ref)) return allowsString(resolveLocal(s, schema), new Set([...active, s.$ref]));
    return s.type === 'string' || (Array.isArray(s.type) && s.type.includes('string')) ||
      s.enum?.some(x => typeof x === 'string') || (s.anyOf || s.oneOf || []).some(x => allowsString(x, active));
  }
  function visit(s, depth = 0, root = false, active = new Set()) {
    if (s.$ref && !active.has(s.$ref)) return visit(resolveLocal(s, schema), depth, root, new Set([...active, s.$ref]));
    if (s.nullable) return visit(nativeSchema(s), depth, root, active);
    const scalars = scalarTypes(s, schema, active);
    if (!root && scalars?.length) {
      const out = scalars.length === 1 ? { type: scalars[0] } : { anyOf: scalars.map(type => ({ type })) };
      if (s.description) out.description = compact(s.description);
      const branches = s.anyOf || s.oneOf;
      const values = s.enum || (branches?.every(x => x.enum) ? [...new Set(branches.flatMap(x => x.enum))] : undefined);
      if (values && budget.enums + values.length <= 500 && budget.strings + JSON.stringify(values).length <= 12000) {
        out.enum = values; budget.enums += values.length; budget.strings += JSON.stringify(values).length;
      }
      const hints = [];
      if (s.format) hints.push(`Format: ${s.format}`);
      for (const k of ['minimum', 'maximum', 'minLength', 'maxLength']) if (s[k] !== undefined) hints.push(`${k}: ${s[k]}`);
      if (hints.length) out.description = compact(`${out.description || ''} ${hints.join('; ')}.`, 500);
      return { schema: out, decode: value => value };
    }
    // Flatten object intersections for field guidance, retaining the original
    // intersection for authoritative local validation.
    if (s.allOf && !s.$ref && depth < 7) {
      const parts = s.allOf.map(x => x.$ref && !active.has(x.$ref) ? resolveLocal(x, schema) : x);
      if (parts.every(x => x.properties || x.type === 'object')) {
        const properties = { ...s.properties };
        for (const part of parts) for (const [key, child] of Object.entries(part.properties || {})) properties[key] = { ...properties[key], ...child };
        return visit({ ...s, allOf: undefined, type: 'object', properties, required: [...new Set([...(s.required || []), ...parts.flatMap(x => x.required || [])])] }, depth, root, active);
      }
    }
    const branches = s.anyOf || s.oneOf;
    if (branches && !s.$ref && !s.allOf && !s.not && depth < 7 && budget.properties < 400) {

      const validators = [];
      const plans = branches.map(x => visit({ ...x, ...(s.properties ? { properties: { ...s.properties, ...x.properties } } : {}) }, depth, false, active));
      return { schema: { anyOf: plans.map(x => x.schema), ...(s.description ? { description: compact(s.description) } : {}) }, decode(value, field) {
        // Legacy callers can still supply JSON text for structured unions.
        if (typeof value === 'string' && !branches.some(x => allowsString(x))) value = parse(value, field);
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        const matches = plans.filter(x => x.schema.type === type || (type === 'number' && x.schema.type === 'integer') || x.schema.anyOf);
        for (const plan of matches) {
          const index = plans.indexOf(plan);
          let decoded;
          try { decoded = plan.decode(value, field); } catch { continue; }
          validators[index] ||= ajv.compile({ ...nativeSchema(branches[index]), ...(native.$defs ? { $defs: native.$defs } : {}), ...(native.definitions ? { definitions: native.definitions } : {}) });
          if (validators[index](decoded)) return decoded;
        }
        return value;
      } };
    }
    const type = s.type || (s.properties ? 'object' : s.items ? 'array' : s.enum ? typeof s.enum[0] : null);
    const encoded = !root && (s.$ref || s.oneOf || s.allOf || s.anyOf || s.not ||
      !type || Array.isArray(type) || (depth >= 7 && ['object', 'array'].includes(type)) ||
      (type === 'array' && (!s.items || Array.isArray(s.items))) ||
      budget.properties + Object.keys(s.properties || {}).length > 400 ||
      budget.enums + (s.enum || []).length > 500 || budget.strings + JSON.stringify(s.enum || []).length > 12000);
    if (encoded) return {
      schema: { type: 'string', description: compact(`${s.description || ''} JSON-encoded value: ${schemaSummary(s, schema)}.`, 700) },
      decode(value, field) {
        if (typeof value !== 'string' || allowsString(s)) return value;
        return parse(value, field);
      },
    };
    const out = { type };
    if (s.description) out.description = compact(s.description);
    const hints = [];
    if (s.format) hints.push(`Format: ${s.format}`);
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (s[k] !== undefined) hints.push(`${k}: ${s[k]}`);
    if (hints.length) out.description = compact(`${out.description || ''} ${hints.join('; ')}.`, 500);
    if (s.enum) { out.enum = s.enum; budget.enums += s.enum.length; budget.strings += JSON.stringify(s.enum).length; }
    if (type === 'object') {
      out.properties = {};
      out.additionalProperties = s.additionalProperties !== false;
      const additional = typeof s.additionalProperties === 'object' ? visit(s.additionalProperties, depth + 1, false, active) : null;
      if (additional) out.additionalProperties = additional.schema;
      const fields = [];
      const required = new Set(s.required || []);
      for (const [original, child] of Object.entries(s.properties || {})) {
        const alias = keyName(original);
        if (Object.hasOwn(out.properties, alias)) throw new Error(`schema property alias collision: ${alias}`);
        budget.properties++; budget.strings += alias.length;
        const plan = visit(child, depth + 1, false, active);
        out.properties[alias] = plan.schema;
        fields.push({ original, alias, plan, optional: !required.has(original), nullable: allowsNull(child) });
      }
      out.required = fields.filter(x => !x.optional).map(x => x.alias);
      return { schema: out, decode(value, field = '') {
        if (typeof value === 'string') value = parse(value, field);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const result = { ...value };
        const known = new Set(fields.flatMap(x => [x.original, x.alias]));
        if (additional) for (const [key, v] of Object.entries(value)) if (!known.has(key)) result[key] = additional.decode(v, `${field}/${key}`);
        for (const { original, alias, plan, optional, nullable } of fields) {
          if (original !== alias && Object.hasOwn(value, original) && Object.hasOwn(value, alias)) throw new Error(`both original and alias supplied: ${field}/${alias}`);
          const key = Object.hasOwn(value, alias) ? alias : original;
          if (!Object.hasOwn(value, key)) continue;
          delete result[key];
          if (!(optional && !nullable && value[key] === null)) result[original] = plan.decode(value[key], `${field}/${alias}`);
        }
        return result;
      } };
    }
    if (type === 'array') {
      const child = visit(s.items, depth + 1, false, active);
      out.items = child.schema;
      return { schema: out, decode(value, field) {
        if (typeof value === 'string') value = parse(value, field);
        return Array.isArray(value) ? value.map((v, i) => child.decode(v, `${field}/${i}`)) : value;
      } };
    }
    return { schema: out, decode: value => value };
  }
  function parse(value, field) {
    try { return JSON.parse(value); } catch {
      throw Object.assign(new Error(`Invalid JSON-encoded field at ${field || '/'}`), { code: 'invalid_arguments', field: field || '/' });
    }
  }
  const plan = visit(schema, 0, true);
  return {
    inputSchema: plan.schema,
    decode(value) {
      const decoded = plan.decode(value);
      for (const name of meta.pathParams) {
        if (decoded?.[name] === undefined || decoded[name] === null || decoded[name] === '') {
          const e = new Error(`Missing required path parameter: ${name}`);
          e.code = 'missing_path_parameter'; e.field = name; throw e;
        }
      }
      validate ||= ajv.compile(native);
      if (!validate(decoded)) {
        const issue = validate.errors[0];
        const detail = issue.keyword === 'enum' ? `allowed values: ${JSON.stringify(issue.params.allowedValues)}` : issue.message;
        const key = issue.params.missingProperty || issue.params.additionalProperty;
        const field = `${issue.instancePath || ''}${key ? '/' + key : ''}` || '/';
        const e = new Error(`Invalid arguments at ${field}: ${detail}`);
        e.code = 'invalid_arguments'; e.field = field; throw e;
      }
      return decoded;
    },
  };
}

// Bundled v0.2 catalogs truncated tool IDs but some routing keys did not. Match only
// unambiguous legacy prefixes. Future generation rejects collisions instead of overwriting.
function routingFor(operations, op) {
  if (operations[op]) return operations[op];
  const candidates = Object.keys(operations).filter(k => opKey(k) === op);
  if (candidates.length !== 1) throw new Error(`ambiguous or missing routing for ${op}`);
  return operations[candidates[0]];
}
module.exports = { compileContract, nativeSchema, opKey, routingFor, compact, forbiddenHeader, schemaSummary };
