'use strict';
// Apply a vendor's curation overlay to a raw OpenAPI-generated tool catalog.
//
//   node src/curate.js               # VENDOR=stripe (default) - unchanged flagship behavior
//   VENDOR=clerk node src/curate.js  # any vendor in vendors/<name>.js
//
// Produces, in out/ (filenames from the vendor's `out` map):
//   <tools>    - same tools, intent-friendly names + enriched descriptions
//   <core>     - the core subset (common surface)
//   <intents>  - the benchmark intents with `ok` remapped to curated names (if present)
//   <namemap>  - operationId -> curated name
//
// The tool SHAPE ({name, description, inputSchema}) is preserved, so it drops straight into
// the same ranker/benchmark/server the raw catalog uses.

const fs = require('fs');
const path = require('path');
const { humanize, humanizeVerb, splitCamel } = require('./humanize');

const VENDOR = process.env.VENDOR || 'stripe';
const cfg = require(`../vendors/${VENDOR}`);
const humanizeOp = cfg.namingStyle === 'verb' ? humanizeVerb : humanize;
const outDir = path.join(__dirname, '..', 'out');

// Resolve a config path: absolute (drive-letter or leading slash) as-is, else repo-relative.
const resolve = (p) => (/^([a-zA-Z]:|\/)/.test(p) ? p : path.join(__dirname, '..', p));

// Prefer the primary action when deciding who claims a clean name and the synonyms.
const VERB_RANK = { create: 0, get: 1, search: 1, list: 2, update: 3, delete: 4 };

function cleanDescription(d) {
  return String(d || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 380);
}

function actionLead(verb, res) {
  const r = res || 'resource';
  switch (verb) {
    case 'create': return `Create a ${r}.`;
    case 'list': return `List ${r}s.`;
    case 'get': return `Retrieve a ${r}.`;
    case 'update': return `Update a ${r}.`;
    case 'delete': return `Delete a ${r}.`;
    case 'search': return `Search ${r}s.`;
    default: return `${verb.charAt(0).toUpperCase() + verb.slice(1)} a ${r}.`;
  }
}

// Enriched description = action-specific lead + cleaned original + (only for the ONE
// canonical write/read owner per resource) the resource vocabulary, plus action synonyms.
// Single ownership avoids saturating a token across many tools (the refund-regression lesson).
function enrich(original, verb, res, ownsSynonyms) {
  const lead = actionLead(verb, res);
  const base = cleanDescription(original);
  let extra = '';
  if (ownsSynonyms && cfg.resourceSynonyms[res]) extra += ` Common phrasings: ${cfg.resourceSynonyms[res]}.`;
  if (cfg.actionSynonyms[verb]) extra += ` Also: ${cfg.actionSynonyms[verb]}.`;
  return `${lead} ${base}${extra}`;
}

const isSecondary = (op) => cfg.secondary.test(splitCamel(op).slice(1).join(''));

function curate() {
  const rawTools = JSON.parse(fs.readFileSync(resolve(cfg.toolsFile), 'utf8'));
  const rawIntents = fs.existsSync(resolve(cfg.intentsFile))
    ? JSON.parse(fs.readFileSync(resolve(cfg.intentsFile), 'utf8'))
    : [];

  // Priority: core namespace before secondary, shallower before deeper, primary verb
  // before secondary, then spec order.
  const infos = rawTools.map((tool, i) => {
    const h = humanizeOp(tool.name);
    const key = [isSecondary(tool.name) ? 1 : 0, splitCamel(tool.name).length - 1, VERB_RANK[h.verb] ?? 5, i];
    return { op: tool.name, h, key };
  });
  const order = [...infos].sort((a, b) =>
    a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.key[3] - b.key[3]
  );

  const nameMap = {};
  const used = new Map();
  const ownsSyn = new Set();
  const ownWrite = new Set();
  const ownRead = new Set();
  const collisions = [];

  for (const { op, h } of order) {
    let name = cfg.nameOverrides[op] || h.name;
    if (used.has(name)) {
      const b = name;
      let n = 2;
      while (used.has(name)) name = `${b}_${n++}`;
      collisions.push(`${op}: ${b} -> ${name}`);
    }
    used.set(name, op);
    nameMap[op] = name;
    const rk = h.resourceKey;
    if (rk && cfg.resourceSynonyms[rk]) {
      const bucket = ['list', 'get', 'search'].includes(h.verb) ? ownRead : ownWrite;
      if (!bucket.has(rk)) { bucket.add(rk); ownsSyn.add(op); }
    }
  }

  // Core = a top-level resource / item / item-action (nesting 0), core namespace, not a
  // deprecated-alias duplicate. For verb-style vendors (nesting always 0, no secondary),
  // core is effectively the whole surface minus collisions.
  const isCore = (op, name) => humanizeOp(op).nesting === 0 && !isSecondary(op) && !/_\d+$/.test(name);

  const curatedTools = [];
  const coreTools = [];
  for (const tool of rawTools) {
    const h = humanizeOp(tool.name);
    const t = {
      name: nameMap[tool.name],
      description: enrich(tool.description, h.verb, h.resourceKey, ownsSyn.has(tool.name)),
      inputSchema: tool.inputSchema,
    };
    curatedTools.push(t);
    if (isCore(tool.name, t.name)) coreTools.push(t);
  }
  const coreNames = new Set(coreTools.map((t) => t.name));

  let unmapped = 0;
  const curatedIntents = rawIntents.map((it) => ({
    q: it.q,
    ok: (it.ok || []).map((op) => (nameMap[op] ? nameMap[op] : (unmapped++, op))),
  }));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, cfg.out.tools), JSON.stringify(curatedTools, null, 2));
  fs.writeFileSync(path.join(outDir, cfg.out.core), JSON.stringify(coreTools, null, 2));
  fs.writeFileSync(path.join(outDir, cfg.out.namemap), JSON.stringify(nameMap, null, 2));
  if (rawIntents.length) {
    fs.writeFileSync(path.join(outDir, cfg.out.intents), JSON.stringify(curatedIntents, null, 2));
  }

  const missingFromCore = new Set(curatedIntents.flatMap((it) => it.ok).filter((n) => !coreNames.has(n)));
  console.log(`[${VENDOR}] curated ${curatedTools.length} tools (core subset: ${coreTools.length})`);
  console.log(`[${VENDOR}] collisions disambiguated: ${collisions.length}`);
  if (rawIntents.length) {
    console.log(`[${VENDOR}] intent ok-ops unmapped: ${unmapped} | targets missing from core: ${missingFromCore.size}`);
  }
}

curate();
