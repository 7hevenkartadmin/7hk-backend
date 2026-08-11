import { Router } from 'express';
import mongoose from 'mongoose';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { Product } from '../catalog/product.model.js';
import { Order } from '../orders/order.model.js';
import { User } from '../users/user.model.js';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/utils/AppError.js';

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

adminRoutes.get('/orders', asyncHandler(async (_req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 }).limit(300);
  ok(res, { orders }, 'Orders loaded');
}));

adminRoutes.get('/orders/:id/invoice', asyncHandler(async (req, res) => {
  const filters = [{ orderNumber: req.params.id }];
  if (mongoose.Types.ObjectId.isValid(req.params.id)) filters.push({ _id: req.params.id });
  const order = await Order.findOne({ $or: filters });
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  ok(res, { invoice: order.invoice, order }, 'Admin invoice loaded');
}));
