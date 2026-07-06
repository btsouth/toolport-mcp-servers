'use strict';
// Encode a nested request body the way Stripe's API expects: deep bracket notation over
// application/x-www-form-urlencoded (a[b]=c, items[0][x]=y). Stripe accepts indexed arrays.

function walk(value, prefix, pairs) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${prefix}[${i}]`, pairs));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walk(v, prefix ? `${prefix}[${k}]` : k, pairs);
    }
  } else {
    pairs.push([prefix, String(value)]);
  }
}

function stripeForm(body) {
  const pairs = [];
  walk(body || {}, '', pairs);
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

module.exports = { stripeForm };
