import { DeliverySlot } from './deliverySlot.model.js';
import { AppError } from '../../shared/utils/AppError.js';
import { parseStoreDate, storeDateKey, todayStoreRange } from '../../shared/utils/storeDate.js';
import { getStoreAvailability } from '../settings/storeAvailability.service.js';

const defaultWindows = [
  ['08:00', '10:00'],
  ['10:00', '12:00'],
  ['12:00', '14:00'],
  ['14:00', '16:00'],
  ['16:00', '18:00'],
  ['18:00', '20:00'],
];

function currentStoreTime(at = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
}

async function ensureTodaySlots(serviceArea = 'Patna', at = new Date()) {
  const operations = [];
  const date = parseStoreDate(storeDateKey(at)).start;
  const nowTime = currentStoreTime(at);
  for (const [startsAt, endsAt] of defaultWindows) {
    if (endsAt <= nowTime) continue;
    operations.push({
      updateOne: {
        filter: { date, startsAt, serviceArea },
        update: {
          $setOnInsert: {
            date,
            startsAt,
            endsAt,
            serviceArea,
            capacity: 50,
            booked: 0,
            isActive: true,
          },
        },
        upsert: true,
      },
    });
  }
  if (operations.length) await DeliverySlot.bulkWrite(operations, { ordered: false });
}

export async function listAvailableSlots(query = {}, { at = new Date() } = {}) {
  if (query.date && storeDateKey(new Date(query.date)) !== storeDateKey(at)) {
    throw new AppError('Only same-day delivery is available', 422, 'SAME_DAY_DELIVERY_ONLY');
  }
  const availability = await getStoreAvailability({ distanceKm: query.distanceKm, at });
  if (!availability.acceptingOrders) return [];
  await ensureTodaySlots(query.serviceArea || 'Patna', at);
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

export async function createSlot(payload) {
  return DeliverySlot.create(payload);
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
