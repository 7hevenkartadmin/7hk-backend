import test from 'node:test';
import assert from 'node:assert/strict';
import { Coupon } from '../src/modules/coupons/coupon.model.js';
import { CouponRedemption } from '../src/modules/coupons/couponRedemption.model.js';
import {
  calculateDiscount,
  claimCoupon,
  consumeCouponReservation,
  createCoupon,
  listActiveCouponOffers,
  releaseCouponReservation,
  updateCoupon,
  validateCoupon,
} from '../src/modules/coupons/coupon.service.js';

function withStub(object, method, implementation, callback) {
  const original = object[method];
  object[method] = implementation;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      object[method] = original;
    });
}

function activeCoupon(overrides = {}) {
  return {
    _id: 'coupon-1',
    code: 'SAVE20',
    type: 'percentage',
    value: 20,
    maxDiscount: 75,
    minOrderValue: 100,
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 60_000),
    usageLimit: 0,
    usedCount: 0,
    reservedCount: 0,
    ...overrides,
  };
}

test('validateCoupon returns no coupon and zero discount when no code is supplied', async () => {
  assert.deepEqual(await validateCoupon('', 500, 'user-1'), { coupon: null, discount: 0 });
});

test('validateCoupon calculates discount and rejects permanent or reserved per-user redemptions', async () => {
  await withStub(Coupon, 'findOne', async (query) => {
    assert.deepEqual(query, { code: 'SAVE20', isActive: true });
    return activeCoupon();
  }, async () => withStub(CouponRedemption, 'findOne', async (query) => {
    assert.deepEqual(query, { coupon: 'coupon-1', user: 'user-1', active: true });
    return null;
  }, async () => {
    const result = await validateCoupon('save20', 500, 'user-1');
    assert.equal(result.discount, 75);
  }));

  await withStub(Coupon, 'findOne', async () => activeCoupon(), async () => withStub(
    CouponRedemption,
    'findOne',
    async () => ({ status: 'consumed' }),
    async () => assert.rejects(
      () => validateCoupon('save20', 500, 'user-1'),
      { code: 'COUPON_ALREADY_REDEEMED' },
    ),
  ));

  await withStub(Coupon, 'findOne', async () => activeCoupon(), async () => withStub(
    CouponRedemption,
    'findOne',
    async () => ({ status: 'reserved' }),
    async () => assert.rejects(
      () => validateCoupon('save20', 500, 'user-1'),
      { code: 'COUPON_CHECKOUT_IN_PROGRESS' },
    ),
  ));
});

test('coupon lookup normalizes surrounding whitespace and casing', async () => {
  await withStub(Coupon, 'findOne', async (query) => {
    assert.deepEqual(query, { code: 'SAVE20', isActive: true });
    return activeCoupon();
  }, async () => {
    const result = await validateCoupon('  save20  ', 500);
    assert.equal(result.discount, 75);
  });
});

test('validateCoupon rejects missing, inactive, minimum-order, and globally exhausted coupons', async () => {
  await withStub(Coupon, 'findOne', async () => null, async () => {
    await assert.rejects(() => validateCoupon('missing', 500), { code: 'COUPON_NOT_FOUND' });
  });
  await withStub(Coupon, 'findOne', async () => activeCoupon({ startsAt: new Date(Date.now() + 60_000) }), async () => {
    await assert.rejects(() => validateCoupon('future', 500), { code: 'COUPON_INACTIVE' });
  });
  await withStub(Coupon, 'findOne', async () => activeCoupon({ minOrderValue: 700 }), async () => {
    await assert.rejects(() => validateCoupon('min', 500), { code: 'COUPON_MIN_ORDER' });
  });
  await withStub(Coupon, 'findOne', async () => activeCoupon({ usageLimit: 10, usedCount: 8, reservedCount: 2 }), async () => {
    await assert.rejects(() => validateCoupon('done', 500), { code: 'COUPON_LIMIT_REACHED' });
  });
});

test('calculateDiscount never exceeds max discount or subtotal', () => {
  assert.equal(calculateDiscount({ type: 'percentage', value: 10, maxDiscount: 0 }, 300), 30);
  assert.equal(calculateDiscount({ type: 'percentage', value: 80, maxDiscount: 100 }, 500), 100);
  assert.equal(calculateDiscount({ type: 'flat', value: 999, maxDiscount: 0 }, 250), 250);
});

test('createCoupon and updateCoupon preserve existing campaign administration behavior', async () => {
  await withStub(Coupon, 'create', async (payload) => payload, async () => {
    const coupon = await createCoupon({ code: 'fresh50', type: 'flat', value: 50 });
    assert.equal(coupon.code, 'FRESH50');
  });
  await withStub(Coupon, 'findOneAndUpdate', async (filter, payload, options) => {
    assert.deepEqual(filter, { _id: 'coupon-1' });
    assert.deepEqual(options, { new: true, runValidators: true });
    return { _id: filter._id, ...payload };
  }, async () => withStub(CouponRedemption, 'aggregate', async () => [], async () => {
    const coupon = await updateCoupon('coupon-1', { isActive: false });
    assert.equal(coupon.isActive, false);
    assert.equal(coupon.perUserLimit, 1);
  }));
});

test('customer offer list excludes coupons with an active redemption and exposes permanent policy', async () => {
  const calls = [];
  const queryChain = {
    sort(sort) { calls.push(['sort', sort]); return this; },
    limit(limit) { calls.push(['limit', limit]); return Promise.resolve([activeCoupon()]); },
  };
  await withStub(CouponRedemption, 'distinct', async (field, query) => {
    assert.equal(field, 'coupon');
    assert.deepEqual(query, { user: 'user-1', active: true });
    return ['used-coupon'];
  }, async () => withStub(Coupon, 'find', (query) => {
    calls.push(['find', query]);
    return queryChain;
  }, async () => {
    const offers = await listActiveCouponOffers('user-1');
    assert.deepEqual(calls[0][1]._id, { $nin: ['used-coupon'] });
    assert.equal(offers[0].usagePolicy, 'once_per_customer_permanent');
    assert.equal(offers[0].perUserLimit, 1);
  }));
});

test('claimCoupon atomically reserves global capacity and creates a user-scoped ledger entry', async () => {
  const calls = [];
  await withStub(Coupon, 'findOneAndUpdate', async (filter, update, options) => {
    calls.push({ filter, update, options });
    return activeCoupon({ reservedCount: 1 });
  }, async () => withStub(CouponRedemption, 'create', async (documents, options) => {
    calls.push({ documents, options });
    return [{ _id: 'redemption-1', ...documents[0] }];
  }, async () => {
    const result = await claimCoupon({
      couponId: 'coupon-1', userId: 'user-1', subtotal: 500,
      session: 'session', paymentIntentId: 'intent-1',
    });
    assert.equal(result.redemption.user, 'user-1');
    assert.equal(result.redemption.paymentIntent, 'intent-1');
    assert.deepEqual(calls[0].update, { $inc: { reservedCount: 1 } });
    assert.equal(calls[1].options.session, 'session');
  }));
});

test('consume is permanent while release keeps an audit record and restores retry eligibility', async () => {
  const ledgerCalls = [];
  const couponCalls = [];
  await withStub(CouponRedemption, 'findOneAndUpdate', async (filter, update, options) => {
    ledgerCalls.push({ filter, update, options });
    return { _id: filter._id, coupon: 'coupon-1', status: update.$set.status };
  }, async () => withStub(Coupon, 'findOneAndUpdate', async (filter, update, options) => {
    couponCalls.push({ filter, update, options });
    return { _id: 'coupon-1' };
  }, async () => {
    await consumeCouponReservation('redemption-1', 'order-1', 'session');
    await releaseCouponReservation({
      redemptionId: 'redemption-2', couponId: 'coupon-1', reason: 'PAYMENT_FAILED', session: 'session',
    });
  }));

  assert.deepEqual(ledgerCalls[0].filter, { _id: 'redemption-1', status: 'reserved', active: true });
  assert.equal(ledgerCalls[0].update.$set.status, 'consumed');
  assert.equal(ledgerCalls[0].update.$set.order, 'order-1');
  assert.deepEqual(couponCalls[0].update, { $inc: { reservedCount: -1, usedCount: 1 } });
  assert.equal(ledgerCalls[1].update.$set.status, 'released');
  assert.equal(ledgerCalls[1].update.$set.active, false);
  assert.deepEqual(couponCalls[1].update, { $inc: { reservedCount: -1 } });
});

test('duplicate release attempts decrement coupon capacity only once', async () => {
  let redemptionCalls = 0;
  let couponCalls = 0;
  await withStub(CouponRedemption, 'findOneAndUpdate', async () => {
    redemptionCalls += 1;
    return redemptionCalls === 1 ? { _id: 'redemption-1', coupon: 'coupon-1' } : null;
  }, async () => withStub(Coupon, 'findOneAndUpdate', async () => {
    couponCalls += 1;
    return { _id: 'coupon-1' };
  }, async () => {
    assert.ok(await releaseCouponReservation({ redemptionId: 'redemption-1', couponId: 'coupon-1' }));
    assert.equal(await releaseCouponReservation({ redemptionId: 'redemption-1', couponId: 'coupon-1' }), null);
  }));
  assert.equal(couponCalls, 1);
});

test('duplicate coupon reservation rolls back the fallback counter outside transactions', async () => {
  let rollback;
  await withStub(Coupon, 'findOneAndUpdate', async () => activeCoupon({ reservedCount: 1 }), async () => withStub(
    CouponRedemption,
    'create',
    async () => { const error = new Error('duplicate redemption'); error.code = 11000; throw error; },
    async () => withStub(Coupon, 'updateOne', async (filter, update) => { rollback = { filter, update }; }, async () => {
      await assert.rejects(
        () => claimCoupon({ couponId: 'coupon-1', userId: 'user-1', subtotal: 500 }),
        { code: 'COUPON_ALREADY_REDEEMED' },
      );
    }),
  ));
  assert.deepEqual(rollback, {
    filter: { _id: 'coupon-1', reservedCount: { $gt: 0 } },
    update: { $inc: { reservedCount: -1 } },
  });
});

test('coupon reservation rejects exhausted capacity before creating a ledger entry', async () => {
  let ledgerWrite = false;
  await withStub(Coupon, 'findOneAndUpdate', async () => null, async () => withStub(
    CouponRedemption,
    'create',
    async () => { ledgerWrite = true; },
    async () => assert.rejects(
      () => claimCoupon({ couponId: 'coupon-1', userId: 'user-1', subtotal: 500, session: 'session' }),
      { code: 'COUPON_LIMIT_REACHED' },
    ),
  ));
  assert.equal(ledgerWrite, false);
});
