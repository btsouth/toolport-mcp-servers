#!/usr/bin/env bash
# Reproducible Clerk build: fetch spec (YAML) -> JSON -> generate -> curate + routes.
#   VENDOR=clerk CLERK_SECRET_KEY=sk_... node src/server.js
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SPEC_URL="https://raw.githubusercontent.com/clerk/openapi-specs/main/bapi/2026-05-12.yml"
mkdir -p "$HERE/out"

echo "1/4 fetch + convert Clerk spec (YAML -> JSON)"
curl -sSL --max-time 60 -o "$HERE/out/clerk.spec.yaml" "$SPEC_URL"
python3 -c "import yaml,json; json.dump(yaml.safe_load(open('$HERE/out/clerk.spec.yaml',encoding='utf-8')), open('$HERE/out/clerk.spec.json','w',encoding='utf-8'))"

echo "2/4 generate tools locally from the fetched spec"
VENDOR=clerk node "$HERE/src/generate.js"

echo "3/4 curate"
VENDOR=clerk node "$HERE/src/curate.js"
echo "4/4 build routing map"
VENDOR=clerk node "$HERE/src/operations.js"

echo "done -> VENDOR=clerk CLERK_SECRET_KEY=sk_... node src/server.js"
