import { z } from 'zod';
import { ORDER_STATUSES } from '../orders/order.model.js';
import { parseStoreDate } from '../../shared/utils/storeDate.js';

const dateString = z.string().refine((value) => Boolean(parseStoreDate(value)), 'Invalid date. Use YYYY-MM-DD');

export const adminOrdersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(15),
  date: dateString.optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(['pending', 'paid', 'failed', 'refunded']).optional(),
  search: z.string().trim().max(80).optional(),
}).refine((query) => !(query.date && (query.from || query.to)), {
  message: 'Use either date or from/to filters',
}).refine((query) => !query.from || !query.to || query.from <= query.to, {
  message: 'from must be before or equal to to',
  path: ['to'],
});

export const dashboardStatsQuerySchema = z.object({
  period: z.enum(['weekly', 'monthly', 'yearly']).default('weekly'),
});
