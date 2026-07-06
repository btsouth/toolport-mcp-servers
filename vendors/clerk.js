'use strict';
// Clerk (Backend API) vendor config. The official Clerk MCP exposes ~2 tools; the spec has
// 224. Clerk's operationIds are already verb-shaped (CreateEmailAddress, GetClientList), so
// the win is coverage + auth-domain vocabulary, with only light name normalization.

module.exports = {
  name: 'clerk',
  namingStyle: 'verb', // operationIds are {Verb}{Resource}[List], e.g. CreateEmailAddress
  specUrl: 'https://raw.githubusercontent.com/clerk/openapi-specs/main/bapi/2026-05-12.yml',
  specFile: 'out/clerk.spec.json', // converted from YAML
  toolsFile: 'out/clerk.tools.json', // generated from the spec via toolport-openapi-mcp
  intentsFile: 'eval/clerk.intents.json',
  outPrefix: 'clerk-curated',
  out: {
    tools: 'clerk-curated.tools.json',
    core: 'clerk-curated-core.tools.json',
    intents: 'clerk-curated.intents.json',
    namemap: 'clerk.namemap.json',
    operations: 'clerk.operations.json',
  },
  apiBase: 'https://api.clerk.com/v1', // spec paths are relative (/users); base carries /v1
  apiKeyEnv: 'CLERK_SECRET_KEY',
  bodyFormat: 'json', // Clerk's Backend API takes application/json bodies
  secondary: /^$/, // Clerk has no deep secondary namespaces; the whole surface is core
  resourceSynonyms: {
    user: 'user, member, person, account holder, end user, someone who signed up',
    email_address: 'email address, email, contact email',
    phone_number: 'phone number, phone, mobile number, sms number',
    organization: 'organization, org, team, workspace, company, tenant',
    organization_membership: 'organization membership, org member, team member, membership',
    organization_invitation: 'organization invitation, org invite, team invite',
    organization_domain: 'organization domain, verified domain, org email domain',
    invitation: 'invitation, invite, sign-up invite',
    session: 'session, login session, active session, signed-in session',
    client: 'client, device, browser, user agent',
    jwt_template: 'jwt template, token template, custom claims',
    allowlist_identifier: 'allowlist identifier, allowed email or phone, allowlist',
    blocklist_identifier: 'blocklist identifier, blocked email or phone, blocklist',
    domain: 'domain, satellite domain, allowed origin',
    redirect_url: 'redirect url, allowed redirect, callback url',
    oauth_application: 'oauth application, oauth app, connected app, api client',
    saml_connection: 'saml connection, sso connection, enterprise sso',
    sign_in_token: 'sign-in token, magic sign-in link, one-time login link',
    actor_token: 'actor token, impersonation token, sign in as user',
    waitlist_entry: 'waitlist entry, waitlist signup',
    session_token: 'session token, access token, bearer token',
  },
  actionSynonyms: {
    ban: 'ban, block, suspend, deactivate',
    unban: 'unban, unblock, reactivate, restore',
    lock: 'lock, freeze the account',
    unlock: 'unlock, unfreeze the account',
    verify: 'verify, confirm, validate, check',
    prepare: 'prepare, start, initiate, begin',
    revoke: 'revoke, cancel, invalidate, disable',
    merge: 'merge, combine, deduplicate',
    reset: 'reset',
  },
  nameOverrides: {},
};
