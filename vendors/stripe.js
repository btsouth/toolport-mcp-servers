'use strict';
// Stripe vendor config. Reuses the existing Stripe vocab (src/vocab.js) so nothing about
// the proven Stripe flagship changes; this file just packages it as a vendor.
const { RESOURCE_SYNONYMS, ACTION_SYNONYMS, NAME_OVERRIDES } = require('../src/vocab');

module.exports = {
  name: 'stripe',
  namingStyle: 'path', // operationIds are {Method}{PathCamelCase}, e.g. PostCustomers
  specUrl: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
  specFile: 'out/stripe.spec.json',
  // Stripe's curated tools ship prebuilt in data/. To rebuild, generate a raw tool catalog
  // from specUrl (see scripts/prep-*.sh) and point toolsFile at it via env or a local path.
  toolsFile: process.env.STRIPE_TOOLS_FILE || 'out/stripe.tools.json',
  intentsFile: process.env.STRIPE_INTENTS_FILE || 'out/stripe.intents.json',
  outPrefix: 'stripe-curated',
  out: {
    tools: 'stripe-curated.tools.json',
    core: 'stripe-curated-core.tools.json',
    intents: 'stripe-curated.intents.json',
    namemap: 'stripe.namemap.json',
    operations: 'stripe.operations.json',
  },
  apiBase: 'https://api.stripe.com',
  apiKeyEnv: 'STRIPE_API_KEY',
  bodyFormat: 'form', // Stripe wants application/x-www-form-urlencoded
  // Secondary namespaces never out-rank core commerce for a clean name / core-subset slot.
  secondary: /^(TestHelpers|Issuing|Treasury|Terminal|Climate|Radar|Sigma|Reporting|Apps|FinancialConnections|Identity|Forwarding|Entitlements|BillingPortal|TaxCalculations|TaxRegistrations|TaxSettings|TaxTransactions)/,
  resourceSynonyms: RESOURCE_SYNONYMS,
  actionSynonyms: ACTION_SYNONYMS,
  nameOverrides: NAME_OVERRIDES,
};
