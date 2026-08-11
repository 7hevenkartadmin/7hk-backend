import { z } from 'zod';

export const applyCouponSchema = z.object({
  code: z.string().min(2).max(40),
  subtotal: z.number().min(0),
});

export const couponSchema = z.object({
  code: z.string().min(2).max(40),
  description: z.string().max(200).default(''),
  type: z.enum(['flat', 'percentage']),
  value: z.number().min(0),
  maxDiscount: z.number().min(0).default(0),
  minOrderValue: z.number().min(0).default(0),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  usageLimit: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
}).refine((data) => data.endsAt > data.startsAt, {
  message: 'End date must be after start date',
  path: ['endsAt'],
});
