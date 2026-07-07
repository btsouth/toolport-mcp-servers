#!/usr/bin/env bash
# Reproducible Cloudflare build. Cloudflare's spec is YAML (~24MB, 3202 ops) with messy
# kebab operationIds, so we name from METHOD+PATH (namingStyle: path-http) and ship a
# curated FIRST BATCH (DNS, DNSSEC, email routing, zones) selected by the vendor's
# `coreMatch` regex. To build the FULL catalog instead, set FULL=1 (skips the core filter).
#
#   npm run prep:cloudflare
#   VENDOR=cloudflare CLOUDFLARE_API_TOKEN=... node src/server.js
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
GEN="${GEN:-node C:/projects/personal/conduit-openapi-mcp/dist/index.js}"
SPEC_URL="https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml"
mkdir -p "$HERE/out"

echo "1/5 fetch Cloudflare spec (YAML)"
curl -sSL --max-time 180 -o "$HERE/out/cloudflare.openapi.yaml" "$SPEC_URL"

echo "2/5 convert YAML -> JSON (permissive loader: tolerate the '=' value tag + datetimes)"
python - "$HERE/out/cloudflare.openapi.yaml" "$HERE/out/cloudflare.full.spec.json" <<'PY'
import sys, yaml, json
class L(yaml.SafeLoader): pass
L.add_constructor('tag:yaml.org,2002:value', lambda ldr, n: ldr.construct_scalar(n))
with open(sys.argv[1], encoding='utf-8') as f: spec = yaml.load(f, Loader=L)
json.dump(spec, open(sys.argv[2], 'w', encoding='utf-8'), default=str)
print("   paths:", len(spec.get('paths', {})))
PY

echo "3/5 select core batch via vendor coreMatch (FULL=1 to keep everything)"
node -e '
const fs=require("fs"), cfg=require(process.argv[1]);
const full=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
let paths=full.paths;
if (!process.env.FULL) { paths={}; for (const [p,m] of Object.entries(full.paths||{})) if (cfg.coreMatch.test(p)) paths[p]=m; }
fs.writeFileSync(process.argv[3], JSON.stringify({...full, paths}));
console.log("   paths in build:", Object.keys(paths).length);
' "$HERE/vendors/cloudflare.js" "$HERE/out/cloudflare.full.spec.json" "$HERE/out/cloudflare.spec.json"

echo "4/5 generate tools via the OpenAPI->MCP generator"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | OPENAPI_SPEC="$HERE/out/cloudflare.spec.json" timeout 180 $GEN 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n")){if(!l.trim())continue;try{const m=JSON.parse(l);if(m.id===2&&m.result&&m.result.tools){require("fs").writeFileSync(process.argv[1],JSON.stringify(m.result.tools,null,2));console.log("   "+m.result.tools.length+" tools");}}catch{}}})' "$HERE/out/cloudflare.tools.json"

echo "5/5 curate + build routing map"
VENDOR=cloudflare node "$HERE/src/curate.js"
VENDOR=cloudflare node "$HERE/src/operations.js"

echo "done -> VENDOR=cloudflare CLOUDFLARE_API_TOKEN=... node src/server.js"
