import { z } from 'zod';

export const restrictedProductConsentSchema = z.object({
  legalAgeConfirmed: z.literal(true),
  educationalInstitutionDistanceConfirmed: z.literal(true),
  healthWarningAcknowledged: z.literal(true),
  addressId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
}).strict();
