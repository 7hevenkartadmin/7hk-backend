import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliverySlot } from '../src/modules/delivery/deliverySlot.model.js';
import { createSlot, listAvailableSlots, reserveSlot } from '../src/modules/delivery/delivery.service.js';

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
    assert.deepEqual(filter, {
      _id: 'slot-1',
      isActive: true,
      $expr: { $lt: ['$booked', '$capacity'] },
    });
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

test('createSlot delegates to DeliverySlot.create with the payload unchanged', async () => {
  const payload = {
    date: new Date('2026-07-01T00:00:00.000Z'),
    startsAt: '10:00',
    endsAt: '12:00',
    capacity: 30,
    serviceArea: 'Patna',
  };

  await withStub(DeliverySlot, 'create', async (input) => {
    assert.equal(input, payload);
    return { _id: 'created-slot', ...input };
  }, async () => {
    const slot = await createSlot(payload);

    assert.equal(slot._id, 'created-slot');
    assert.equal(slot.capacity, 30);
  });
});

test('listAvailableSlots creates upcoming defaults and filters by area and date', async () => {
  const calls = [];
  const queryChain = {
    sort(sort) {
      calls.push(['sort', sort]);
      return Promise.resolve([{ _id: 'slot-1' }]);
    },
  };

  await withStub(DeliverySlot, 'bulkWrite', async (operations, options) => {
    calls.push(['bulkWrite', operations, options]);
  }, async () => withStub(DeliverySlot, 'find', (filter) => {
    calls.push(['find', filter]);
    return queryChain;
  }, async () => {
    const slots = await listAvailableSlots({ serviceArea: 'Patna', date: '2026-07-01' });

    assert.deepEqual(slots, [{ _id: 'slot-1' }]);
    assert.equal(calls[0][0], 'bulkWrite');
    assert.equal(calls[0][2].ordered, false);
    assert.equal(calls[1][0], 'find');
    assert.equal(calls[1][1].isActive, true);
    assert.equal(calls[1][1].serviceArea, 'Patna');
    assert.deepEqual(calls[1][1].$expr, { $lt: ['$booked', '$capacity'] });
    assert.ok(calls[1][1].date.$gte instanceof Date);
    assert.ok(calls[1][1].date.$lt instanceof Date);
    assert.deepEqual(calls[2], ['sort', { date: 1, startsAt: 1 }]);
  }));
});
