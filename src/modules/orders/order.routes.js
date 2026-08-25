import { Router } from 'express';
import { created, ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { audit } from '../audit/audit.service.js';
import { isAndroidRequest } from '../../shared/middlewares/clientPlatform.js';
import { customerOrderActionRateLimiter, deliveryOtpRateLimiter } from '../../shared/middlewares/rateLimiters.js';
import { createOrderSchema, customerCancelOrderSchema, quoteOrderSchema, updateStatusSchema, verifyDeliveryOtpSchema } from './order.validation.js';
import { cancelCustomerOrder, createOrder, getOrderForCustomer, listCustomerOrders, quoteOrder, updateOrderStatus, verifyDeliveryOtp } from './order.service.js';
import { streamInvoicePdf } from './invoice.service.js';
import { Order } from './order.model.js';

export const orderRoutes = Router();

orderRoutes.use(requireAuth);

orderRoutes.post('/quote', authorize('customer'), validate(quoteOrderSchema), asyncHandler(async (req, res) => {
  ok(res, await quoteOrder(req.user, req.body, { excludePaanCorner: isAndroidRequest(req) }), 'Order quote calculated');
}));

orderRoutes.post('/', authorize('customer'), validate(createOrderSchema), asyncHandler(async (req, res) => {
  created(res, await createOrder(req.user, req.body, { excludePaanCorner: isAndroidRequest(req) }), 'Order placed');
}));

orderRoutes.post('/:id/cancel', authorize('customer'), customerOrderActionRateLimiter, validate(customerCancelOrderSchema), asyncHandler(async (req, res) => {
  const order = await cancelCustomerOrder(req.params.id, req.body.reason, req.user, { excludePaanCorner: isAndroidRequest(req) });
  ok(res, { order }, 'Order cancelled');
}));

orderRoutes.post('/admin/:id/verify-delivery-otp', authorize('admin', 'manager', 'support'), deliveryOtpRateLimiter, validate(verifyDeliveryOtpSchema), asyncHandler(async (req, res) => {
  const before = await Order.findById(req.params.id);
  const order = await verifyDeliveryOtp(req.params.id, req.body.otp, req.user, {
    restrictedProductChecksConfirmed: req.body.restrictedProductChecksConfirmed,
  });
  await audit({ req, action: 'order.delivery.verify', entityType: 'Order', entityId: order._id, before, after: order });
  ok(res, { order }, 'Delivery verified');
}));

orderRoutes.get('/me', authorize('customer'), asyncHandler(async (req, res) => {
  ok(res, { orders: await listCustomerOrders(req.user._id, { excludePaanCorner: isAndroidRequest(req) }) }, 'Orders loaded');
}));

orderRoutes.get('/:idOrNumber', authorize('customer'), asyncHandler(async (req, res) => {
  ok(res, { order: await getOrderForCustomer(req.params.idOrNumber, req.user, { excludePaanCorner: isAndroidRequest(req) }) }, 'Order loaded');
}));

orderRoutes.patch('/:id/status', authorize('admin', 'manager', 'support'), validate(updateStatusSchema), asyncHandler(async (req, res) => {
  const before = await Order.findById(req.params.id);
  const order = await updateOrderStatus(req.params.id, req.body, req.user);
  await audit({ req, action: 'order.status.update', entityType: 'Order', entityId: order._id, before, after: order });
  ok(res, { order }, 'Order status updated');
}));

orderRoutes.get('/:id/invoice', authorize('customer'), asyncHandler(async (req, res) => {
  const order = await getOrderForCustomer(req.params.id, req.user, { excludePaanCorner: isAndroidRequest(req) });
  streamInvoicePdf(order, res);
}));

orderRoutes.get('/', authorize('admin', 'manager', 'support'), asyncHandler(async (_req, res) => {
  const page = Math.max(1, Number(_req.query.page) || 1);
  const limit = Math.max(1, Math.min(500, Number(_req.query.limit) || 50));
  const skip = (page - 1) * limit;
  const orders = await Order.find().sort({ createdAt: -1 }).skip(skip).limit(limit);
  const total = await Order.countDocuments();
  ok(res, { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }, 'All orders loaded');
}));
