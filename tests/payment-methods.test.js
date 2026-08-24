import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPaymentMethodCatalogCache,
  getRazorpayMethodCatalog,
  normalizeRazorpayMethodCatalog,
} from '../src/modules/payments/paymentMethods.service.js';

test('Razorpay method catalog sanitizes, sorts, and marks popular banks', () => {
  const catalog = normalizeRazorpayMethodCatalog({
    netbanking: {
      UTIB: 'Axis Bank',
      SBIN: 'State Bank of India',
      BAD: '',
      'invalid-code': 'Invalid Bank',
      AUBL: 'AU Small Finance Bank',
    },
  });

  assert.deepEqual(catalog.banks.map((bank) => bank.code), ['UTIB', 'SBIN', 'AUBL']);
  assert.equal(catalog.banks[0].popular, true);
  assert.ok(catalog.upiChoices.some((choice) => choice.id === 'qr'));
});

test('Razorpay method catalog uses key-id-only authentication and caches responses', async () => {
  clearPaymentMethodCatalogCache();
  let requests = 0;
  const fetchImpl = async (_url, options) => {
    requests += 1;
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('rzp_test_catalog:').toString('base64')}`);
    return { ok: true, json: async () => ({ netbanking: { HDFC: 'HDFC Bank' } }) };
  };

  const first = await getRazorpayMethodCatalog({ fetchImpl, keyId: 'rzp_test_catalog', now: 1 });
  const second = await getRazorpayMethodCatalog({ fetchImpl, keyId: 'rzp_test_catalog', now: 2 });

  assert.equal(first.banks[0].name, 'HDFC Bank');
  assert.equal(second, first);
  assert.equal(requests, 1);
  clearPaymentMethodCatalogCache();
});
