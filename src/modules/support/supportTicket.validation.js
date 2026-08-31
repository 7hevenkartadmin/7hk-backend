import { z } from 'zod';
import { SUPPORT_TICKET_CATEGORIES } from './supportTicket.model.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

export const createSupportTicketSchema = z.object({
  orderId: objectId,
  category: z.enum(SUPPORT_TICKET_CATEGORIES),
  description: z.string().trim().min(10).max(1500),
  proofImages: z.array(z.string().url().max(1000)).max(3).default([]),
}).strict().superRefine((data, context) => {
  if (['damaged', 'expired'].includes(data.category) && data.proofImages.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['proofImages'], message: 'A proof image is required for damaged or expired items' });
  }
});

export const supportProofUploadSchema = z.object({
  orderId: objectId,
}).strict();

export const reviewSupportTicketSchema = z.object({
  note: z.string().trim().min(3).max(500),
  requiresPickup: z.boolean().optional().default(false),
}).strict();

export const verifyPickupOtpSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'Pickup OTP must contain 6 digits'),
}).strict();

export const listSupportTicketsSchema = z.object({
  status: z.enum(['all', 'open', 'pickup_scheduled', 'processing', 'refund_pending', 'refunded', 'refund_failed', 'cod_refund_approved', 'rejected']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
