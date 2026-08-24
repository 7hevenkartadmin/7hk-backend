import { z } from 'zod';
import { parseStoreDateTime } from '../../shared/utils/storeDate.js';

const storeDateTime = (options) => z.any().transform((value, context) => {
  const date = parseStoreDateTime(value, options);
  if (!date) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose a valid Asia/Kolkata date and time' });
    return z.NEVER;
  }
  return date;
});

export const applyCouponSchema = z.object({
  code: z.string().trim().min(2).max(40),
  subtotal: z.number().min(0),
}).strict();

export const couponSchema = z.object({
  code: z.string().trim().min(2).max(40),
  description: z.string().max(200).default(''),
  image: z.string().trim().url('Upload a valid coupon image'),
  type: z.enum(['flat', 'percentage']),
  value: z.number().positive(),
  maxDiscount: z.number().min(0).default(0),
  minOrderValue: z.number().min(0).default(0),
  startsAt: storeDateTime(),
  endsAt: storeDateTime({ endOfDay: true }),
  usageLimit: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
}).strict().refine((data) => data.type !== 'percentage' || data.value <= 100, {
  message: 'Percentage discount cannot exceed 100',
  path: ['value'],
}).refine((data) => data.endsAt > data.startsAt, {
  message: 'End date must be after start date',
  path: ['endsAt'],
});

export const couponRedemptionQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['reserved', 'consumed', 'released']).optional(),
}).strict();
