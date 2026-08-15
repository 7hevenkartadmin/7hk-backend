import { DeliverySlot } from './deliverySlot.model.js';
import { AppError } from '../../shared/utils/AppError.js';

const defaultWindows = [
  ['08:00', '10:00'],
  ['10:00', '12:00'],
  ['12:00', '14:00'],
  ['14:00', '16:00'],
  ['16:00', '18:00'],
  ['18:00', '20:00'],
];

function startOfDay(offset = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date;
}

function slotHasNotEnded(slotDate, endsAt) {
  const [hour, minute] = endsAt.split(':').map(Number);
  const end = new Date(slotDate);
  end.setHours(hour, minute, 0, 0);
  return end > new Date();
}

async function ensureUpcomingSlots(serviceArea = 'Patna') {
  const operations = [];
  for (const dayOffset of [0, 1]) {
    const date = startOfDay(dayOffset);
    for (const [startsAt, endsAt] of defaultWindows) {
      if (!slotHasNotEnded(date, endsAt)) continue;
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
  }
  if (operations.length) await DeliverySlot.bulkWrite(operations, { ordered: false });
}

export async function listAvailableSlots(query = {}) {
  await ensureUpcomingSlots(query.serviceArea || 'Patna');
  const filter = { isActive: true, $expr: { $lt: ['$booked', '$capacity'] } };
  if (query.serviceArea) filter.serviceArea = query.serviceArea;
  if (query.date) {
    const date = new Date(query.date);
    const next = new Date(date);
    next.setDate(date.getDate() + 1);
    filter.date = { $gte: date, $lt: next };
  } else {
    filter.date = { $gte: new Date() };
  }
  return DeliverySlot.find(filter).sort({ date: 1, startsAt: 1 });
}

export async function createSlot(payload) {
  return DeliverySlot.create(payload);
}

export async function listAdminSlots() {
  return DeliverySlot.find({ date: { $gte: startOfDay(-1) } }).sort({ date: 1, startsAt: 1 });
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
  const slot = await DeliverySlot.findOneAndUpdate(
    { _id: slotId, isActive: true, $expr: { $lt: ['$booked', '$capacity'] } },
    { $inc: { booked: 1 } },
    { new: true, session },
  );
  if (!slot) throw new AppError('Delivery slot unavailable', 409, 'SLOT_UNAVAILABLE');
  return slot;
}
