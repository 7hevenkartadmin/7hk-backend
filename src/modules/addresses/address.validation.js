import { z } from 'zod';

export const createAddressSchema = z.object({
  label: z.enum(['Home', 'Work', 'Hotel', 'Other']).default('Home'),
  flatNumber: z.string().trim().min(1).max(100),
  landmark: z.string().trim().max(120).optional().default(''),
  formattedAddress: z.string().trim().min(4).max(240),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  recipientName: z.string().trim().min(2).max(80).optional(),
  phone: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().min(10).max(20).optional()),
  city: z.string().trim().min(2).max(80).optional().default('Parihar'),
  state: z.string().trim().min(2).max(80).optional().default('Bihar'),
  pincode: z.string().trim().min(5).max(10).optional().default('843324'),
  isDefault: z.boolean().optional().default(true),
}).refine((value) => Number.isFinite(value.lat ?? value.latitude), {
  message: 'Latitude is required',
  path: ['lat'],
}).refine((value) => Number.isFinite(value.lng ?? value.longitude), {
  message: 'Longitude is required',
  path: ['lng'],
});
