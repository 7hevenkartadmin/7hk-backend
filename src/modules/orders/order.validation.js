import { z } from 'zod';
import { MAX_ITEM_QUANTITY } from '../../shared/utils/inventory.js';

const itemSchema = z.object({
  productId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  variantId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  quantity: z.number().int().positive().max(MAX_ITEM_QUANTITY),
});
const itemsSchema = z.array(itemSchema).min(1).refine(
  (items) => new Set(items.map((item) => item.productId + ':' + (item.variantId || ''))).size === items.length,
  'Duplicate cart items are not allowed',
);

export const quoteOrderSchema = z.object({
  items: itemsSchema,
  couponCode: z.string().max(40).optional(),
  addressId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

const razorpayPaymentSchema = z.object({
  razorpay_order_id: z.string().min(4),
  razorpay_payment_id: z.string().min(4),
  razorpay_signature: z.string().min(8),
});

export const createOrderSchema = quoteOrderSchema.extend({
  addressId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  slotId: z.string().min(12),
  paymentMethod: z.enum(['razorpay', 'cod']),
  paymentSessionId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  razorpayPayment: razorpayPaymentSchema.optional(),
  codTermsAccepted: z.boolean().optional().default(false),
})
  .refine((data) => data.paymentMethod !== 'razorpay' || data.paymentSessionId, { message: 'paymentSessionId is required for online payment' });

export const updateStatusSchema = z.object({
  status: z.enum(['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled']),
  note: z.string().max(240).optional(),
  deliveryAgent: z.object({
    name: z.string().min(2),
    phone: z.string().regex(/^(?:\+91)?[6-9][0-9]{9}$/, 'Enter a valid Indian phone number'),
  }).optional(),
});

export const verifyDeliveryOtpSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'Delivery OTP must contain 6 digits'),
});
