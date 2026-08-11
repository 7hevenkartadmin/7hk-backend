import { z } from 'zod';

const itemSchema = z.object({
  productId: z.string().min(12),
  variantId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  quantity: z.number().int().positive().max(99),
});

export const createRazorpayOrderSchema = z.object({
  items: z.array(itemSchema).min(1),
  couponCode: z.string().max(40).optional(),
  addressId: z.string().regex(/^[0-9a-fA-F]{24}$/),
}).strict();

export const verifyPaymentSchema = z.object({
  razorpay_order_id: z.string().min(4),
  razorpay_payment_id: z.string().min(4),
  razorpay_signature: z.string().min(8),
});
