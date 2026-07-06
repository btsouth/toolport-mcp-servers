'use strict';
// Curation data for the Stripe overlay.
//
// RESOURCE_SYNONYMS enriches each tool's description with the real-world vocabulary
// people use for that Stripe resource, so the lexical ranker matches natural queries
// ("issue a refund", "list chargebacks") without the caller knowing Stripe's nouns.
// These are GENERAL domain synonyms, deliberately NOT copied from any benchmark query,
// so recall gains generalize rather than overfit.
//
// NAME_OVERRIDES pins a curated name for the handful of operationIds the algorithmic
// humanizer would get wrong or awkward. Keep this small; the algorithm should do the
// heavy lifting.

const RESOURCE_SYNONYMS = {
  customer: 'customer, buyer, client, account holder, contact',
  charge: 'charge, bill a card, capture a payment, credit card charge, take a payment',
  payment_intent: 'payment, start a payment, accept a payment, collect a payment, checkout payment',
  refund: 'refund, issue a refund, reverse a charge, return a payment, money back',
  invoice: 'invoice, bill, amount due, unpaid bill',
  invoiceitem: 'invoice item, line item, add a charge to an invoice',
  subscription: 'subscription, recurring payment, recurring billing, membership, plan',
  subscription_item: 'subscription item, plan quantity, metered usage',
  plan: 'plan, pricing plan, subscription plan',
  balance: 'balance, available funds, account balance, how much money',
  balance_transaction: 'balance transaction, ledger entry, settlement',
  payout: 'payout, pay out to bank, bank transfer, withdraw funds, deposit to bank account',
  product: 'product, item, goods, catalog product, thing to sell',
  price: 'price, pricing, cost, amount, price point',
  coupon: 'coupon, discount, promo code, promotion, deal',
  promotion_code: 'promotion code, promo code, discount code',
  dispute: 'dispute, chargeback, inquiry, disputed payment, contested charge',
  checkout_session: 'checkout, checkout page, hosted checkout, payment page, pay page',
  payment_link: 'payment link, shareable link, pay by link, no-code link',
  transfer: 'transfer, move money, send to a connected account, pay a connected account',
  credit_note: 'credit note, credit memo, credit, adjustment',
  quote: 'quote, estimate, proposal, price quote',
  token: 'token, tokenize, tokenization, card token, single-use token',
  setup_intent: 'setup intent, save a card, save a payment method for later',
  payment_method: 'payment method, card, saved card, bank account on file',
  source: 'source, payment source, card or bank source',
  card: 'card, credit card, debit card',
  bank_account: 'bank account, external account, linked bank',
  webhook_endpoint: 'webhook endpoint, webhook, event notification url',
  event: 'event, activity, notification, audit log entry',
  tax_rate: 'tax rate, sales tax, VAT rate',
  session: 'session',
};

// Synonyms for action verbs, attached to action tools (capture/confirm/cancel/...), which
// the algorithmic naming leaves vocab-thin. General phrasings, not benchmark strings.
const ACTION_SYNONYMS = {
  capture: 'capture, collect authorized funds, settle an authorization, take the payment now',
  confirm: 'confirm, submit for processing, go ahead with the payment',
  cancel: 'cancel, abort, stop, call off, back out',
  finalize: 'finalize, lock in, mark as final, ready to send',
  void: 'void, cancel, nullify, write off',
  pay: 'pay, charge now, collect payment now',
  accept: 'accept, approve, agree to, sign off',
  close: 'close, give up, concede',
  attach: 'attach, add, link, save to a customer',
  detach: 'detach, remove, unlink',
  send: 'send, email, deliver to the customer',
  reverse: 'reverse, undo, roll back',
};

// operationId -> curated name. Small on purpose - the humanizer does the heavy lifting.
const NAME_OVERRIDES = {
  // Stripe cancels a subscription with DELETE /v1/subscriptions/{id}; name it for intent so
  // "cancel a subscription" matches (otherwise it reads as delete_subscription).
  DeleteSubscriptionsSubscriptionExposedId: 'cancel_subscription',
  // Stripe splits "your own account" (/v1/account) from "connected accounts"
  // (/v1/accounts/{id}); without help both retrieve to `get_account`. Name the Connect
  // ones explicitly so the singleton keeps the clean `get_account`.
  GetAccounts: 'list_connected_accounts',
  PostAccounts: 'create_connected_account',
  GetAccountsAccount: 'get_connected_account',
  PostAccountsAccount: 'update_connected_account',
  DeleteAccountsAccount: 'delete_connected_account',
  // "invoiceitems" is one word in Stripe's API; keep it readable.
  PostInvoiceitems: 'create_invoice_item',
  GetInvoiceitems: 'list_invoice_items',
};

module.exports = { RESOURCE_SYNONYMS, ACTION_SYNONYMS, NAME_OVERRIDES };
