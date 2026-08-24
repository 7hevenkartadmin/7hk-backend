import { z } from 'zod';
import { MAX_ITEM_QUANTITY } from '../../shared/utils/inventory.js';

const itemSchema = z.object({
  productId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  variantId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  quantity: z.number().int().positive().max(MAX_ITEM_QUANTITY),
}).strict();
const itemsSchema = z.array(itemSchema).min(1).refine(
  (items) => new Set(items.map((item) => item.productId + ':' + (item.variantId || ''))).size === items.length,
  'Duplicate cart items are not allowed',
);

export const createRazorpayOrderSchema = z.object({
  items: itemsSchema,
  couponCode: z.string().max(40).optional(),
  addressId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  slotId: z.string().regex(/^[0-9a-fA-F]{24}$/),
}).strict();

export const idempotencyKeySchema = z.string().trim().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const paymentSessionIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/);

export const verifyPaymentSchema = z.object({
  paymentSessionId: paymentSessionIdSchema,
  razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]+$/),
  razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]+$/),
  razorpay_signature: z.string().regex(/^[a-fA-F0-9]{64}$/),
}).strict();
