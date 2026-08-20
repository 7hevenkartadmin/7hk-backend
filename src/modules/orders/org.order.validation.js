import { z } from "zod";

const itemSchema = z.object({
  productId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  quantity: z.number().int().positive().max(99),
});

export const quoteOrderSchema = z.object({
  items: z.array(itemSchema).min(1),
  couponCode: z.string().max(40).optional(),
});

const razorpayPaymentSchema = z.object({
  razorpay_order_id: z.string().min(4),
  razorpay_payment_id: z.string().min(4),
  razorpay_signature: z.string().min(8),
});

export const createOrderSchema = quoteOrderSchema
  .extend({
    addressId: z.string().optional(),
    address: z
      .object({
        recipientName: z.string().min(2),
        phone: z.string().min(10),
        line1: z.string().min(4),
        line2: z.string().optional().default(""),
        landmark: z.string().optional().default(""),
        city: z.string().min(2),
        state: z.string().default("Bihar"),
        pincode: z.string().min(5),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        distanceFromStoreKm: z.number().min(0).optional(),
      })
      .optional(),
    slotId: z.string().min(12),
    paymentMethod: z.enum(["razorpay", "cod"]),
    razorpayPayment: razorpayPaymentSchema.optional(),
    codTermsAccepted: z.boolean().optional().default(false),
  })
  .refine((data) => data.addressId || data.address, {
    message: "addressId or address is required",
  })
  .refine((data) => data.paymentMethod !== "razorpay" || data.razorpayPayment, {
    message: "razorpayPayment is required for online payment",
  });

export const updateStatusSchema = z.object({
  status: z.enum([
    "placed",
    "confirmed",
    "packed",
    "out_for_delivery",
    "delivered",
    "cancelled",
  ]),
  note: z.string().max(240).optional(),
  deliveryAgent: z
    .object({
      name: z.string().min(2),
      phone: z.string().min(10),
    })
    .optional(),
});
