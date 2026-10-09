'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generate } = require('../src/generate');
const { routingFor } = require('../src/contracts');
const { humanize, humanizeVerb, humanizePath } = require('../src/humanize');
const overrides = require('../src/nameOverrides');
for (const vendor of ['stripe', 'vercel', 'clerk', 'cloudflare']) {
  test(`${vendor}: generator and curation reproduce every bundled name with explicit long-name overrides`, () => {
    const cfg = require(`../vendors/${vendor}`);
    const tools = require(`../data/${vendor}-curated.tools.json`);
    const map = require(`../data/${vendor}.namemap.json`);
    const ops = require(`../data/${vendor}.operations.json`);
    const spec = { paths: {} };
    for (const tool of tools) {
      const id = Object.keys(map).find(k => map[k] === tool.name);
      const meta = routingFor(ops, id);
      const h = cfg.namingStyle === 'verb' ? humanizeVerb(id) : cfg.namingStyle === 'path-http' ? humanizePath(meta.method, meta.path) : humanize(id);
      if (h.name.length > 64) assert.ok(overrides[vendor][id] || cfg.nameOverrides[id], id);
      const input = structuredClone(tool.inputSchema);
      // Reconstruct known upstream defects before testing generator repairs.
      for (const rule of require('../src/schemaOverrideSources.json').filter(x => vendor === 'vercel' && x.operation === id)) {
        const parent = rule.path.slice(0, -1).reduce((s, key) => s[key], input);
        parent[rule.path.at(-1)] = structuredClone(rule.source);
      }
      const operation = { operationId: id, description: tool.description, parameters: [] };
      for (const location of ['path', 'query', 'header']) for (const name of meta[`${location}Params`] || []) operation.parameters.push({ name, in: location, required: input.required.includes(name), schema: input.properties[name] });
      if (input.properties.body) operation.requestBody = { required: input.required.includes('body'), content: { [meta.contentType || (cfg.bodyFormat === 'form' ? 'application/x-www-form-urlencoded' : 'application/json')]: { schema: input.properties.body } } };
      (spec.paths[meta.path] ||= {})[meta.method.toLowerCase()] = operation;
    }
    const generated = generate(spec, vendor);
    assert.equal(generated.tools.length, tools.length);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolport-generation-'));
    try {
      const root = path.resolve(__dirname, '..');
      for (const dir of ['src', 'vendors']) fs.cpSync(path.join(root, dir), path.join(temp, dir), { recursive: true });
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'));
      fs.mkdirSync(path.join(temp, 'out'));
      fs.writeFileSync(path.join(temp, cfg.specFile), JSON.stringify(spec));
      fs.writeFileSync(path.join(temp, cfg.toolsFile), JSON.stringify(generated.tools));
      fs.writeFileSync(path.join(temp, 'out', cfg.out.operations), JSON.stringify(generated.operations));
      execFileSync(process.execPath, [path.join(temp, 'src/curate.js')], { env: { ...process.env, VENDOR: vendor }, timeout: 30000 });
      const regenerated = JSON.parse(fs.readFileSync(path.join(temp, 'out', cfg.out.namemap)));
      const differences = Object.entries(map).filter(([id, name]) => regenerated[id] !== name);
      assert.deepEqual(differences.map(([id, name]) => ({ id, bundled: name, generated: regenerated[id] })), []);
      assert.equal(new Set(Object.values(regenerated)).size, tools.length);
      assert.ok(Object.values(regenerated).every(name => /^[A-Za-z0-9_-]{1,64}$/.test(name)));
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}
