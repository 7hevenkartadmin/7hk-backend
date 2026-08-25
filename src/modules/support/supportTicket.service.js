import { AppError } from '../../shared/utils/AppError.js';
import { User } from '../users/user.model.js';
import { Order } from '../orders/order.model.js';
import { initiateOrderRefund } from '../payments/payment.service.js';
import { SupportTicket } from './supportTicket.model.js';
import { matchesPickupOtp, pickupOtpForTicket } from './pickup-otp.service.js';

function customerTicketPayload(ticket) {
  const payload = typeof ticket.toObject === 'function' ? ticket.toObject() : { ...ticket };
  if (payload.status === 'pickup_scheduled') payload.pickupOtp = pickupOtpForTicket(payload._id);
  return payload;
}

export async function createSupportTicket(customer, payload) {
  const order = await Order.findOne({ _id: payload.orderId, customer: customer._id });
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (order.status !== 'delivered') {
    throw new AppError('Support tickets for item issues are available after delivery.', 409, 'SUPPORT_TICKET_DELIVERY_REQUIRED');
  }
  const existing = await SupportTicket.findOne({
    order: order._id,
    customer: customer._id,
    status: { $in: ['open', 'pickup_scheduled', 'processing', 'refund_pending', 'refund_failed'] },
  });
  if (existing) throw new AppError('An active support ticket already exists for this order.', 409, 'SUPPORT_TICKET_ALREADY_OPEN');
  return SupportTicket.create({
    order: order._id,
    customer: customer._id,
    activeOrderKey: String(order._id),
    category: payload.category,
    description: payload.description,
    proofImages: payload.proofImages,
  });
}

export async function listCustomerSupportTickets(customer) {
  const tickets = await SupportTicket.find({ customer: customer._id }).sort({ createdAt: -1 });
  return tickets.map(customerTicketPayload);
}

export async function listAdminSupportTickets(query) {
  const filter = query.status === 'all' ? {} : { status: query.status };
  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    SupportTicket.find(filter)
      .populate('customer', 'name phone email rejectedTicketsCount isCodDisabled')
      .populate('order', 'orderNumber total paymentMethod paymentStatus status items refund')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit),
    SupportTicket.countDocuments(filter),
  ]);
  return { items, meta: { page: query.page, limit: query.limit, total, pages: Math.max(1, Math.ceil(total / query.limit)) } };
}

async function applyApprovedRefund(ticket, actor) {
  const order = await Order.findById(ticket.order);
  if (!order || order.status !== 'delivered') throw new AppError('Delivered order not found', 404, 'ORDER_NOT_FOUND');
  const now = new Date();

  if (order.paymentMethod === 'cod') {
    ticket.status = 'cod_refund_approved';
    ticket.activeOrderKey = undefined;
    ticket.refundAmount = order.total;
    ticket.reviewedAt = ticket.reviewedAt || now;
    ticket.reviewedBy = ticket.reviewedBy || actor._id;
    await ticket.save();
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          paymentStatus: 'cod_refund_approved',
          refund: {
            status: 'cod_refund_approved', amount: order.total, reason: 'SUPPORT_TICKET_APPROVED',
            supportTicket: ticket._id, initiatedAt: now, requiresManualReview: true,
          },
        },
        $push: { refundTimeline: {
          eventKey: `support:${ticket._id}:cod_refund_approved`, status: 'cod_refund_approved',
          amount: order.total, note: 'COD refund approved for manual settlement', at: now,
        } },
      },
    );
    return ticket;
  }

  await Order.updateOne(
    { _id: order._id },
    { $set: {
      paymentStatus: 'refund_pending',
      'refund.status': 'refund_pending',
      'refund.amount': order.total,
      'refund.reason': 'SUPPORT_TICKET_APPROVED',
      'refund.supportTicket': ticket._id,
      'refund.initiatedAt': now,
      'refund.requiresManualReview': false,
    } },
  );
  try {
    const intent = await initiateOrderRefund(order, 'SUPPORT_TICKET_APPROVED');
    ticket.providerRefundId = intent?.refundId;
    ticket.refundAmount = Number(intent?.refundAmountPaise || Math.round(order.total * 100)) / 100;
    ticket.status = intent?.status === 'refunded' ? 'refunded' : intent?.status === 'refund_failed' ? 'refund_failed' : 'refund_pending';
    if (ticket.status === 'refunded') ticket.activeOrderKey = undefined;
    await ticket.save();
    if (ticket.providerRefundId) {
      await Order.updateOne({ _id: order._id }, { $set: {
        'refund.providerRefundId': ticket.providerRefundId,
        'refund.supportTicket': ticket._id,
      } });
    }
    return ticket;
  } catch (error) {
    ticket.status = 'refund_failed';
    await ticket.save();
    await Order.updateOne({ _id: order._id }, { $set: {
      paymentStatus: 'refund_failed',
      'refund.status': 'refund_failed',
      'refund.supportTicket': ticket._id,
      'refund.requiresManualReview': true,
      'refund.failedAt': new Date(),
    } });
    throw error;
  }
}

export async function approveSupportTicket(ticketId, payload, actor) {
  const nextStatus = payload.requiresPickup ? 'pickup_scheduled' : 'processing';
  const ticket = await SupportTicket.findOneAndUpdate(
    { _id: ticketId, status: 'open' },
    { $set: {
      status: nextStatus,
      requiresPickup: payload.requiresPickup,
      reviewNote: payload.note,
      reviewedAt: new Date(),
      reviewedBy: actor._id,
    } },
    { new: true },
  );
  if (!ticket) {
    const existing = await SupportTicket.findById(ticketId);
    if (!existing) throw new AppError('Support ticket not found', 404, 'SUPPORT_TICKET_NOT_FOUND');
    if (['pickup_scheduled', 'processing', 'refund_pending', 'refunded', 'refund_failed', 'cod_refund_approved'].includes(existing.status)) return existing;
    throw new AppError('Only an open support ticket can be approved.', 409, 'SUPPORT_TICKET_ALREADY_REVIEWED');
  }
  return payload.requiresPickup ? ticket : applyApprovedRefund(ticket, actor);
}

export async function verifySupportPickup(ticketId, otp, actor) {
  const current = await SupportTicket.findById(ticketId);
  if (!current) throw new AppError('Support ticket not found', 404, 'SUPPORT_TICKET_NOT_FOUND');
  if (current.status !== 'pickup_scheduled') throw new AppError('Pickup verification is not available for this ticket.', 409, 'PICKUP_NOT_READY');
  if (!matchesPickupOtp(current._id, otp)) throw new AppError('Invalid pickup OTP', 401, 'PICKUP_OTP_INVALID');
  const ticket = await SupportTicket.findOneAndUpdate(
    { _id: current._id, status: 'pickup_scheduled' },
    { $set: { status: 'processing', pickupVerifiedAt: new Date(), pickupVerifiedBy: actor._id } },
    { new: true },
  );
  if (!ticket) throw new AppError('Pickup was already verified.', 409, 'PICKUP_ALREADY_VERIFIED');
  return applyApprovedRefund(ticket, actor);
}

export async function rejectSupportTicket(ticketId, payload, actor) {
  const ticket = await SupportTicket.findOneAndUpdate(
    { _id: ticketId, status: 'open' },
    {
      $set: { status: 'rejected', reviewNote: payload.note, reviewedAt: new Date(), reviewedBy: actor._id },
      $unset: { activeOrderKey: 1 },
    },
    { new: true },
  );
  if (!ticket) {
    const existing = await SupportTicket.findById(ticketId);
    if (!existing) throw new AppError('Support ticket not found', 404, 'SUPPORT_TICKET_NOT_FOUND');
    if (existing.status === 'rejected') return existing;
    throw new AppError('Only an open support ticket can be rejected.', 409, 'SUPPORT_TICKET_ALREADY_REVIEWED');
  }
  const customer = await User.findOneAndUpdate(
    { _id: ticket.customer },
    { $inc: { rejectedTicketsCount: 1 } },
    { new: true },
  );
  if (customer && customer.rejectedTicketsCount > 2 && !customer.isCodDisabled) {
    await User.updateOne(
      { _id: customer._id, isCodDisabled: { $ne: true } },
      { $set: { isCodDisabled: true, codDisabledAt: new Date() } },
    );
  }
  return ticket;
}
