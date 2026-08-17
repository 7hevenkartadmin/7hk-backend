import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDeliveryZones, defaultOrderingSchedule } from '../src/modules/settings/settings.defaults.js';
import { evaluateStoreAvailability } from '../src/modules/settings/storeAvailability.service.js';

function settings(patch = {}) {
  return {
    deliveryZones: defaultDeliveryZones.map((zone) => ({ ...zone })),
    orderingSchedule: {
      ...defaultOrderingSchedule,
      weeklySchedule: defaultOrderingSchedule.weeklySchedule.map((day) => ({ ...day })),
      specialDates: [],
      temporaryClosure: { ...defaultOrderingSchedule.temporaryClosure },
      ...patch,
    },
  };
}

function ist(date, time) {
  return new Date(`${date}T${time}:00.000+05:30`);
}

test('default schedule opens daily at 09:00 and closes at 20:00 IST', () => {
  const config = settings();
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 2, at: ist('2026-08-17', '08:59') }).reasonCode, 'BEFORE_OPENING');
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 2, at: ist('2026-08-17', '09:00') }).acceptingOrders, true);
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 2, at: ist('2026-08-17', '20:00') }).reasonCode, 'AFTER_CLOSING');
});

test('zone cutoffs close B and C at 19:00 while A remains open until 20:00', () => {
  const config = settings();
  const at = ist('2026-08-17', '19:15');
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 2, at }).acceptingOrders, true);
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 6, at }).reasonCode, 'ORDER_CUTOFF_PASSED');
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 9, at }).reasonCode, 'ORDER_CUTOFF_PASSED');
});

test('a Tuesday override replaces regular hours for Tuesday only', () => {
  const config = settings();
  config.orderingSchedule.weeklySchedule[2] = { dayOfWeek: 2, isOpen: true, opensAt: '10:00', closesAt: '18:00' };
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 2, at: ist('2026-08-18', '09:30') }).reasonCode, 'BEFORE_OPENING');
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 2, at: ist('2026-08-18', '17:59') }).acceptingOrders, true);
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 2, at: ist('2026-08-18', '18:00') }).reasonCode, 'AFTER_CLOSING');
});

test('temporary closure automatically expires and normal schedule resumes', () => {
  const config = settings({
    temporaryClosure: {
      isActive: true,
      startsAt: ist('2026-08-17', '10:00').toISOString(),
      endsAt: ist('2026-08-18', '11:00').toISOString(),
      reason: 'Maintenance',
    },
  });
  const closed = evaluateStoreAvailability(config, { distanceKm: 2, at: ist('2026-08-18', '10:30') });
  const resumed = evaluateStoreAvailability(config, { distanceKm: 2, at: ist('2026-08-18', '11:00') });
  assert.equal(closed.reasonCode, 'TEMPORARILY_CLOSED');
  assert.equal(closed.nextOpenAt, ist('2026-08-18', '11:00').toISOString());
  assert.equal(resumed.acceptingOrders, true);
});

test('special closures override weekly hours and out-of-zone addresses are rejected', () => {
  const config = settings({
    specialDates: [{ date: '2026-08-19', isOpen: false, opensAt: '09:00', closesAt: '20:00', reason: 'Holiday' }],
  });
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 2, at: ist('2026-08-19', '12:00') }).reasonCode, 'SPECIAL_CLOSURE');
  assert.equal(evaluateStoreAvailability(config, { distanceKm: 30, at: ist('2026-08-20', '12:00') }).reasonCode, 'OUT_OF_DELIVERY_ZONE');
});
