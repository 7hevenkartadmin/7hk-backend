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
import { applyRazorpayRefund } from '../src/modules/payments/payment.service.js';
import { SupportTicket } from '../src/modules/support/supportTicket.model.js';
import { createSupportTicketSchema } from '../src/modules/support/supportTicket.validation.js';
import { matchesPickupOtp, pickupOtpForTicket } from '../src/modules/support/pickup-otp.service.js';
import { rejectSupportTicket } from '../src/modules/support/supportTicket.service.js';

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

test('customer prepaid cancellation retains exactly 10 percent in paise', () => {
  assert.deepEqual(customerPrepaidCancellationBreakdown(303), {
    grossPaidPaise: 30300,
    cancellationFeePaise: 3030,
    refundAmountPaise: 27270,
    grossPaidAmount: 303,
    cancellationFeeAmount: 30.3,
    refundAmount: 272.7,
  });
  const rounded = customerPrepaidCancellationBreakdown(303.01);
  assert.equal(rounded.cancellationFeePaise, 3030);
  assert.equal(rounded.refundAmountPaise, 27271);
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
});

test('refund, customer-risk and support-ticket persistence fields remain typed', () => {
  const paymentStatuses = Order.schema.path('paymentStatus').enumValues;
  for (const status of ['refund_pending', 'refund_failed', 'partially_refunded', 'refunded', 'cod_refund_approved']) {
    assert.equal(paymentStatuses.includes(status), true);
  }
  assert.ok(Order.schema.path('refund.grossPaidAmount'));
  assert.ok(Order.schema.path('refund.cancellationFeeRate'));
  assert.ok(Order.schema.path('refund.cancellationFeeAmount'));
  assert.ok(Order.schema.path('refund.initiatedBy'));
  assert.ok(PaymentIntent.schema.path('refundTargetPaise'));
  assert.equal(User.schema.path('rejectedTicketsCount').defaultValue, 0);
  assert.equal(User.schema.path('isCodDisabled').defaultValue, false);
  assert.ok(SupportTicket.schema.path('providerRefundId'));
  assert.ok(SupportTicket.schema.path('refundArn'));
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
