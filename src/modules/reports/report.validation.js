import { z } from 'zod';
import { parseStoreDate } from '../../shared/utils/storeDate.js';

const storeDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => Boolean(parseStoreDate(value)), 'Choose a real India calendar date');

export const salesReportQuerySchema = z.object({
  startDate: storeDate.optional(),
  endDate: storeDate.optional(),
  period: z.enum(['daily', 'weekly', 'monthly', 'yearly']).default('daily'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(50),
});
