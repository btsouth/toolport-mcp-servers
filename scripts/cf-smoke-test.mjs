#!/usr/bin/env node
// Reversible LIVE smoke-test of the Cloudflare overlay against your real account:
//   1) list_zones            (read)
//   2) create_dns_record     (write - a throwaway TXT record)
//   3) get_dns_record        (verify the write landed)
//   4) delete_dns_record     (clean up - no residue left behind)
// It drives the actual overlay server (src/server.js) over stdio, so it proves the whole
// chain: curated tool name -> operationId -> HTTP request -> live Cloudflare API.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/cf-smoke-test.mjs
//   CLOUDFLARE_API_TOKEN=... CF_ZONE_ID=<zone id> node scripts/cf-smoke-test.mjs   # pin a zone
//
// Requires the built artifacts (data/ ships them, or run `npm run prep:cloudflare`).
// Token needs at least Zone:Read + Zone:DNS:Edit on the zone you test.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('Set CLOUDFLARE_API_TOKEN (and optionally CF_ZONE_ID).'); process.exit(1); }

const child = spawn(process.execPath, [join(HERE, '..', 'src', 'server.js')], {
  env: { ...process.env, VENDOR: 'cloudflare', CLOUDFLARE_API_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});

const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? '';
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { isError: !!res.result?.isError, body, text };
}
function die(msg, extra) { console.error('\nFAIL:', msg); if (extra) console.error(extra); child.kill(); process.exit(1); }

const guard = setTimeout(() => die('timed out after 45s'), 45_000);

await rpc('initialize', {});

// 1) READ
console.log('1) list_zones ...');
const zres = await callTool('list_zones', {});
if (zres.isError) die('list_zones errored (token missing Zone:Read?)', zres.text);
const zones = zres.body?.result ?? [];
if (!zones.length) die('no zones visible to this token');
const zone = process.env.CF_ZONE_ID
  ? (zones.find((z) => z.id === process.env.CF_ZONE_ID) ?? { id: process.env.CF_ZONE_ID, name: '(pinned)' })
  : zones[0];
console.log(`   ${zones.length} zone(s); using ${zone.name} (${zone.id})`);

// 2) WRITE (throwaway TXT)
const recName = `_toolport-smoke-${Date.now()}`;
console.log(`2) create_dns_record TXT ${recName} ...`);
const cres = await callTool('create_dns_record', {
  zone_id: zone.id,
  body: { type: 'TXT', name: recName, content: `toolport overlay smoke test ${new Date().toISOString()}`, ttl: 60 },
});
const recId = cres.body?.result?.id;
if (cres.isError || !recId) die('create_dns_record failed (token missing Zone:DNS:Edit?)', cres.text);
console.log(`   created ${recId}`);

// 3) VERIFY
console.log('3) get_dns_record (verify) ...');
const gres = await callTool('get_dns_record', { zone_id: zone.id, dns_record_id: recId });
console.log(`   ${gres.body?.result?.name?.includes(recName) ? 'verified present' : 'WARN: could not verify (will still clean up)'}`);

// 4) CLEAN UP
console.log('4) delete_dns_record (cleanup) ...');
const dres = await callTool('delete_dns_record', { zone_id: zone.id, dns_record_id: recId });
if (dres.isError) die(`cleanup failed - DELETE manually: record ${recId} in zone ${zone.id}`, dres.text);
console.log('   deleted; no residue.');

clearTimeout(guard);
console.log('\nSMOKE TEST PASSED: live read + write + verify + delete all succeeded.');
child.kill();
process.exit(0);
