import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  canCustomerCancelOrder,
  customerPrepaidCancellationBreakdown,
} from '../src/modules/orders/order.service.js';
import { customerCancelOrderSchema } from '../src/modules/orders/order.validation.js';
import { Order } from '../src/modules/orders/order.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Payment } from '../src/modules/payments/payment.model.js';
import { PaymentIntent } from '../src/modules/payments/paymentIntent.model.js';
import { applyRazorpayRefund, razorpayProcessingFeeSnapshot } from '../src/modules/payments/payment.service.js';
import { SupportTicket } from '../src/modules/support/supportTicket.model.js';
import { createSupportTicketSchema, supportProofUploadSchema } from '../src/modules/support/supportTicket.validation.js';
import { matchesPickupOtp, pickupOtpForTicket } from '../src/modules/support/pickup-otp.service.js';
import { assertCustomerSupportEligibility, createSupportTicket, rejectSupportTicket } from '../src/modules/support/supportTicket.service.js';
import {
  DELIVERED_ORDER_SUPPORT_WINDOW_MS,
  deliveredAtForSupport,
  deliveredOrderSupportPolicy,
} from '../src/modules/support/support-window.js';

async function withStubs(stubs, callback) {
  const originals = stubs.map(({ object, method }) => ({ object, method, value: object[method] }));
  for (const stub of stubs) stub.object[stub.method] = stub.implementation;
  try {
    return await callback();
  } finally {
    for (const original of originals) original.object[original.method] = original.value;
  }
}

test('customer cancellation closes strictly when packing begins', () => {
  assert.equal(canCustomerCancelOrder('placed'), true);
  assert.equal(canCustomerCancelOrder('confirmed'), true);
  for (const status of ['packed', 'out_for_delivery', 'delivered', 'cancelled']) {
    assert.equal(canCustomerCancelOrder(status), false);
  }
  assert.equal(customerCancelOrderSchema.safeParse({ reason: 'Changed my mind' }).success, true);
  assert.equal(customerCancelOrderSchema.safeParse({ reason: 'x' }).success, false);
  assert.equal(customerCancelOrderSchema.safeParse({ reason: 'Valid reason', status: 'cancelled' }).success, false);
});

test('customer prepaid cancellation retains only the exact provider fee in paise', () => {
  assert.deepEqual(customerPrepaidCancellationBreakdown(303, 927), {
    grossPaidPaise: 30300,
    cancellationFeePaise: 927,
    refundAmountPaise: 29373,
    cancellationFeeRate: 3.0594,
    grossPaidAmount: 303,
    cancellationFeeAmount: 9.27,
    refundAmount: 293.73,
  });
  const missing = customerPrepaidCancellationBreakdown(303.01);
  assert.equal(missing.cancellationFeePaise, 0);
  assert.equal(missing.refundAmountPaise, 30301);
  assert.equal(customerPrepaidCancellationBreakdown(10, 999999).cancellationFeePaise, 1000);
});

test('Razorpay processing fee snapshot treats tax as included in the provider fee', () => {
  assert.deepEqual(razorpayProcessingFeeSnapshot({ amount: 10000, fee: 236, tax: 36 }), {
    amountPaise: 236,
    taxPaise: 36,
    source: 'razorpay_payment',
  });
  assert.equal(razorpayProcessingFeeSnapshot({ amount: 10000 }), null);
  assert.equal(razorpayProcessingFeeSnapshot({ amount: 10000, fee: null, tax: null }), null);
});

test('support proof is mandatory for damaged and expired claims only', () => {
  const base = {
    orderId: new mongoose.Types.ObjectId().toString(),
    description: 'The delivered item has a genuine issue.',
    proofImages: [],
  };
  assert.equal(createSupportTicketSchema.safeParse({ ...base, category: 'damaged' }).success, false);
  assert.equal(createSupportTicketSchema.safeParse({ ...base, category: 'expired' }).success, false);
  assert.equal(createSupportTicketSchema.safeParse({ ...base, category: 'missing_item' }).success, true);
  assert.equal(createSupportTicketSchema.safeParse({ ...base, category: 'damaged', proofImages: ['https://cdn.example.com/proof.webp'] }).success, true);
  assert.equal(supportProofUploadSchema.safeParse({ orderId: base.orderId }).success, true);
  assert.equal(supportProofUploadSchema.safeParse({ orderId: base.orderId, customerId: base.orderId }).success, false);
});

test('delivered-order support closes at the exact five-hour boundary and fails closed', () => {
  const deliveredAt = new Date('2026-09-01T04:00:00.000Z');
  const order = { status: 'delivered', deliveredAt, statusTimeline: [] };
  const justBefore = deliveredOrderSupportPolicy(order, new Date(deliveredAt.getTime() + DELIVERED_ORDER_SUPPORT_WINDOW_MS - 1));
  assert.equal(justBefore.eligible, true);
  assert.equal(justBefore.windowHours, 5);
  assert.equal(justBefore.closesAt, '2026-09-01T09:00:00.000Z');

  const atDeadline = deliveredOrderSupportPolicy(order, new Date(deliveredAt.getTime() + DELIVERED_ORDER_SUPPORT_WINDOW_MS));
  assert.equal(atDeadline.eligible, false);
  assert.equal(atDeadline.reasonCode, 'SUPPORT_TICKET_WINDOW_EXPIRED');
  assert.equal(deliveredOrderSupportPolicy({ status: 'delivered', statusTimeline: [] }, deliveredAt).reasonCode, 'SUPPORT_TICKET_DELIVERY_TIME_UNAVAILABLE');
  assert.equal(deliveredOrderSupportPolicy({ status: 'packed', statusTimeline: [] }, deliveredAt).reasonCode, 'SUPPORT_TICKET_DELIVERY_REQUIRED');
});

test('legacy delivery timelines remain eligible without allowing a later timestamp to extend the window', () => {
  const firstDelivery = new Date('2026-09-01T04:00:00.000Z');
  const order = {
    status: 'delivered',
    deliveredAt: new Date('2026-09-01T04:05:00.000Z'),
    statusTimeline: [
      { status: 'out_for_delivery', at: new Date('2026-09-01T03:00:00.000Z') },
      { status: 'delivered', at: firstDelivery },
    ],
  };
  assert.equal(deliveredAtForSupport(order).toISOString(), firstDelivery.toISOString());
  assert.equal(deliveredOrderSupportPolicy(order, new Date('2026-09-01T09:02:00.000Z')).eligible, false);
});

test('support eligibility hides other customers orders and rejects expired owned orders', async () => {
  const customer = { _id: new mongoose.Types.ObjectId() };
  const orderId = new mongoose.Types.ObjectId();
  await withStubs([
    { object: Order, method: 'findOne', implementation: async () => null },
  ], async () => {
    await assert.rejects(
      () => assertCustomerSupportEligibility(customer, orderId),
      (error) => error.code === 'ORDER_NOT_FOUND' && error.statusCode === 404,
    );
  });

  await withStubs([
    { object: Order, method: 'findOne', implementation: async () => ({
      _id: orderId,
      customer: customer._id,
      status: 'delivered',
      deliveredAt: new Date(Date.now() - DELIVERED_ORDER_SUPPORT_WINDOW_MS),
    }) },
  ], async () => {
    await assert.rejects(
      () => assertCustomerSupportEligibility(customer, orderId),
      (error) => error.code === 'SUPPORT_TICKET_WINDOW_EXPIRED' && error.statusCode === 409,
    );
  });
});

test('ticket creation stores the audited delivery window and normalizes duplicate races', async () => {
  const customer = { _id: new mongoose.Types.ObjectId() };
  const orderId = new mongoose.Types.ObjectId();
  const deliveredAt = new Date(Date.now() - 60 * 60 * 1000);
  const payload = {
    orderId: String(orderId),
    category: 'missing_item',
    description: 'One item was missing from the delivered order.',
    proofImages: [],
  };
  let created;
  await withStubs([
    { object: Order, method: 'findOne', implementation: async () => ({ _id: orderId, customer: customer._id, status: 'delivered', deliveredAt }) },
    { object: SupportTicket, method: 'findOne', implementation: async () => null },
    { object: SupportTicket, method: 'create', implementation: async (document) => { created = document; return document; } },
  ], async () => createSupportTicket(customer, payload));
  assert.equal(created.orderDeliveredAt.toISOString(), deliveredAt.toISOString());
  assert.equal(created.submissionDeadline.getTime(), deliveredAt.getTime() + DELIVERED_ORDER_SUPPORT_WINDOW_MS);

  await withStubs([
    { object: Order, method: 'findOne', implementation: async () => ({ _id: orderId, customer: customer._id, status: 'delivered', deliveredAt }) },
    { object: SupportTicket, method: 'findOne', implementation: async () => null },
    { object: SupportTicket, method: 'create', implementation: async () => { const error = new Error('duplicate'); error.code = 11000; error.keyPattern = { activeOrderKey: 1 }; throw error; } },
  ], async () => {
    await assert.rejects(
      () => createSupportTicket(customer, payload),
      (error) => error.code === 'SUPPORT_TICKET_ALREADY_OPEN' && error.statusCode === 409,
    );
  });
});

test('refund, customer-risk and support-ticket persistence fields remain typed', () => {
  const paymentStatuses = Order.schema.path('paymentStatus').enumValues;
  for (const status of ['refund_pending', 'refund_failed', 'partially_refunded', 'refunded', 'cod_refund_approved']) {
    assert.equal(paymentStatuses.includes(status), true);
  }
  assert.ok(Order.schema.path('refund.grossPaidAmount'));
  assert.ok(Order.schema.path('refund.cancellationFeeRate'));
  assert.ok(Order.schema.path('refund.cancellationFeeAmount'));
  assert.ok(Order.schema.path('refund.cancellationFeeSource'));
  assert.ok(Order.schema.path('refund.initiatedBy'));
  assert.ok(Order.schema.path('paymentProcessingFee.amountPaise'));
  assert.ok(PaymentIntent.schema.path('providerFeePaise'));
  assert.ok(Payment.schema.path('providerFeePaise'));
  assert.ok(PaymentIntent.schema.path('refundTargetPaise'));
  assert.equal(User.schema.path('rejectedTicketsCount').defaultValue, 0);
  assert.equal(User.schema.path('isCodDisabled').defaultValue, false);
  assert.ok(SupportTicket.schema.path('providerRefundId'));
  assert.ok(SupportTicket.schema.path('refundArn'));
  assert.ok(SupportTicket.schema.path('orderDeliveredAt'));
  assert.ok(SupportTicket.schema.path('submissionDeadline'));
  assert.ok(Order.schema.path('deliveredAt'));
  assert.equal(SupportTicket.schema.indexes().some(([keys, options]) => keys.activeOrderKey === 1 && options.unique === true), true);
});

test('pickup OTP is deterministic, ticket-bound and rejects malformed guesses', () => {
  const first = new mongoose.Types.ObjectId();
  const second = new mongoose.Types.ObjectId();
  const otp = pickupOtpForTicket(first);
  assert.match(otp, /^\d{6}$/);
  assert.equal(pickupOtpForTicket(first), otp);
  assert.equal(matchesPickupOtp(first, otp), true);
  assert.equal(matchesPickupOtp(second, otp), false);
  assert.equal(matchesPickupOtp(first, '123'), false);
});

test('refund created and failed events update both payment intent and order timeline idempotently', async () => {
  const orderId = new mongoose.Types.ObjectId();
  const intentUpdates = [];
  const orderUpdates = [];
  const payment = { order: orderId, refundReason: 'ORDER_CANCELLED' };
  const intent = { order: orderId, refundReason: 'ORDER_CANCELLED' };
  await withStubs([
    { object: Payment, method: 'findOne', implementation: async () => payment },
    { object: PaymentIntent, method: 'findOne', implementation: async () => intent },
    { object: PaymentIntent, method: 'updateOne', implementation: async (filter, update) => { intentUpdates.push({ filter, update }); } },
    { object: Order, method: 'updateOne', implementation: async (filter, update) => { orderUpdates.push({ filter, update }); } },
  ], async () => {
    await applyRazorpayRefund({ id: 'rf_created', payment_id: 'pay_1', amount: 30300, status: 'created' }, 'refund.created');
    await applyRazorpayRefund({ id: 'rf_failed', payment_id: 'pay_1', amount: 30300, status: 'failed', error_code: 'BAD_REQUEST_ERROR' }, 'refund.failed');
  });
  assert.equal(intentUpdates[0].update.$set.status, 'refund_pending');
  assert.equal(intentUpdates[1].update.$set.status, 'refund_failed');
  assert.equal(orderUpdates.some(({ update }) => update.$set?.paymentStatus === 'refund_pending'), true);
  assert.equal(orderUpdates.some(({ update }) => update.$set?.paymentStatus === 'refund_failed'), true);
  assert.equal(orderUpdates.some(({ filter }) => filter['refundTimeline.eventKey']?.$ne === 'rf_failed:refund_failed'), true);
});

test('third rejected delivered-order claim permanently disables COD for the customer', async () => {
  const customerId = new mongoose.Types.ObjectId();
  const ticket = { _id: new mongoose.Types.ObjectId(), customer: customerId, status: 'rejected' };
  const riskUpdates = [];
  await withStubs([
    { object: SupportTicket, method: 'findOneAndUpdate', implementation: async () => ticket },
    { object: User, method: 'findOneAndUpdate', implementation: async () => ({ _id: customerId, rejectedTicketsCount: 3, isCodDisabled: false }) },
    { object: User, method: 'updateOne', implementation: async (filter, update) => { riskUpdates.push({ filter, update }); } },
  ], async () => {
    await rejectSupportTicket(ticket._id, { note: 'Evidence does not match the delivered item.' }, { _id: new mongoose.Types.ObjectId() });
  });
  assert.equal(riskUpdates.length, 1);
  assert.equal(riskUpdates[0].update.$set.isCodDisabled, true);
  assert.ok(riskUpdates[0].update.$set.codDisabledAt instanceof Date);
});
