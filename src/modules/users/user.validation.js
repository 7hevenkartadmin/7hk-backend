import { z } from 'zod';
export { addressSchema } from '../addresses/address.validation.js';

export const updateProfileSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  email: z.string().email().optional(),
});
