import { Router } from 'express';
import mongoose from 'mongoose';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { Product } from '../catalog/product.model.js';
import { Order } from '../orders/order.model.js';
import { User } from '../users/user.model.js';
import { AuditLog } from '../audit/audit.model.js';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/utils/AppError.js';
import { auditLogsQuerySchema, adminOrdersQuerySchema, dashboardStatsQuerySchema } from './admin.validation.js';
import { getDashboardStats, listAdminOrders } from './admin.service.js';
import { parseStoreDate, todayStoreRange } from '../../shared/utils/storeDate.js';

export const adminRoutes = Router();

adminRoutes.use(requireAuth, authorize('admin', 'manager'));

adminRoutes.get('/customers', asyncHandler(async (_req, res) => {
  const customers = await User.find({ role: 'customer' }).sort({ createdAt: -1 }).limit(200);
  ok(res, { customers }, 'Customers loaded');
}));

adminRoutes.patch('/customers/:id/status', authorize('admin'), asyncHandler(async (req, res) => {
  const validStatuses = ['active', 'blocked'];
  if (!validStatuses.includes(req.body.status)) {
    throw new AppError('Invalid status value', 400, 'INVALID_STATUS');
  }
  const user = await User.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true, runValidators: true });
  ok(res, { user }, 'Customer status updated');
}));

adminRoutes.get('/inventory/low-stock', asyncHandler(async (_req, res) => {
  const products = await Product.find({ stock: { $lt: env.LOW_STOCK_THRESHOLD }, isActive: true }).sort({ stock: 1 });
  ok(res, { products }, 'Low stock products loaded');
}));

adminRoutes.get('/dashboard/stats', validate(dashboardStatsQuerySchema, 'query'), asyncHandler(async (req, res) => {
  ok(res, await getDashboardStats(req.query.period), 'Dashboard statistics loaded');
}));

adminRoutes.get('/orders', validate(adminOrdersQuerySchema, 'query'), asyncHandler(async (req, res) => {
  ok(res, await listAdminOrders(req.query), 'Orders loaded');
}));

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactAuditValue(value) {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (value._bsontype === 'ObjectId') return String(value);
  return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => {
    const sensitive = /(password|token|secret|authorization|cookie|otp|hash)/i.test(key);
    return [key, sensitive ? '[REDACTED]' : redactAuditValue(nestedValue)];
  }));
}

adminRoutes.get('/audit-logs', validate(auditLogsQuerySchema, 'query'), asyncHandler(async (req, res) => {
  const { page, limit, action, entityType, actorRole, from, to, search } = req.query;
  const filter = {};
  if (action) filter.action = action;
  if (entityType) filter.entityType = entityType;
  if (actorRole) filter.actorRole = actorRole;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = parseStoreDate(from).start;
    if (to) filter.createdAt.$lt = parseStoreDate(to).end;
  }
  if (search) {
    const pattern = new RegExp(`^${escapeRegex(search)}`, 'i');
    filter.$or = [{ action: pattern }, { entityType: pattern }, { entityId: pattern }];
  }

  const skip = (page - 1) * limit;
  const today = todayStoreRange();
  const [items, total, todayCount, actions, entityTypes] = await Promise.all([
    AuditLog.find(filter)
      .populate('actor', 'name email role')
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
    AuditLog.countDocuments({ createdAt: { $gte: today.start, $lt: today.end } }),
    AuditLog.distinct('action'),
    AuditLog.distinct('entityType'),
  ]);

  ok(res, {
    items: items.map((item) => ({
      ...item,
      before: redactAuditValue(item.before),
      after: redactAuditValue(item.after),
    })),
    meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    summary: { today: todayCount },
    filters: { actions: actions.sort(), entityTypes: entityTypes.sort() },
  }, 'Audit logs loaded');
}));

adminRoutes.get('/orders/:id/invoice', asyncHandler(async (req, res) => {
  const filters = [{ orderNumber: req.params.id }];
  if (mongoose.Types.ObjectId.isValid(req.params.id)) filters.push({ _id: req.params.id });
  const order = await Order.findOne({ $or: filters });
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  ok(res, { invoice: order.invoice, order }, 'Admin invoice loaded');
}));
