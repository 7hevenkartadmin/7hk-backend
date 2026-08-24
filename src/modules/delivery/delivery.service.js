import { DeliverySlot } from './deliverySlot.model.js';
import { AppError } from '../../shared/utils/AppError.js';
import { parseStoreDate, storeDateKey, todayStoreRange, STORE_TIMEZONE } from '../../shared/utils/storeDate.js';
import { getStoreAvailability } from '../settings/storeAvailability.service.js';

function currentStoreTime(at = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: STORE_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
}

export async function listAvailableSlots(query = {}, { at = new Date() } = {}) {
  if (query.date && query.date !== storeDateKey(at)) {
    throw new AppError('Only same-day delivery is available', 422, 'SAME_DAY_DELIVERY_ONLY');
  }
  const availability = await getStoreAvailability({ distanceKm: query.distanceKm, at });
  if (!availability.acceptingOrders) return [];
  const today = parseStoreDate(storeDateKey(at));
  const filter = {
    date: { $gte: today.start, $lt: today.end },
    endsAt: { $gt: currentStoreTime(at) },
    isActive: true,
    $expr: { $lt: ['$booked', '$capacity'] },
  };
  if (query.serviceArea) filter.serviceArea = query.serviceArea;
  return DeliverySlot.find(filter).sort({ date: 1, startsAt: 1 });
}

export async function createSlot(payload, { at = new Date() } = {}) {
  const range = parseStoreDate(payload.date);
  if (!range) throw new AppError('Choose a valid delivery date', 422, 'INVALID_DELIVERY_DATE');
  const currentStoreDay = parseStoreDate(storeDateKey(at));
  if (range.end <= currentStoreDay.start) {
    throw new AppError('Delivery slots cannot be created for a past India date', 422, 'DELIVERY_DATE_IN_PAST');
  }
  if (storeDateKey(range.start) === storeDateKey(at) && payload.endsAt <= currentStoreTime(at)) {
    throw new AppError('Delivery slot must end after the current India time', 422, 'DELIVERY_SLOT_IN_PAST');
  }
  try {
    return await DeliverySlot.create({ ...payload, date: range.start });
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError('A delivery slot already exists for this date, time and service area', 409, 'DELIVERY_SLOT_EXISTS');
    }
    throw error;
  }
}

export async function listAdminSlots() {
  return DeliverySlot.find({ date: { $gte: todayStoreRange().start } }).sort({ date: 1, startsAt: 1 });
}

export async function updateSlot(id, payload) {
  const existing = await DeliverySlot.findById(id);
  if (!existing) throw new AppError('Delivery slot not found', 404, 'DELIVERY_SLOT_NOT_FOUND');
  if (payload.capacity !== undefined && payload.capacity < existing.booked) {
    throw new AppError('Capacity cannot be lower than current bookings', 409, 'SLOT_CAPACITY_CONFLICT');
  }
  existing.set(payload);
  await existing.save();
  return existing;
}

export async function reserveSlot(slotId, session) {
  const today = todayStoreRange();
  const slot = await DeliverySlot.findOneAndUpdate(
    {
      _id: slotId,
      date: { $gte: today.start, $lt: today.end },
      endsAt: { $gt: currentStoreTime() },
      isActive: true,
      $expr: { $lt: ['$booked', '$capacity'] },
    },
    { $inc: { booked: 1 } },
    { new: true, session },
  );
  if (!slot) throw new AppError('Delivery slot unavailable', 409, 'SLOT_UNAVAILABLE');
  return slot;
}

export async function releaseSlot(slotId, session) {
  if (!slotId) return null;
  return DeliverySlot.findOneAndUpdate(
    { _id: slotId, booked: { $gt: 0 } },
    { $inc: { booked: -1 } },
    { new: true, session },
  );
}
