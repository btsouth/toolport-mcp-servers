'use strict';
// Regression tests for the operationId humanizer. Run: `npm test` (node --test).
const { test } = require('node:test');
const assert = require('node:assert');
const { humanize, humanizeVerb } = require('../src/humanize');

const name = (op) => humanize(op).name;

test('core CRUD on a top-level resource', () => {
  assert.equal(name('PostCustomers'), 'create_customer');
  assert.equal(name('GetCustomers'), 'list_customers');
  assert.equal(name('GetCustomersCustomer'), 'get_customer');   // /customers/{id}
  assert.equal(name('PostCustomersCustomer'), 'update_customer'); // POST /customers/{id}
  assert.equal(name('DeleteCustomersCustomer'), 'delete_customer');
  assert.equal(name('GetCustomersSearch'), 'search_customers');
});

test('multi-word resources singularize on the last word only', () => {
  assert.equal(name('PostPaymentIntents'), 'create_payment_intent');
  assert.equal(name('PostCheckoutSessions'), 'create_checkout_session');
  assert.equal(name('PostCreditNotes'), 'create_credit_note');
  assert.equal(name('PostPaymentLinks'), 'create_payment_link');
});

test('singleton resource reads with get_, not list_', () => {
  assert.equal(name('GetBalance'), 'get_balance');
});

test('action verbs on an item', () => {
  assert.equal(name('PostDisputesDisputeClose'), 'close_dispute');
  assert.equal(name('PostChargesChargeCapture'), 'capture_charge');
  assert.equal(name('PostPaymentIntentsIntentConfirm'), 'confirm_payment_intent');
  assert.equal(name('PostSubscriptionsSubscriptionCancel'), 'cancel_subscription');
});

test('nested sub-resources are parent-qualified (no collision with the top-level)', () => {
  assert.equal(name('PostChargesChargeRefunds'), 'create_charge_refund');
  assert.notEqual(name('PostChargesChargeRefunds'), name('PostRefunds'));
  assert.equal(name('GetCustomersCustomerBankAccountsId'), 'get_customer_bank_account');
});

test('POST to an item is update, never a colliding create (multi-word {id})', () => {
  assert.equal(name('PostWebhookEndpointsWebhookEndpoint'), 'update_webhook_endpoint');
  assert.equal(name('PostPaymentMethodsPaymentMethod'), 'update_payment_method');
  // ...and the collection POST is the real create.
  assert.equal(name('PostWebhookEndpoints'), 'create_webhook_endpoint');
  assert.notEqual(name('PostWebhookEndpointsWebhookEndpoint'), name('PostWebhookEndpoints'));
});

test('DELETE is never mislabeled create_ (irregular plural people/person)', () => {
  const d = humanize('DeleteAccountsAccountPeoplePerson');
  assert.equal(d.verb, 'delete');
  assert.ok(d.name.startsWith('delete_'), `expected delete_*, got ${d.name}`);
  assert.equal(name('DeleteWebhookEndpointsWebhookEndpoint'), 'delete_webhook_endpoint');
});

test('a literal mid-path {Id} is stripped, not baked into the name', () => {
  assert.equal(name('PostApplicationFeesIdRefunds'), 'create_application_fee_refund');
});

test('Stripe {resource}_exposed_id params stay one level (top-level, not nested)', () => {
  assert.equal(name('GetSubscriptionsSubscriptionExposedId'), 'get_subscription');
  assert.equal(name('PostSubscriptionsSubscriptionExposedId'), 'update_subscription');
  assert.equal(humanize('GetSubscriptionsSubscriptionExposedId').nesting, 0);
  assert.equal(humanize('DeleteSubscriptionsSubscriptionExposedId').single, true);
});

test('verb-style operationIds (Clerk PascalCase + Vercel lowercase-first)', () => {
  const vn = (op) => humanizeVerb(op).name;
  // Clerk (PascalCase, GetXList lists)
  assert.equal(vn('CreateEmailAddress'), 'create_email_address');
  assert.equal(vn('GetClientList'), 'list_clients');
  assert.equal(vn('BanUser'), 'ban_user');
  // Vercel (lowercase-first; read->get; already-plural lists; get+plural->list)
  assert.equal(vn('createAccessGroup'), 'create_access_group');
  assert.equal(vn('readAccessGroup'), 'get_access_group');
  assert.equal(vn('listAccessGroups'), 'list_access_groups');
  assert.equal(vn('getDeployments'), 'list_deployments');
  assert.equal(vn('getDeployment'), 'get_deployment');
});

test('resourceKey is the unqualified singular (for vocab lookup)', () => {
  assert.equal(humanize('PostRefunds').resourceKey, 'refund');
  assert.equal(humanize('PostChargesChargeRefunds').resourceKey, 'refund');
  assert.equal(humanize('GetCustomersCustomerBankAccountsId').resourceKey, 'bank_account');
});
