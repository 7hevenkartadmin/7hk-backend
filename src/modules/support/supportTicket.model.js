import mongoose from 'mongoose';

export const SUPPORT_TICKET_CATEGORIES = [
  'damaged', 'expired', 'wrong_item', 'missing_item', 'quality_issue', 'other',
];

export const SUPPORT_TICKET_STATUSES = [
  'open', 'pickup_scheduled', 'processing', 'refund_pending', 'refunded',
  'refund_failed', 'cod_refund_approved', 'rejected',
];

const supportTicketSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  activeOrderKey: { type: String, trim: true },
  orderDeliveredAt: Date,
  submissionDeadline: Date,
  category: { type: String, enum: SUPPORT_TICKET_CATEGORIES, required: true },
  description: { type: String, trim: true, required: true, maxlength: 1500 },
  proofImages: [{ type: String, trim: true }],
  status: { type: String, enum: SUPPORT_TICKET_STATUSES, default: 'open', index: true },
  requiresPickup: { type: Boolean, default: false },
  pickupVerifiedAt: Date,
  pickupVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewNote: { type: String, trim: true, maxlength: 500 },
  providerRefundId: String,
  refundAmount: { type: Number, min: 0 },
  refundArn: String,
}, { timestamps: true });

supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ customer: 1, order: 1, createdAt: -1 });
supportTicketSchema.index(
  { activeOrderKey: 1 },
  { name: 'support_ticket_active_order_unique', unique: true, partialFilterExpression: { activeOrderKey: { $type: 'string' } } },
);
supportTicketSchema.index(
  { providerRefundId: 1 },
  { name: 'support_ticket_provider_refund', unique: true, partialFilterExpression: { providerRefundId: { $type: 'string' } } },
);

export const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);
