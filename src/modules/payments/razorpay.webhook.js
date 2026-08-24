import crypto from 'crypto';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { Order } from '../orders/order.model.js';
import { Payment } from './payment.model.js';
import { applyRazorpayRefund, applyRazorpayWebhookPayment, initiateOrderRefund } from './payment.service.js';
import { PaymentWebhookEvent } from './paymentWebhookEvent.model.js';

export const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;

function timingSafeSignature(expected, received) {
  if (!/^[a-f0-9]{64}$/i.test(String(received || ''))) return false;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function isValidRazorpayWebhookSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeSignature(expected, signature);
}

export function extractRazorpayWebhookPayment(payload) {
  return payload?.payload?.payment?.entity || null;
}

export async function applyRefund(refund) {
  return applyRazorpayRefund(refund);
}

export async function processWebhook(payload) {
  const payment = extractRazorpayWebhookPayment(payload);
  if (['payment.authorized', 'payment.captured', 'payment.failed', 'order.paid'].includes(payload.event) && payment) {
    const intent = await applyRazorpayWebhookPayment(payment);
    if (intent && payment.status === 'captured') {
      await Payment.updateOne(
        { providerPaymentId: payment.id, status: { $in: ['created', 'authorized'] } },
        { $set: { status: 'captured' } },
      );
      await Order.updateOne(
        { paymentIntent: intent._id, status: { $ne: 'cancelled' }, paymentStatus: 'pending' },
        { $set: { paymentStatus: 'paid' } },
      );
      const cancelledOrder = await Order.findOne({
        paymentIntent: intent._id,
        status: 'cancelled',
        paymentStatus: { $ne: 'refunded' },
      });
      if (cancelledOrder) await initiateOrderRefund(cancelledOrder, 'LATE_CAPTURE_CANCELLED');
    }
    return Boolean(intent);
  }
  if (payload.event === 'refund.processed') {
    await applyRefund(payload?.payload?.refund?.entity);
    return true;
  }
  return false;
}

export async function recordAndProcess(eventId, payload, { now = new Date() } = {}) {
  let record;
  try {
    record = await PaymentWebhookEvent.create({
      eventId,
      eventType: payload.event || 'unknown',
      providerOrderId: extractRazorpayWebhookPayment(payload)?.order_id,
      providerPaymentId: extractRazorpayWebhookPayment(payload)?.id,
      status: 'processing',
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    record = await PaymentWebhookEvent.findOneAndUpdate(
      {
        eventId,
        $or: [
          { status: 'failed' },
          { status: 'processing', updatedAt: { $lte: new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS) } },
        ],
      },
      {
        $set: {
          status: 'processing',
          eventType: payload.event || 'unknown',
          providerOrderId: extractRazorpayWebhookPayment(payload)?.order_id,
          providerPaymentId: extractRazorpayWebhookPayment(payload)?.id,
        },
        $unset: { failure: 1, processedAt: 1 },
      },
      { new: true },
    );
    if (!record) return;
  }

  try {
    const processed = await processWebhook(payload);
    record.status = processed ? 'processed' : 'ignored';
    record.processedAt = new Date();
    await record.save();
  } catch (error) {
    record.status = 'failed';
    record.failure = String(error?.code || error?.message || 'WEBHOOK_PROCESSING_FAILED').slice(0, 160);
    await record.save();
    throw error;
  }
}

export const razorpayWebhookRoutes = Router();

razorpayWebhookRoutes.post('/', asyncHandler(async (req, res) => {
  if (!isValidRazorpayWebhookSignature(req.rawBody, req.headers['x-razorpay-signature'], env.RAZORPAY_WEBHOOK_SECRET)) {
    return res.sendStatus(401);
  }
  const eventId = String(req.headers['x-razorpay-event-id'] || '').trim();
  if (!eventId || eventId.length > 160) return res.sendStatus(400);
  await recordAndProcess(eventId, req.body);
  return res.sendStatus(200);
}));
