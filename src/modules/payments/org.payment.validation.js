import { z } from "zod";

const itemSchema = z.object({
  productId: z.string().min(12),
  quantity: z.number().int().positive().max(99),
});

export const createRazorpayOrderSchema = z.object({
  items: z.array(itemSchema).min(1),
  couponCode: z.string().max(40).optional(),
  distanceFromStoreKm: z.number().min(0).optional(),
});

export const verifyPaymentSchema = z.object({
  razorpay_order_id: z.string().min(4),
  razorpay_payment_id: z.string().min(4),
  razorpay_signature: z.string().min(8),
});
