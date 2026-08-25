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
  paymentStatus: z.enum(['pending', 'paid', 'failed', 'refund_pending', 'refund_failed', 'partially_refunded', 'refunded', 'cod_refund_approved']).optional(),
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

export const auditLogsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(80).optional(),
  actorRole: z.enum(['owner', 'admin', 'manager', 'support']).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  search: z.string().trim().max(80).optional(),
  criticalFilter: z.enum(['all', 'product_price', 'coupon_creation', 'delivery_charge']).optional(),
  criticalType: z.enum(['all', 'product_price', 'coupon_creation', 'delivery_charge']).default('all'),
  criticalPage: z.coerce.number().int().positive().default(1),
  criticalLimit: z.coerce.number().int().positive().max(50).default(12),
}).refine((query) => !query.from || !query.to || query.from <= query.to, {
  message: 'from must be before or equal to to',
  path: ['to'],
});
