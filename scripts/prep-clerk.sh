#!/usr/bin/env bash
# Reproducible Clerk build: fetch spec (YAML) -> convert to JSON -> generate tools via
# toolport-openapi-mcp -> curate -> build routing map. Then:
#   VENDOR=clerk CLERK_SECRET_KEY=sk_... node src/server.js
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
# OpenAPI -> tools generator, run from npm (override GEN to point at a local build if you have one).
GEN="${GEN:-npx -y toolport-openapi-mcp}"
SPEC_URL="https://raw.githubusercontent.com/clerk/openapi-specs/main/bapi/2026-05-12.yml"
mkdir -p "$HERE/out"

echo "1/4 fetch + convert Clerk spec (YAML -> JSON)"
curl -sSL --max-time 60 -o "$HERE/out/clerk.spec.yaml" "$SPEC_URL"
python -c "import yaml,json; json.dump(yaml.safe_load(open('$HERE/out/clerk.spec.yaml',encoding='utf-8')), open('$HERE/out/clerk.spec.json','w',encoding='utf-8'))"

echo "2/4 generate tools via toolport-openapi-mcp"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | OPENAPI_SPEC="$SPEC_URL" timeout 120 $GEN 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n")){if(!l.trim())continue;try{const m=JSON.parse(l);if(m.id===2&&m.result&&m.result.tools){require("fs").writeFileSync(process.argv[1],JSON.stringify(m.result.tools,null,2));console.log("  "+m.result.tools.length+" tools");}}catch{}}})' "$HERE/out/clerk.tools.json"

echo "3/4 curate"
VENDOR=clerk node "$HERE/src/curate.js"
echo "4/4 build routing map"
VENDOR=clerk node "$HERE/src/operations.js"

echo "done -> VENDOR=clerk CLERK_SECRET_KEY=sk_... node src/server.js"
