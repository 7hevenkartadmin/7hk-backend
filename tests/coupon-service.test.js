import test from 'node:test';
import assert from 'node:assert/strict';
import { Coupon } from '../src/modules/coupons/coupon.model.js';
import { calculateDiscount, createCoupon, listActiveCouponOffers, updateCoupon, validateCoupon } from '../src/modules/coupons/coupon.service.js';

function withStub(object, method, implementation, callback) {
  const original = object[method];
  object[method] = implementation;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      object[method] = original;
    });
}

test('validateCoupon returns no coupon and zero discount when no code is supplied', async () => {
  const result = await validateCoupon('', 500);

  assert.deepEqual(result, { coupon: null, discount: 0 });
});

test('validateCoupon uppercases lookup code and calculates percentage discount', async () => withStub(
  Coupon,
  'findOne',
  async (query) => {
    assert.deepEqual(query, { code: 'SAVE20', isActive: true });
    return {
      code: 'SAVE20',
      type: 'percentage',
      value: 20,
      maxDiscount: 75,
      minOrderValue: 100,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
      usageLimit: 0,
      usedCount: 0,
    };
  },
  async () => {
    const result = await validateCoupon('save20', 500);

    assert.equal(result.coupon.code, 'SAVE20');
    assert.equal(result.discount, 75);
  },
));

test('validateCoupon rejects missing, inactive, minimum order, and exhausted coupons', async () => {
  await withStub(Coupon, 'findOne', async () => null, async () => {
    await assert.rejects(() => validateCoupon('missing', 500), { code: 'COUPON_NOT_FOUND' });
  });

  await withStub(Coupon, 'findOne', async () => ({
    startsAt: new Date(Date.now() + 60_000),
    endsAt: new Date(Date.now() + 120_000),
  }), async () => {
    await assert.rejects(() => validateCoupon('future', 500), { code: 'COUPON_INACTIVE' });
  });

  await withStub(Coupon, 'findOne', async () => ({
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 60_000),
    minOrderValue: 700,
  }), async () => {
    await assert.rejects(() => validateCoupon('min', 500), { code: 'COUPON_MIN_ORDER' });
  });

  await withStub(Coupon, 'findOne', async () => ({
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 60_000),
    minOrderValue: 0,
    usageLimit: 10,
    usedCount: 10,
  }), async () => {
    await assert.rejects(() => validateCoupon('done', 500), { code: 'COUPON_LIMIT_REACHED' });
  });
});

test('calculateDiscount never exceeds max discount or subtotal', () => {
  assert.equal(calculateDiscount({ type: 'percentage', value: 10, maxDiscount: 0 }, 300), 30);
  assert.equal(calculateDiscount({ type: 'percentage', value: 80, maxDiscount: 100 }, 500), 100);
  assert.equal(calculateDiscount({ type: 'flat', value: 999, maxDiscount: 0 }, 250), 250);
});

test('createCoupon persists an uppercase code', async () => withStub(
  Coupon,
  'create',
  async (payload) => payload,
  async () => {
    const coupon = await createCoupon({
      code: 'fresh50',
      type: 'flat',
      value: 50,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 60_000),
    });

    assert.equal(coupon.code, 'FRESH50');
  },
));

test('updateCoupon persists admin status changes and reports missing coupons', async () => {
  await withStub(Coupon, 'findByIdAndUpdate', async (id, payload, options) => {
    assert.equal(id, 'coupon-1');
    assert.deepEqual(payload, { isActive: false });
    assert.deepEqual(options, { new: true, runValidators: true });
    return { _id: id, ...payload };
  }, async () => {
    const coupon = await updateCoupon('coupon-1', { isActive: false });
    assert.equal(coupon.isActive, false);
  });

  await withStub(Coupon, 'findByIdAndUpdate', async () => null, async () => {
    await assert.rejects(() => updateCoupon('missing', { isActive: false }), { code: 'COUPON_NOT_FOUND' });
  });
});

test('listActiveCouponOffers queries active usable coupons and caps the public list', async () => {
  const calls = [];
  const queryChain = {
    sort(sort) {
      calls.push(['sort', sort]);
      return this;
    },
    limit(limit) {
      calls.push(['limit', limit]);
      return Promise.resolve([{ code: 'SAVE20' }]);
    },
  };

  await withStub(Coupon, 'find', (query) => {
    calls.push(['find', query]);
    return queryChain;
  }, async () => {
    const offers = await listActiveCouponOffers();

    assert.deepEqual(offers, [{ code: 'SAVE20' }]);
    assert.equal(calls[0][0], 'find');
    assert.equal(calls[0][1].isActive, true);
    assert.ok(calls[0][1].startsAt.$lte instanceof Date);
    assert.ok(calls[0][1].endsAt.$gte instanceof Date);
    assert.deepEqual(calls[1], ['sort', { value: -1, createdAt: -1 }]);
    assert.deepEqual(calls[2], ['limit', 20]);
  });
});
