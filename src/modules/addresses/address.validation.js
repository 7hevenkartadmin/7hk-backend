import { z } from 'zod';

export const addressSchema = z.object({
  flatNumber: z.string().trim().max(100).optional().default(''),
  landmark: z.string().trim().max(120).optional().default(''),
  formattedAddress: z.string().trim().max(240).optional().default(''),
  recipientName: z.string().trim().min(2).max(80).optional(),
  phone: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().regex(/^(?:\+91)?[6-9][0-9]{9}$/, 'Enter a valid Indian phone number').optional()),
  line1: z.string().trim().min(4).max(160),
  line2: z.string().trim().max(160).optional().default(''),
  city: z.string().trim().min(2).max(80).optional().default('Parihar'),
  state: z.string().trim().min(2).max(80).optional().default('Bihar'),
  pincode: z.string().trim().min(5).max(10).optional().default('843324'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  isDefault: z.boolean().optional().default(false),
});

export const createAddressSchema = addressSchema;
export const validateAddressLocationSchema = addressSchema.pick({ latitude: true, longitude: true });
