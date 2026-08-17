import { z } from 'zod';

export const deliverySlotSchema = z.object({
  date: z.coerce.date(),
  startsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  capacity: z.number().int().positive(),
  serviceArea: z.string().min(2).max(80).default('Patna'),
  isActive: z.boolean().default(true),
}).refine((data) => data.endsAt > data.startsAt, {
  message: 'End time must be after start time',
  path: ['endsAt'],
});

export const deliverySlotUpdateSchema = z.object({
  capacity: z.number().int().positive().optional(),
  serviceArea: z.string().min(2).max(80).optional(),
  isActive: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, { message: 'At least one slot field is required' });

export const deliverySlotsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  serviceArea: z.string().trim().min(2).max(80).optional(),
  distanceKm: z.coerce.number().min(0).max(200).optional(),
});
