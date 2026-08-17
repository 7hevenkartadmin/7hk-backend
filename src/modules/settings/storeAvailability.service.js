import { AppError } from '../../shared/utils/AppError.js';
import { storeDateKey } from '../../shared/utils/storeDate.js';
import { getStoreSettings } from './settings.service.js';

const STORE_TIMEZONE = 'Asia/Kolkata';
const STORE_OFFSET = '+05:30';

function timeKey(value) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: STORE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}

function dateAtOffset(dateKey, offset) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function dayOfWeek(dateKey) {
  return new Date(`${dateKey}T12:00:00.000${STORE_OFFSET}`).getUTCDay();
}

function dateTime(dateKey, time) {
  return new Date(`${dateKey}T${time}:00.000${STORE_OFFSET}`);
}

function scheduleForDate(orderingSchedule, dateKey) {
  const special = orderingSchedule.specialDates?.find((entry) => entry.date === dateKey);
  if (special) return { ...special, source: 'special_date' };
  const weekly = orderingSchedule.weeklySchedule?.find((entry) => Number(entry.dayOfWeek) === dayOfWeek(dateKey));
  return { ...(weekly || { isOpen: false, opensAt: '09:00', closesAt: '20:00' }), source: 'weekly_schedule' };
}

function activeTemporaryClosure(closure, at) {
  if (!closure?.isActive || !closure.endsAt) return null;
  const startsAt = closure.startsAt ? new Date(closure.startsAt) : new Date(0);
  const endsAt = new Date(closure.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;
  return at >= startsAt && at < endsAt ? { ...closure, startsAt, endsAt } : null;
}

function selectZone(deliveryZones, distanceKm) {
  const activeZones = deliveryZones.filter((zone) => zone.isActive !== false).sort((a, b) => Number(a.limit) - Number(b.limit));
  if (distanceKm === undefined || distanceKm === null || distanceKm === '') return { zone: null, activeZones };
  const distance = Number(distanceKm);
  return { zone: activeZones.find((item) => distance <= Number(item.limit)) || null, activeZones };
}

function cutoffForDate(dateKey, schedule, zone, activeZones) {
  const cutoffTime = zone?.orderCutoff
    || activeZones.map((item) => item.orderCutoff || '19:00').sort().at(-1)
    || schedule.closesAt;
  const closesAt = dateTime(dateKey, schedule.closesAt);
  const zoneCutoffAt = dateTime(dateKey, cutoffTime);
  return zoneCutoffAt < closesAt ? zoneCutoffAt : closesAt;
}

function nextOpening({ orderingSchedule, activeZones, zone, at, closure }) {
  const today = storeDateKey(at);
  for (let offset = 0; offset < 15; offset += 1) {
    const dateKey = dateAtOffset(today, offset);
    const schedule = scheduleForDate(orderingSchedule, dateKey);
    if (!schedule.isOpen) continue;
    const opensAt = dateTime(dateKey, schedule.opensAt);
    const orderEndsAt = cutoffForDate(dateKey, schedule, zone, activeZones);
    let candidate = opensAt > at ? opensAt : at;
    if (closure && candidate < closure.endsAt) candidate = closure.endsAt;
    if (candidate < orderEndsAt) return candidate.toISOString();
  }
  return null;
}

function closedState(base, reasonCode, message, nextOpenAt, extra = {}) {
  return { ...base, isOpen: false, acceptingOrders: false, reasonCode, message, nextOpenAt, ...extra };
}

export function evaluateStoreAvailability(settings, { distanceKm, at = new Date() } = {}) {
  const orderingSchedule = settings.orderingSchedule;
  const localDate = storeDateKey(at);
  const localTime = timeKey(at);
  const schedule = scheduleForDate(orderingSchedule, localDate);
  const { zone, activeZones } = selectZone(settings.deliveryZones, distanceKm);
  const closure = activeTemporaryClosure(orderingSchedule.temporaryClosure, at);
  const base = {
    timezone: STORE_TIMEZONE,
    checkedAt: at.toISOString(),
    localDate,
    localTime,
    sameDayDeliveryOnly: true,
    schedule: { isOpen: schedule.isOpen, opensAt: schedule.opensAt, closesAt: schedule.closesAt, source: schedule.source },
    zone: zone ? { code: zone.code, label: zone.label, limit: zone.limit, orderCutoff: zone.orderCutoff } : null,
  };
  const nextOpen = () => nextOpening({ orderingSchedule, activeZones, zone, at, closure });

  if ((distanceKm !== undefined && distanceKm !== null && distanceKm !== '') && !zone) {
    return closedState(base, 'OUT_OF_DELIVERY_ZONE', 'This address is outside all active delivery zones.', null);
  }
  if (!activeZones.length) {
    return closedState(base, 'NO_ACTIVE_DELIVERY_ZONE', 'Ordering is unavailable because no delivery zone is active.', null);
  }
  if (closure) {
    return closedState(base, 'TEMPORARILY_CLOSED', closure.reason || 'The store is temporarily closed.', nextOpen(), {
      temporaryClosureEndsAt: closure.endsAt.toISOString(),
    });
  }
  if (!schedule.isOpen) {
    const code = schedule.source === 'special_date' ? 'SPECIAL_CLOSURE' : 'CLOSED_TODAY';
    return closedState(base, code, schedule.reason || 'The store is closed today.', nextOpen());
  }

  const opensAt = dateTime(localDate, schedule.opensAt);
  const closesAt = dateTime(localDate, schedule.closesAt);
  const orderCutoffAt = cutoffForDate(localDate, schedule, zone, activeZones);
  if (at < opensAt) {
    return closedState(base, 'BEFORE_OPENING', `Ordering opens at ${schedule.opensAt}.`, opensAt.toISOString(), { opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString(), orderCutoffAt: orderCutoffAt.toISOString() });
  }
  if (at >= closesAt) {
    return closedState(base, 'AFTER_CLOSING', 'The store has closed for today.', nextOpen(), { closesAt: closesAt.toISOString(), orderCutoffAt: orderCutoffAt.toISOString() });
  }
  if (at >= orderCutoffAt) {
    return {
      ...base,
      isOpen: true,
      acceptingOrders: false,
      reasonCode: 'ORDER_CUTOFF_PASSED',
      message: zone ? `${zone.label} ordering closed at ${zone.orderCutoff}.` : 'Ordering has closed for today.',
      nextOpenAt: nextOpen(),
      closesAt: closesAt.toISOString(),
      orderCutoffAt: orderCutoffAt.toISOString(),
    };
  }
  return {
    ...base,
    isOpen: true,
    acceptingOrders: true,
    reasonCode: 'OPEN',
    message: zone ? `Accepting same-day orders for ${zone.label}.` : 'Accepting same-day orders.',
    nextOpenAt: null,
    opensAt: opensAt.toISOString(),
    closesAt: closesAt.toISOString(),
    orderCutoffAt: orderCutoffAt.toISOString(),
  };
}

export async function getStoreAvailability(options = {}) {
  return evaluateStoreAvailability(await getStoreSettings(), options);
}

export async function assertStoreAcceptingOrders(options = {}) {
  const availability = await getStoreAvailability(options);
  if (!availability.acceptingOrders) {
    throw new AppError(availability.message, 409, availability.reasonCode, { availability });
  }
  return availability;
}
