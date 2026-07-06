'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { stripeForm } = require('../src/stripeForm');

test('flat scalar fields', () => {
  assert.equal(stripeForm({ email: 'a@b.com', name: 'Ada' }), 'email=a%40b.com&name=Ada');
});

test('nested objects use bracket notation', () => {
  assert.equal(decodeURIComponent(stripeForm({ metadata: { order_id: '123' } })), 'metadata[order_id]=123');
});

test('scalar arrays are indexed', () => {
  assert.equal(decodeURIComponent(stripeForm({ items: ['a', 'b'] })), 'items[0]=a&items[1]=b');
});

test('arrays of objects nest correctly', () => {
  assert.equal(
    decodeURIComponent(stripeForm({ items: [{ price: 'p1', quantity: 2 }] })),
    'items[0][price]=p1&items[0][quantity]=2'
  );
});

test('null and undefined are skipped', () => {
  assert.equal(stripeForm({ a: 1, b: null, c: undefined }), 'a=1');
});
