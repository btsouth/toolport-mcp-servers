'use strict';
// Extract the routing map from a vendor's OpenAPI spec: operationId -> { method, path,
// pathParams, queryParams }. The generator's inputSchema exposes path + query params as
// top-level args and the request body under `body`, so this is all the server needs.
//
//   node src/operations.js                # VENDOR=stripe (default)
//   VENDOR=clerk node src/operations.js

const fs = require('fs');
const path = require('path');

const VENDOR = process.env.VENDOR || 'stripe';
const cfg = require(`../vendors/${VENDOR}`);
const resolve = (p) => (/^([a-zA-Z]:|\/)/.test(p) ? p : path.join(__dirname, '..', p));

const specPath = resolve(cfg.specFile);
if (!fs.existsSync(specPath)) {
  console.error(`missing ${cfg.specFile} - fetch the spec first (VENDOR=${VENDOR})`);
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const ops = {};
for (const [p, methods] of Object.entries(spec.paths || {})) {
  for (const [m, o] of Object.entries(methods)) {
    if (!o || !o.operationId) continue;
    const params = o.parameters || [];
    ops[o.operationId] = {
      method: m.toUpperCase(),
      path: p,
      pathParams: params.filter((x) => x.in === 'path').map((x) => x.name),
      queryParams: params.filter((x) => x.in === 'query').map((x) => x.name),
    };
  }
}

fs.writeFileSync(path.join(__dirname, '..', 'out', cfg.out.operations), JSON.stringify(ops, null, 2));
console.log(`[${VENDOR}] operations: ${Object.keys(ops).length}`);
