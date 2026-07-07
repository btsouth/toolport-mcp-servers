'use strict';
// Cloudflare API vendor config. The official Cloudflare MCP surface is either fragmented
// into ~13 domain servers (builds/observability/docs/bindings/...) or the unified
// code-mode server (mcp.cloudflare.com: 3 tools - docs/search/execute over ~2500
// endpoints). This overlay instead exposes NAMED, individually-approvable tools for the
// control-plane surface you actually touch, so Toolport can HIL-gate and audit per op.
//
// NAMING: Cloudflare operationIds are messy kebab (dns-records-for-a-zone-create-dns-record,
// zones-0-get, ...-dns-record-details). Naming from the operationId is lossy (verb appears
// as prefix, suffix, or a bare HTTP method; item-vs-collection hides in a numeric segment).
// So this vendor names from METHOD + PATH via `humanizePath` - clean and unambiguous:
//   POST   /zones/{zone_id}/dns_records                    -> create_dns_record
//   GET    /zones/{zone_id}/dns_records                    -> list_dns_records
//   GET    /zones/{zone_id}/dns_records/{dns_record_id}    -> get_dns_record
//   POST   /accounts/{account_id}/email/routing/addresses  -> create_email_routing_address
//   PUT    /accounts/{account_id}/email/routing/enable     -> enable_email_routing
//
// AUTH: Cloudflare API tokens are Bearer tokens (server.js already sends
// `Authorization: Bearer ${token}`). Base is /client/v4; spec paths are relative.
//
// SCOPE: 3202 ops total. This starts with a curated core (DNS, email routing, zones) and
// grows in batches. Worker/Pages CODE deploys are multipart/form-data (script + metadata),
// which this engine does not encode - those stay with wrangler. Zone/DNS/email/WAF/Access
// config is all JSON and belongs here.

module.exports = {
  name: 'cloudflare',
  namingStyle: 'path-http', // NEW style: name from {method, path}. See src/humanize.js.
  specUrl: 'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml',
  specFile: 'out/cloudflare.spec.json', // converted from YAML in prep-cloudflare.sh
  toolsFile: 'out/cloudflare.tools.json', // generated via toolport-openapi-mcp
  intentsFile: 'eval/cloudflare.intents.json',
  outPrefix: 'cloudflare-curated',
  out: {
    tools: 'cloudflare-curated.tools.json',
    core: 'cloudflare-curated-core.tools.json',
    intents: 'cloudflare-curated.intents.json',
    namemap: 'cloudflare.namemap.json',
    operations: 'cloudflare.operations.json',
  },
  apiBase: 'https://api.cloudflare.com/client/v4', // spec paths are relative (/zones, ...)
  apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
  bodyFormat: 'json', // Cloudflare's control plane takes application/json bodies

  // Curated CORE surface (path regex). 3202 ops is too many to dump at once, so `core` is
  // positively scoped to the control-plane namespaces people actually script. Grown in
  // batches; the FULL catalog (regenerate with FULL=1) still contains every tool.
  //   batch 1: zone CRUD, DNS records + DNSSEC, email routing
  //   batch 2: rulesets/WAF (firewall, filters), page rules, SSL/TLS + custom certs/hostnames,
  //            zone settings, cache/purge, R2 buckets, D1, Access (Zero Trust)
  // KV (storage/kv/namespaces) is intentionally OUT: its schema has a recursive $ref that
  // hangs the OpenAPI->tools generator. Re-add once the generator gains a cycle guard.
  // Email routing is split across scopes (enable/settings/rules are ZONE-level, destination
  // addresses ACCOUNT-level) and `rules`/`suppression` exist at BOTH scopes; since
  // humanizePath strips the /accounts|/zones scope those would collide, so core takes zone
  // email routing (minus suppression) + account destination addresses only. Account-scoped
  // duplicates in a later batch need scope-qualified overrides (list_account_email_routing_rules).
  coreMatch: /^\/zones(\/\{[^/]+\})?$|^\/zones\/\{[^/]+\}\/(dns_records|dnssec|rulesets|firewall|filters|pagerules|ssl|custom_certificates|custom_hostnames|settings|purge_cache|cache)|^\/zones\/\{[^/]+\}\/email\/routing(?!\/suppression)|^\/accounts\/\{[^/]+\}\/(email\/routing\/addresses|r2\/buckets|d1\/database|access\/)/,

  // Namespace tiering. Cloudflare ids/paths are kebab/snake, so the matcher is a
  // path-prefix set (curate applies it kebab-aware for path-http vendors, not splitCamel).
  // Everything here is pushed BELOW the core control plane for clean-name + core-subset
  // priority: analytics/telemetry (radar, web-analytics), ML surfaces, and long-tail
  // products you rarely script.
  secondary: /^(radar|web-analytics|ai-gateway|workers-ai|stream|images|calls|pipelines|browser-rendering|logs|logpush|d1|vectorize|hyperdrive|pages|queues|magic-|spectrum|argo|healthchecks|pay-per-crawl)/,

  resourceSynonyms: {
    dns_record: 'dns record, dns, record, a record, cname, mx record, txt record, dns entry',
    zone: 'zone, domain, site, website, the domain in cloudflare',
    email_routing_address: 'destination address, forwarding address, verified email, where email is forwarded',
    email_routing_rule: 'email route, routing rule, forwarding rule, catch-all rule, address forwarding',
    email_routing: 'email routing, enable/disable email routing, email routing settings and status',
    email_routing_setting: 'email routing settings, enable email routing, email routing status',
    email_routing_suppression: 'email routing suppression, suppressed sender, blocked sender for email routing',
    email_routing_dns: 'email routing dns records, mx/spf records for email routing',
    dnssec: 'dnssec, dns security, signed dns',
    zone_setting: 'zone setting, ssl mode, always use https, minify, cache setting, security level',
  },
  actionSynonyms: {
    enable: 'enable, turn on, activate, switch on',
    disable: 'disable, turn off, deactivate, switch off',
    create: 'create, add, make, register, set up',
    list: 'list, get all, show, view all',
    delete: 'delete, remove, destroy',
    update: 'update, edit, modify, change',
    patch: 'patch, partially update, change one field',
    verify: 'verify, confirm, validate',
    purge: 'purge, clear, flush, invalidate cache',
    scan: 'scan, detect, auto-discover',
  },
  nameOverrides: {
    // Residual collisions the path-http humanizer leaves (keyed by operationId): a
    // singular-form collection GET that reads as a singleton, and a POST that shares a
    // path with a GET. The collision guard would auto-suffix these _2; these read better.
    get_publicListSuppressionRouting: 'list_email_routing_suppressions',
    dns_records_for_a_zone_apply_dns_scan_results: 'apply_dns_scan_results',
    // Singular-form collections whose LIST reads as a get (would otherwise lose to the item
    // op and become get_..._2). Name the list explicitly.
    d1_list_databases: 'list_d1_databases',
    r2_list_custom_domains: 'list_r2_bucket_custom_domains',
    zone_purge: 'purge_cache', // POST /zones/{id}/purge_cache (else reads as create_purge_cache)
  },
};
