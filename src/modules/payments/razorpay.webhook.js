import crypto from 'crypto';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { Order } from '../orders/order.model.js';
import { Payment } from './payment.model.js';
import { PaymentIntent } from './paymentIntent.model.js';
import { applyRazorpayWebhookPayment } from './payment.service.js';
import { PaymentWebhookEvent } from './paymentWebhookEvent.model.js';

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

async function applyRefund(refund) {
  if (!refund?.payment_id || !Number.isFinite(Number(refund.amount))) return;
  const payment = await Payment.findOne({ providerPaymentId: refund.payment_id });
  if (!payment) {
    await PaymentIntent.updateOne(
      { providerPaymentId: refund.payment_id, status: { $nin: ['consumed'] } },
      { $set: { status: 'refunded', providerStatus: 'refunded', refundId: refund.id, refundStatus: refund.status }, $unset: { activeDedupeKey: 1 } },
    );
    return;
  }
  payment.amountRefunded = Math.min(payment.amount, Number(payment.amountRefunded || 0) + Number(refund.amount) / 100);
  payment.status = payment.amountRefunded >= payment.amount ? 'refunded' : 'partially_refunded';
  await payment.save();
  await Order.updateOne(
    { _id: payment.order, paymentStatus: { $ne: 'refunded' } },
    { $set: { paymentStatus: payment.status } },
  );
  await PaymentIntent.updateOne(
    { providerPaymentId: refund.payment_id },
    { $set: { providerStatus: payment.status, refundId: refund.id, refundStatus: refund.status } },
  );
}

async function processWebhook(payload) {
  const payment = extractRazorpayWebhookPayment(payload);
  if (['payment.authorized', 'payment.captured', 'payment.failed', 'order.paid'].includes(payload.event) && payment) {
    const intent = await applyRazorpayWebhookPayment(payment);
    if (intent && payment.status === 'captured') {
      await Payment.updateOne(
        { providerPaymentId: payment.id },
        { $set: { status: 'captured' } },
      );
      await Order.updateOne(
        { paymentIntent: intent._id, paymentStatus: { $ne: 'paid' } },
        { $set: { paymentStatus: 'paid' } },
      );
    }
    return Boolean(intent);
  }
  if (payload.event === 'refund.processed') {
    await applyRefund(payload?.payload?.refund?.entity);
    return true;
  }
  return false;
}

async function recordAndProcess(eventId, payload) {
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
    record = await PaymentWebhookEvent.findOne({ eventId });
    if (!record || ['processed', 'ignored', 'processing'].includes(record.status)) return;
    record.status = 'processing';
    record.failure = undefined;
    await record.save();
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
