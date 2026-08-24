import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliverySlot } from '../src/modules/delivery/deliverySlot.model.js';
import { StoreSettings } from '../src/modules/settings/storeSettings.model.js';
import { storeDateKey } from '../src/shared/utils/storeDate.js';
import { createSlot, listAdminSlots, listAvailableSlots, reserveSlot, updateSlot } from '../src/modules/delivery/delivery.service.js';

function withStub(object, method, implementation, callback) {
  const original = object[method];
  object[method] = implementation;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      object[method] = original;
    });
}

test('reserveSlot atomically increments only active slots with remaining capacity', async () => {
  const expectedSlot = { _id: 'slot-1', booked: 4, capacity: 50 };

  await withStub(DeliverySlot, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(filter._id, 'slot-1');
    assert.equal(filter.isActive, true);
    assert.ok(filter.date.$gte instanceof Date);
    assert.ok(filter.date.$lt instanceof Date);
    assert.equal(typeof filter.endsAt.$gt, 'string');
    assert.deepEqual(filter.$expr, { $lt: ['$booked', '$capacity'] });
    assert.deepEqual(update, { $inc: { booked: 1 } });
    assert.equal(options.new, true);
    assert.equal(options.session, 'session');
    return expectedSlot;
  }, async () => {
    const slot = await reserveSlot('slot-1', 'session');

    assert.equal(slot, expectedSlot);
  });
});

test('reserveSlot reports a stable unavailable-slot error when no slot is updated', async () => {
  await withStub(DeliverySlot, 'findOneAndUpdate', async () => null, async () => {
    await assert.rejects(() => reserveSlot('full-slot'), {
      statusCode: 409,
      code: 'SLOT_UNAVAILABLE',
    });
  });
});

test('createSlot converts an admin India date to the corresponding UTC instant', async () => {
  const payload = {
    date: '2026-07-01',
    startsAt: '10:00',
    endsAt: '12:00',
    capacity: 30,
    serviceArea: 'Patna',
  };

  await withStub(DeliverySlot, 'create', async (input) => {
    assert.equal(input.date.toISOString(), '2026-06-30T18:30:00.000Z');
    assert.equal(input.startsAt, payload.startsAt);
    return { _id: 'created-slot', ...input };
  }, async () => {
    const slot = await createSlot(payload, { at: new Date('2026-06-30T06:30:00.000Z') });

    assert.equal(slot._id, 'created-slot');
    assert.equal(slot.capacity, 30);
  });
});

test('listAdminSlots includes inactive and full upcoming slots', async () => {
  const queryChain = {
    sort(sort) {
      assert.deepEqual(sort, { date: 1, startsAt: 1 });
      return Promise.resolve([{ _id: 'slot-1', isActive: false }]);
    },
  };
  await withStub(DeliverySlot, 'find', (filter) => {
    assert.ok(filter.date.$gte instanceof Date);
    assert.equal(filter.isActive, undefined);
    return queryChain;
  }, async () => {
    const slots = await listAdminSlots();
    assert.equal(slots[0].isActive, false);
  });
});

test('updateSlot rejects capacity below bookings before saving', async () => {
  await withStub(DeliverySlot, 'findById', async () => ({ booked: 8 }), async () => {
    await assert.rejects(() => updateSlot('slot-1', { capacity: 7 }), { code: 'SLOT_CAPACITY_CONFLICT' });
  });
});

test('listAvailableSlots returns only admin-created same-day slots without creating defaults', async () => {
  const at = new Date('2026-08-18T06:30:00.000Z');
  const calls = [];
  const queryChain = {
    sort(sort) {
      calls.push(['sort', sort]);
      return Promise.resolve([{ _id: 'slot-1' }]);
    },
  };

  await withStub(StoreSettings, 'findOneAndUpdate', async () => ({}), async () => withStub(DeliverySlot, 'find', (filter) => {
    calls.push(['find', filter]);
    return queryChain;
  }, async () => {
    const slots = await listAvailableSlots({ serviceArea: 'Patna', date: storeDateKey(at) }, { at });

    assert.deepEqual(slots, [{ _id: 'slot-1' }]);
    assert.equal(calls[0][0], 'find');
    assert.equal(calls[0][1].isActive, true);
    assert.equal(calls[0][1].serviceArea, 'Patna');
    assert.deepEqual(calls[0][1].$expr, { $lt: ['$booked', '$capacity'] });
    assert.ok(calls[0][1].date.$gte instanceof Date);
    assert.ok(calls[0][1].date.$lt instanceof Date);
    assert.deepEqual(calls[1], ['sort', { date: 1, startsAt: 1 }]);
  }));
});
