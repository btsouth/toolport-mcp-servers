'use strict';
// Vercel API vendor config. Official Vercel MCP ~24 tools (read/observability-heavy); the
// spec has 333, including the write ops it's missing (env vars, domains/DNS, project
// settings, deploy lifecycle). operationIds are lowercase-first camelCase, verb-shaped
// (createDeployment, readAccessGroup, listProjects) - handled by the verb humanizer.

module.exports = {
  name: 'vercel',
  namingStyle: 'verb',
  specUrl: 'https://openapi.vercel.sh/',
  specFile: 'out/vercel.spec.json',
  toolsFile: 'out/vercel.tools.json', // generated via toolport-openapi-mcp
  intentsFile: 'eval/vercel.intents.json',
  outPrefix: 'vercel-curated',
  out: {
    tools: 'vercel-curated.tools.json',
    core: 'vercel-curated-core.tools.json',
    intents: 'vercel-curated.intents.json',
    namemap: 'vercel.namemap.json',
    operations: 'vercel.operations.json',
  },
  apiBase: 'https://api.vercel.com', // spec paths carry the version (/v1, /v8, /v13)
  apiKeyEnv: 'VERCEL_TOKEN',
  bodyFormat: 'json',
  secondary: /^$/,
  resourceSynonyms: {
    deployment: 'deployment, deploy, build, release, ship',
    project: 'project, app, application, site, repo',
    domain: 'domain, custom domain, website address',
    project_domain: 'project domain, custom domain on a project',
    dns_record: 'dns record, dns, record',
    project_env: 'environment variable, env var, project setting, secret config, config value',
    env: 'environment variable, env var, config value',
    team: 'team, organization, org, workspace',
    alias: 'alias, deployment url, custom url',
    log: 'log, logs, runtime log, build output',
    log_drain: 'log drain, log forwarding, log export',
    secret: 'secret, sensitive value, encrypted variable',
    edge_config: 'edge config, key-value store, edge data',
    webhook: 'webhook, event hook, notification url',
    integration: 'integration, connected service, marketplace app',
    certificate: 'certificate, ssl certificate, tls cert, https cert',
    check: 'check, deployment check, status check',
    access_group: 'access group, permission group, rbac group',
    user: 'user, account, member',
    artifact: 'artifact, build cache, remote cache, turbo cache',
    file: 'file, deployment file',
    firewall: 'firewall, waf, security rules',
  },
  actionSynonyms: {
    redeploy: 'redeploy, deploy again, rebuild',
    rollback: 'rollback, revert, roll back to a previous deploy',
    promote: 'promote, make production, promote to production',
    cancel: 'cancel, stop, abort',
    pause: 'pause, disable temporarily',
    record: 'record, log, report',
    upload: 'upload, push, store',
  },
  nameOverrides: {},
};
