#!/usr/bin/env bash
# Reproducible Vercel build: fetch spec (JSON) -> generate tools via toolport-openapi-mcp
# -> curate -> build routing map. Then:
#   VENDOR=vercel VERCEL_TOKEN=... node src/server.js
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
# OpenAPI -> tools generator, run from npm (override GEN to point at a local build if you have one).
GEN="${GEN:-npx -y toolport-openapi-mcp}"
SPEC_URL="https://openapi.vercel.sh/"
mkdir -p "$HERE/out"

echo "1/3 fetch Vercel spec (JSON)"
curl -sSL --max-time 60 -o "$HERE/out/vercel.spec.json" "$SPEC_URL"

echo "2/3 generate tools via toolport-openapi-mcp"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | OPENAPI_SPEC="$SPEC_URL" timeout 150 $GEN 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n")){if(!l.trim())continue;try{const m=JSON.parse(l);if(m.id===2&&m.result&&m.result.tools){require("fs").writeFileSync(process.argv[1],JSON.stringify(m.result.tools,null,2));console.log("  "+m.result.tools.length+" tools");}}catch{}}})' "$HERE/out/vercel.tools.json"

echo "3/3 curate + build routing map"
VENDOR=vercel node "$HERE/src/curate.js"
VENDOR=vercel node "$HERE/src/operations.js"

echo "done -> VENDOR=vercel VERCEL_TOKEN=... node src/server.js"
