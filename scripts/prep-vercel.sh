#!/usr/bin/env bash
# Reproducible Vercel build: fetch spec (JSON) -> generate tools locally from the fetched spec
# -> curate -> build routing map. Then:
#   VENDOR=vercel VERCEL_TOKEN=... node src/server.js
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SPEC_URL="https://openapi.vercel.sh/"
mkdir -p "$HERE/out"

echo "1/3 fetch Vercel spec (JSON)"
curl -sSL --max-time 60 -o "$HERE/out/vercel.spec.json" "$SPEC_URL"

echo "2/3 generate tools locally from the fetched spec"
VENDOR=vercel node "$HERE/src/generate.js"

echo "3/3 curate + build routing map"
VENDOR=vercel node "$HERE/src/curate.js"
VENDOR=vercel node "$HERE/src/operations.js"

echo "done -> VENDOR=vercel VERCEL_TOKEN=... node src/server.js"
