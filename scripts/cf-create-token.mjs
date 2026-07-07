#!/usr/bin/env node
// Create a scoped Cloudflare API token for the toolport `cloudflare` overlay in ONE call,
// instead of adding ~14 permission rows by hand in the dashboard. Prints the token once.
//
// The create-token call itself needs a bootstrap credential that can manage tokens. Pick one:
//   A) Global API Key (every account has one; simplest):
//        CF_API_KEY=<global key> CF_API_EMAIL=<account email> node scripts/cf-create-token.mjs
//      Get it at https://dash.cloudflare.com/profile/api-tokens -> "Global API Key" -> View.
//   B) An existing API token with "User API Tokens: Edit" + "User Details: Read" + "Account
//      Settings: Read":
//        CF_BOOTSTRAP_TOKEN=<token> node scripts/cf-create-token.mjs
//
// Optional:
//   CF_ZONE_ID=<zone id>    scope the zone permissions to ONE zone (default: all zones) -
//                           recommended for a first safe test.
//   CF_ACCOUNT_ID=<id>      target a specific account (default: your first account).
//   CF_TOKEN_NAME=<name>    name for the new token (default toolport-cloudflare-overlay).
//   DEBUG=1                 list every permission group name (to tweak WANT below).
//   DRY_RUN=1               print the policy it WOULD create, without creating anything.
//
// Then paste the printed value into Toolport as CLOUDFLARE_API_TOKEN.

const API = 'https://api.cloudflare.com/client/v4';
const { CF_API_KEY, CF_API_EMAIL, CF_BOOTSTRAP_TOKEN } = process.env;

function authHeaders() {
  if (CF_BOOTSTRAP_TOKEN) return { Authorization: `Bearer ${CF_BOOTSTRAP_TOKEN}` };
  if (CF_API_KEY && CF_API_EMAIL) return { 'X-Auth-Key': CF_API_KEY, 'X-Auth-Email': CF_API_EMAIL };
  console.error('Set CF_BOOTSTRAP_TOKEN, or CF_API_KEY + CF_API_EMAIL. See the header of this file.');
  process.exit(1);
}

async function cf(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init.headers || {}) },
  });
  const j = await res.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${res.status}` }] }));
  if (!j.success) {
    console.error(`Cloudflare API error on ${path}:`, JSON.stringify(j.errors));
    process.exit(1);
  }
  return j.result;
}

// Each entry: keywords that must ALL appear in the permission-group name (case-insensitive).
// Covers the 357-tool overlay: DNS/DNSSEC, zones, email routing, WAF/rulesets, page rules,
// SSL, cache, R2, D1, Access (Zero Trust). Add/remove lines to change the grant.
const WANT = [
  ['dns', 'write'],
  ['zone', 'read'],
  ['zone settings', 'write'],
  ['zone waf', 'write'],
  ['firewall services', 'write'],
  ['rulesets', 'write'],
  ['page rules', 'write'],
  ['ssl and certificates', 'write'],
  ['cache purge'],
  ['email routing rules', 'write'],
  ['email routing addresses', 'write'],
  ['r2 storage', 'write'],
  ['d1', 'write'],
  ['access: apps and policies'],
];

const groups = await cf('/user/tokens/permission_groups?per_page=300');
if (process.env.DEBUG) console.error('ALL GROUPS:\n' + groups.map((g) => g.name).sort().join('\n') + '\n');

const selected = [];
const missing = [];
for (const kws of WANT) {
  const hits = groups.filter((g) => kws.every((k) => g.name.toLowerCase().includes(k)));
  // Prefer the shortest matching name (most specific), skip Read when a Write matched.
  hits.sort((a, b) => a.name.length - b.name.length);
  const g = hits[0];
  if (!g) missing.push(kws.join(' '));
  else if (!selected.some((s) => s.id === g.id)) selected.push(g);
}
if (missing.length) console.error('WARN: no group matched for:', missing.join(' | '), '(run with DEBUG=1 to see all names)');
if (!selected.length) { console.error('Nothing matched - aborting.'); process.exit(1); }
console.error('Granting:\n  ' + selected.map((g) => g.name).join('\n  '));

// Route each group into a zone-scoped or account-scoped policy by its declared scope.
const isZoneScoped = (g) => JSON.stringify(g.scopes || []).includes('zone');
const zoneGroups = selected.filter(isZoneScoped).map((g) => ({ id: g.id }));
const acctGroups = selected.filter((g) => !isZoneScoped(g)).map((g) => ({ id: g.id }));

const acctId = process.env.CF_ACCOUNT_ID || (await cf('/accounts'))[0]?.id;
if (!acctId) { console.error('No account found for this credential.'); process.exit(1); }
const zoneRes = process.env.CF_ZONE_ID
  ? { [`com.cloudflare.api.account.zone.${process.env.CF_ZONE_ID}`]: '*' }
  : { 'com.cloudflare.api.account.zone.*': '*' };

const policies = [];
if (zoneGroups.length) policies.push({ effect: 'allow', resources: zoneRes, permission_groups: zoneGroups });
if (acctGroups.length) policies.push({ effect: 'allow', resources: { [`com.cloudflare.api.account.${acctId}`]: '*' }, permission_groups: acctGroups });

const body = { name: process.env.CF_TOKEN_NAME || 'toolport-cloudflare-overlay', policies };
if (process.env.DRY_RUN) { console.error('\nDRY RUN - would POST /user/tokens with:\n'); console.log(JSON.stringify(body, null, 2)); process.exit(0); }

const token = await cf('/user/tokens', { method: 'POST', body: JSON.stringify(body) });
console.log('\nNew CLOUDFLARE_API_TOKEN (copy now - shown only once):\n');
console.log(token.value);
