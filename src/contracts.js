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

function schemaSummary(s, depth = 0) {
  if (depth > 2) return s.type || 'JSON';
  if (s.$ref) return `reference ${s.$ref}`;
  for (const k of ['oneOf', 'anyOf', 'allOf']) {
    if (s[k]) return s[k].map(x => schemaSummary(x, depth + 1)).join(k === 'allOf' ? ' and ' : ' or ');
  }
  if (s.properties) {
    const required = new Set(s.required || []);
    return '{' + Object.entries(s.properties).map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${schemaSummary(v, depth + 1)}`).join(', ') + '}';
  }
  if (s.enum) return s.enum.map(x => JSON.stringify(x)).join('|');
  if (s.items) return `array of ${schemaSummary(s.items, depth + 1)}`;
  return s.type || 'JSON';
}

function compileContract(source, meta) {
  const schema = structuredClone(source);
  schema.type = 'object';
  schema.properties ||= {};
  schema.required ||= [];
  schema.additionalProperties = false;
  for (const [, name] of meta.path.matchAll(/\{([^}]+)\}/g)) {
    schema.properties[name] ||= { type: 'string' };
    schema.properties[name].description = compact(`${schema.properties[name].description || ''} Required path parameter ${name}; use its exact name.`);
    if (!schema.required.includes(name)) schema.required.push(name);
  }
  const native = nativeSchema(schema);
  let validate;
  const budget = { properties: 0, enums: 0, strings: 0 };
  function visit(s, depth = 0, root = false, active = new Set()) {
    if (s.$ref && !active.has(s.$ref)) {
      if (!s.$ref.startsWith('#/')) throw new Error('Only local schema references are supported');
      const target = s.$ref.slice(2).split('/').reduce((x, key) => x?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], schema);
      if (!target) throw new Error(`Unresolved schema reference: ${s.$ref}`);
      return visit({ ...target, ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$ref')) }, depth, root, new Set([...active, s.$ref]));
    }
    const type = s.type || (s.properties ? 'object' : s.items ? 'array' : s.enum ? typeof s.enum[0] : null);
    // These shapes cannot be faithfully represented by a closed, shallow client
    // schema. JSON text preserves maps, nullable values, compositions and deep refs.
    const encoded = !root && (s.$ref || s.oneOf || s.allOf || s.anyOf || s.not || s.nullable ||
      !type || Array.isArray(type) || depth >= 7 ||
      (type === 'object' && (!s.properties || s.additionalProperties !== false)) ||
      (type === 'array' && (!s.items || Array.isArray(s.items))) ||
      budget.properties + Object.keys(s.properties || {}).length > 400 ||
      budget.enums + (s.enum || []).length > 500 ||
      budget.strings + JSON.stringify(s.enum || []).length > 12000);
    if (encoded) {
      return {
        schema: { type: 'string', description: compact(`${s.description || ''} JSON-encoded value: ${schemaSummary(s)}. Original API constraints are validated before sending.`, 700) },
        decode(value) {
          if (typeof value !== 'string') return value; // existing MCP callers may send native JSON
          try { return JSON.parse(value); } catch {
            if (s.nullable && type === 'string') return value; // legacy nullable scalar calls
            throw new Error('invalid JSON-encoded field');
          }
        },
      };
    }
    const out = { type };
    if (s.description) out.description = compact(s.description);
    const hints = [];
    if (s.format) hints.push(`Format: ${s.format}`);
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (s[k] !== undefined) hints.push(`${k}: ${s[k]}`);
    if (s.enum && !s.enum.every(x => typeof x === 'string')) hints.push(`Allowed: ${JSON.stringify(s.enum)}`);
    if (hints.length) out.description = compact(`${out.description || ''} ${hints.join('; ')}.`, 500);
    if (s.enum && s.enum.every(x => typeof x === 'string') && s.enum.length <= 250) {
      out.enum = s.enum;
      budget.enums += s.enum.length;
      budget.strings += JSON.stringify(s.enum).length;
    }
    if (type === 'object') {
      out.properties = {};
      out.additionalProperties = false;
      const fields = [];
      const required = new Set(s.required || []);
      for (const [original, child] of Object.entries(s.properties || {})) {
        const alias = keyName(original);
        if (Object.hasOwn(out.properties, alias)) throw new Error(`schema property alias collision: ${alias}`);
        budget.properties++;
        budget.strings += alias.length;
        const plan = visit(child, depth + 1, false, active);
        const optional = !required.has(original);
        out.properties[alias] = optional
          ? { anyOf: [plan.schema, { type: 'null' }], description: 'Optional. Use null to omit; JSON text "null" sends an explicit API null when allowed.' }
          : plan.schema;
        fields.push({ original, alias, plan, optional });
      }
      out.required = Object.keys(out.properties);
      return { schema: out, decode(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const result = { ...value };
        for (const { original, alias, plan, optional } of fields) {
          if (original !== alias && Object.hasOwn(value, original) && Object.hasOwn(value, alias)) throw new Error(`both original and alias supplied: ${alias}`);
          const key = Object.hasOwn(value, alias) ? alias : original;
          if (!Object.hasOwn(value, key)) continue;
          delete result[key];
          if (!(optional && value[key] === null)) result[original] = plan.decode(value[key]);
        }
        return result;
      } };
    }
    if (type === 'array') {
      const child = visit(s.items, depth + 1, false, active);
      out.items = child.schema;
      return { schema: out, decode: value => Array.isArray(value) ? value.map(child.decode) : value };
    }
    return { schema: out, decode: value => value };
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
        const e = new Error(`Invalid arguments at ${issue.instancePath || '/'}: ${issue.keyword}${issue.params.missingProperty ? ` (${issue.params.missingProperty})` : ''}`);
        e.code = 'invalid_arguments'; throw e;
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
module.exports = { compileContract, nativeSchema, opKey, routingFor, compact };
