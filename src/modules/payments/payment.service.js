import crypto from 'crypto';
import mongoose from 'mongoose';
import Razorpay from 'razorpay';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/utils/AppError.js';
import { maxOrderableQuantity, netAvailableStock } from '../../shared/utils/inventory.js';
import { Product } from '../catalog/product.model.js';
import { claimCoupon, releaseCouponReservation, validateCoupon } from '../coupons/coupon.service.js';
import { DeliverySlot } from '../delivery/deliverySlot.model.js';
import { releaseSlot, reserveSlot } from '../delivery/delivery.service.js';
import { releaseReservedInventory, reserveInventory } from '../inventory/inventory.service.js';
import { calculateCartTotals, defaultDeliveryFee } from '../orders/pricing.service.js';
import { deliveryFeeForDistance } from '../settings/settings.service.js';
import { assertStoreAcceptingOrders } from '../settings/storeAvailability.service.js';
import { PaymentIntent } from './paymentIntent.model.js';
import { Payment } from './payment.model.js';

export const CHECKOUT_TTL_MS = 15 * 60 * 1000;
export const CAPTURED_RESERVATION_GRACE_MS = 30 * 60 * 1000;
export const AUTHORIZED_RESERVATION_MAX_MS = 30 * 60 * 1000;
const AUTHORIZED_RESERVATION_GRACE_MS = 10 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 10000;
const REFUND_RECONCILE_DELAY_MS = 60 * 1000;
const REFUND_FAILURE_RETRY_DELAY_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
let razorpay;

function razorpayClient() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new AppError('Online payments are not configured', 503, 'PAYMENT_CONFIG_MISSING');
  }
  if (!razorpay) razorpay = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  return razorpay;
}

async function withProviderTimeout(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError('Payment provider timed out', 504, 'PAYMENT_PROVIDER_TIMEOUT')), PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRazorpayError(error) {
  if (error instanceof AppError) return error;
  const providerStatus = Number(error?.statusCode || error?.status);
  if (providerStatus === 401) return new AppError('Payment service authentication failed', 502, 'PAYMENT_PROVIDER_AUTH_FAILED');
  if (providerStatus === 400) return new AppError('Payment provider rejected this request', 502, 'PAYMENT_PROVIDER_REQUEST_FAILED');
  return new AppError('Payment service is temporarily unavailable. Please retry with the same request.', 503, 'PAYMENT_PROVIDER_UNAVAILABLE');
}

function providerOrderSnapshot(order) {
  return order ? {
    id: order.id, amount: order.amount, amountPaid: order.amount_paid, amountDue: order.amount_due,
    currency: order.currency, receipt: order.receipt, status: order.status, attempts: order.attempts, createdAt: order.created_at,
  } : undefined;
}

function providerPaymentSnapshot(payment) {
  return payment ? {
    id: payment.id, orderId: payment.order_id, amount: payment.amount, amountCaptured: payment.amount_captured,
    amountRefunded: payment.amount_refunded, currency: payment.currency, status: payment.status,
    captured: payment.captured, method: payment.method, errorCode: payment.error_code,
    errorDescription: payment.error_description, createdAt: payment.created_at,
  } : undefined;
}

function checkoutReceipt(userId, idempotencyKey) {
  const digest = crypto.createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex').slice(0, 30);
  return `7hk_${digest}`;
}

function dedupeKey(userId, cartHash) {
  return crypto.createHash('sha256').update(`${userId}:${cartHash}`).digest('hex');
}

function sameId(left, right) {
  return String(left || '') === String(right || '');
}

function assertIntentMatches(intent, { cartHash, amountPaise, addressId, slotId }) {
  if (intent.cartHash !== cartHash
    || Number(intent.amountPaise) !== amountPaise
    || !sameId(intent.addressId, addressId)
    || !sameId(intent.slotId, slotId)) {
    throw new AppError('Idempotency key was already used for a different checkout', 409, 'IDEMPOTENCY_KEY_REUSED');
  }
}

export function toCheckoutPaymentSession(intent) {
  return {
    sessionId: String(intent._id),
    provider: 'razorpay',
    keyId: env.RAZORPAY_KEY_ID,
    orderId: intent.providerOrderId,
    amount: intent.amount,
    amountPaise: intent.amountPaise,
    currency: intent.currency || 'INR',
    status: intent.status,
    providerStatus: intent.providerStatus,
    expiresAt: intent.reservation?.expiresAt || intent.expiresAt,
    order: intent.order ? String(intent.order) : undefined,
  };
}

export async function createPaymentForOrder(order, session) {
  if (order.paymentMethod === 'cod') {
    const [payment] = await Payment.create([{ order: order._id, provider: 'cod', amount: order.total, status: 'created' }], { session });
    return payment;
  }
  throw new AppError('Online payments must use a verified checkout session', 409, 'PAYMENT_SESSION_REQUIRED');
}

async function hydrateCheckoutItems(inputItems) {
  const ids = inputItems.map((item) => item.productId);
  const products = await Product.find({ _id: { $in: ids }, isActive: true });
  const byId = new Map(products.map((product) => [String(product._id), product]));
  return inputItems.map((item) => {
    const product = byId.get(item.productId);
    if (!product) throw new AppError('Product not found in cart', 404, 'PRODUCT_NOT_FOUND');
    const variant = product.variants?.length
      ? (item.variantId ? product.variants.id(item.variantId) : product.variants.find((entry) => entry.isDefault && entry.isActive))
      : null;
    if (product.variants?.length && (!variant || !variant.isActive)) throw new AppError(`${product.name} variant is unavailable`, 409, 'VARIANT_UNAVAILABLE');
    const target = variant || product;
    const available = netAvailableStock(target.stock, target.reservedStock);
    if (available < item.quantity) {
      throw new AppError(`${product.name} has only ${available} left`, 409, 'INSUFFICIENT_STOCK', {
        maxOrderableQuantity: maxOrderableQuantity(target.stock, target.reservedStock),
      });
    }
    return {
      product, variant, quantity: item.quantity, price: variant?.price ?? product.price,
      mrp: variant?.mrp ?? product.mrp, taxRate: product.taxRate, name: product.name,
      sku: variant?.sku ?? product.sku, unit: variant?.unit ?? product.unit,
      image: variant?.images?.[0] || product.image,
    };
  });
}

export function createCartHash(items, couponCode, total, addressId = '', slotId = '') {
  const normalized = {
    couponCode: String(couponCode || '').trim().toUpperCase(),
    addressId: String(addressId || ''),
    slotId: String(slotId || ''),
    total: Math.round((Number(total) || 0) * 100),
    items: items.map((item) => ({
      productId: String(item.productId || item.product?._id || item.product),
      variantId: item.variantId ? String(item.variantId) : '',
      quantity: Number(item.quantity),
    })).sort((a, b) => `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function validateProviderOrder(order, intent) {
  if (!order?.id || Number(order.amount) !== Number(intent.amountPaise) || order.currency !== intent.currency || order.receipt !== intent.receipt) {
    throw new AppError('Payment provider order did not match the checkout', 409, 'PAYMENT_PROVIDER_MISMATCH');
  }
  return order;
}

async function recoverProviderOrder(client, intent) {
  const result = await withProviderTimeout(client.orders.all({ receipt: intent.receipt, count: 10 }));
  const order = result?.items?.find((item) => item.receipt === intent.receipt
    && Number(item.amount) === Number(intent.amountPaise) && item.currency === intent.currency);
  return order ? validateProviderOrder(order, intent) : null;
}

async function releaseReservationResources(intent, reason, session) {
  await releaseReservedInventory(intent.reservation.items, session);
  await releaseSlot(intent.reservation.slot, session);
  if (intent.reservation.coupon) {
    await releaseCouponReservation(intent.reservation.coupon, session);
  }
  intent.reservation.state = 'released';
  intent.reservation.releasedAt = new Date();
  intent.reservation.releaseReason = reason;
  intent.activeDedupeKey = undefined;
}

async function releaseReservationInSession(intentId, reason, session) {
  const query = PaymentIntent.findOne({
    _id: intentId,
    status: { $in: ['initializing', 'created', 'authorized', 'failed', 'refund_pending', 'refund_failed', 'refunded'] },
    'reservation.state': 'held',
  });
  if (session) query.session(session);
  const intent = await query;
  if (!intent) return null;
  await releaseReservationResources(intent, reason, session);
  await intent.save({ session });
  return intent;
}

export async function releasePaymentIntentReservation(intentId, reason = 'RESERVATION_RELEASED') {
  const session = await mongoose.startSession();
  let released;
  try {
    await session.withTransaction(async () => {
      released = await releaseReservationInSession(intentId, reason, session);
    });
    return released;
  } finally {
    await session.endSession();
  }
}

async function initializeProviderOrder(intent, { recoverFirst = false } = {}) {
  const client = razorpayClient();
  let providerOrder;
  try {
    if (recoverFirst) providerOrder = await recoverProviderOrder(client, intent);
    if (!providerOrder) {
      try {
        providerOrder = await withProviderTimeout(client.orders.create({
          amount: intent.amountPaise,
          currency: intent.currency,
          receipt: intent.receipt,
          partial_payment: false,
          notes: { source: '7heven_checkout', paymentSessionId: String(intent._id), userId: String(intent.user) },
        }));
      } catch (createError) {
        providerOrder = await recoverProviderOrder(client, intent).catch(() => null);
        if (!providerOrder) throw createError;
      }
    }
    validateProviderOrder(providerOrder, intent);
    const updated = await PaymentIntent.findOneAndUpdate(
      { _id: intent._id, status: 'initializing', 'reservation.state': 'held' },
      { $set: { providerOrderId: providerOrder.id, providerStatus: providerOrder.status, status: 'created', raw: providerOrderSnapshot(providerOrder), lastProviderSyncAt: new Date() } },
      { new: true },
    );
    return updated || PaymentIntent.findById(intent._id);
  } catch (error) {
    await PaymentIntent.updateOne(
      { _id: intent._id, status: 'initializing' },
      { $set: { status: 'failed', failureCode: error.code || 'PAYMENT_PROVIDER_UNAVAILABLE' } },
    );
    await releasePaymentIntentReservation(intent._id, 'PROVIDER_INITIALIZATION_FAILED').catch(() => null);
    throw normalizeRazorpayError(error);
  }
}

async function reusableIntent(intent, expected) {
  assertIntentMatches(intent, expected);
  if (['processing', 'consumed'].includes(intent.status)) return intent;
  if (intent.reservation?.state !== 'held') {
    throw new AppError('This payment session no longer holds inventory. Start again with a new idempotency key.', 409, 'PAYMENT_RESERVATION_RELEASED');
  }
  if (intent.status === 'initializing') {
    const stale = Date.now() - new Date(intent.createdAt).getTime() > 5000;
    if (!stale) throw new AppError('Payment session is being prepared. Retry with the same idempotency key.', 409, 'PAYMENT_SESSION_PROCESSING');
    return initializeProviderOrder(intent, { recoverFirst: true });
  }
  if (intent.status === 'failed') throw new AppError('This payment session failed. Start again with a new idempotency key.', 409, 'PAYMENT_SESSION_FAILED');
  if (['refund_pending', 'refunded', 'refund_failed'].includes(intent.status)) {
    throw new AppError('This payment is in the refund process. Start a new checkout only after confirming its status.', 409, 'PAYMENT_REFUND_IN_PROGRESS');
  }
  if (new Date(intent.reservation.expiresAt) <= new Date() && !['verified', 'processing', 'consumed'].includes(intent.status)) {
    const reconciled = await reconcileIntentFromProvider(intent);
    if (['authorized', 'verified', 'processing', 'consumed'].includes(reconciled.status)) return reconciled;
    await releasePaymentIntentReservation(intent._id, 'CHECKOUT_EXPIRED');
    throw new AppError('Payment session expired. Start again with a new idempotency key.', 409, 'PAYMENT_SESSION_EXPIRED');
  }
  return intent;
}

export function shouldInitializeProvider(createdIntent, intent) {
  return createdIntent === true && intent?.status === 'initializing';
}

export async function createRazorpayCheckoutSession(payload, customer, idempotencyKey) {
  const requestCartHash = createCartHash(payload.items, payload.couponCode, 0, payload.addressId, payload.slotId);
  const activeDedupeKey = dedupeKey(customer._id, requestCartHash);
  let existing = await PaymentIntent.findOne({ user: customer._id, idempotencyKey });
  if (!existing) existing = await PaymentIntent.findOne({ activeDedupeKey });
  if (existing) {
    const existingTotal = existing.checkoutSnapshot?.totals?.total;
    const expected = {
      cartHash: createCartHash(payload.items, payload.couponCode, existingTotal, payload.addressId, payload.slotId),
      amountPaise: Number(existing.amountPaise),
      addressId: payload.addressId,
      slotId: payload.slotId,
    };
    return toCheckoutPaymentSession(await reusableIntent(existing, expected));
  }

  const items = await hydrateCheckoutItems(payload.items);
  const subtotalOnly = calculateCartTotals({ items }).subtotal;
  const { coupon, discount } = await validateCoupon(payload.couponCode, subtotalOnly);
  const address = customer.addresses.id(payload.addressId);
  if (!address) throw new AppError('Delivery address not found', 404, 'ADDRESS_NOT_FOUND');
  await assertStoreAcceptingOrders({ distanceKm: address.distanceFromStoreKm });
  const deliveryFee = subtotalOnly >= 499 ? 0 : await deliveryFeeForDistance(address.distanceFromStoreKm, defaultDeliveryFee(subtotalOnly));
  const totals = calculateCartTotals({ items, couponDiscount: discount, deliveryFee });
  const amountPaise = Math.round(totals.total * 100);
  const cartHash = createCartHash(payload.items, payload.couponCode, totals.total, payload.addressId, payload.slotId);
  const expected = { cartHash, amountPaise, addressId: payload.addressId, slotId: payload.slotId };
  const checkoutSnapshot = {
    items: items.map((item) => ({
      productId: String(item.product._id), variantId: item.variant?._id ? String(item.variant._id) : '',
      quantity: item.quantity, price: item.price, mrp: item.mrp, taxRate: item.taxRate,
      name: item.name, sku: item.sku, unit: item.unit, image: item.image, category: item.product.category,
    })),
    couponCode: String(payload.couponCode || '').trim().toUpperCase(),
    slotId: String(payload.slotId),
    totals,
  };

  const session = await mongoose.startSession();
  let intent;
  let createdIntent = false;
  try {
    await session.withTransaction(async () => {
      createdIntent = false;
      const duplicateQuery = PaymentIntent.findOne({ $or: [{ user: customer._id, idempotencyKey }, { activeDedupeKey }] });
      duplicateQuery.session(session);
      const duplicate = await duplicateQuery;
      if (duplicate) {
        intent = duplicate;
        return;
      }
      const reserved = await reserveInventory(payload.items, session);
      await reserveSlot(payload.slotId, session);
      const claimedCoupon = coupon ? await claimCoupon(coupon._id, subtotalOnly, session) : null;
      const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);
      intent = new PaymentIntent({
        user: customer._id,
        idempotencyKey,
        activeDedupeKey,
        receipt: checkoutReceipt(customer._id, idempotencyKey),
        amount: totals.total,
        amountPaise,
        currency: 'INR',
        cartHash,
        addressId: payload.addressId,
        slotId: payload.slotId,
        checkoutSnapshot,
        reservation: {
          state: 'held',
          items: reserved.items,
          expiresAt,
          slot: payload.slotId,
          coupon: claimedCoupon?._id,
        },
        status: 'initializing',
        expiresAt,
      });
      intent.providerOrderId = `pending_${intent._id}`;
      await intent.save({ session });
      createdIntent = true;
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    intent = await PaymentIntent.findOne({ $or: [{ user: customer._id, idempotencyKey }, { activeDedupeKey }] });
    if (!intent) throw error;
  } finally {
    await session.endSession();
  }
  if (!shouldInitializeProvider(createdIntent, intent)) {
    return toCheckoutPaymentSession(await reusableIntent(intent, expected));
  }
  return toCheckoutPaymentSession(await initializeProviderOrder(intent));
}

function timingSafeHexEqual(expected, received) {
  if (!/^[a-f0-9]{64}$/i.test(String(received || ''))) return false;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function verifyRazorpaySignature(payload, trustedOrderId = payload.razorpay_order_id) {
  if (!env.RAZORPAY_KEY_SECRET) {
    if (env.NODE_ENV === 'production') throw new AppError('Online payments are not configured', 503, 'PAYMENT_CONFIG_MISSING');
    return;
  }
  if (payload.razorpay_order_id !== trustedOrderId) throw new AppError('Payment order does not match the checkout session', 400, 'PAYMENT_ORDER_MISMATCH');
  const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${trustedOrderId}|${payload.razorpay_payment_id}`).digest('hex');
  if (!timingSafeHexEqual(expected, payload.razorpay_signature)) throw new AppError('Payment signature verification failed', 400, 'PAYMENT_SIGNATURE_INVALID');
}

export function validateProviderPayment(payment, intent) {
  if (!payment?.id || payment.order_id !== intent.providerOrderId
    || Number(payment.amount) !== Number(intent.amountPaise) || payment.currency !== intent.currency) {
    throw new AppError('Payment does not match the checkout session', 409, 'PAYMENT_PROVIDER_MISMATCH');
  }
  return payment;
}

function refundReceiptFor(intentId, amountPaise) {
  const digest = crypto.createHash('sha256').update(`${intentId}:${amountPaise}`).digest('hex').slice(0, 28);
  return `rf_${digest}`;
}

async function remainingRefundPaise(intent, orderId, session) {
  if (orderId) {
    const query = Payment.findOne({ order: orderId, provider: 'razorpay' });
    if (session) query.session(session);
    const payment = await query;
    if (!payment) throw new AppError('Captured payment ledger was not found', 409, 'PAYMENT_NOT_FOUND');
    return Math.max(0, Math.round((Number(payment.amount) - Number(payment.amountRefunded || 0)) * 100));
  }
  return Math.max(0, Number(intent.amountPaise) - Number(intent.amountRefundedPaise || 0));
}

async function queueRefundInSession({ intentId, orderId, reasonCode, releaseHeld }, session) {
  const query = PaymentIntent.findOne({
    _id: intentId,
    ...(orderId ? { order: orderId } : {}),
    status: { $in: ['verified', 'consumed', 'refund_pending', 'refund_failed', 'refunded'] },
  });
  if (session) query.session(session);
  const intent = await query;
  if (!intent) return null;

  const amountPaise = await remainingRefundPaise(intent, orderId, session);
  if (orderId) {
    await Payment.updateOne(
      { order: orderId, provider: 'razorpay' },
      { $set: { refundReason: reasonCode } },
      { session },
    );
  }
  const activeProviderRefund = Boolean(intent.refundId && !['processed', 'failed'].includes(intent.refundStatus));
  intent.refundReason = reasonCode;
  intent.failureCode = undefined;

  if (amountPaise === 0) {
    intent.status = 'refunded';
    intent.providerStatus = 'refunded';
    intent.refundAmountPaise = 0;
    intent.nextRefundAttemptAt = undefined;
    if (orderId) {
      const { Order } = await import('../orders/order.model.js');
      await Order.updateOne(
        { _id: orderId, paymentStatus: { $ne: 'refunded' } },
        { $set: { paymentStatus: 'refunded' } },
        { session },
      );
    }
  } else {
    intent.status = 'refund_pending';
    if (!activeProviderRefund) {
      intent.refundId = undefined;
      intent.refundStatus = undefined;
      intent.refundRequestedAt = undefined;
      intent.nextRefundAttemptAt = undefined;
      intent.refundAmountPaise = amountPaise;
      intent.refundReceipt = refundReceiptFor(intent._id, amountPaise);
    }
  }

  if (releaseHeld && intent.reservation?.state === 'held') {
    await releaseReservationResources(intent, reasonCode, session);
  }
  await intent.save({ session });
  return intent;
}

async function queuePaymentIntentRefund(intentId, reasonCode, { orderId, releaseHeld = false, session } = {}) {
  if (session) return queueRefundInSession({ intentId, orderId, reasonCode, releaseHeld }, session);
  const ownSession = await mongoose.startSession();
  let queued;
  try {
    await ownSession.withTransaction(async () => {
      queued = await queueRefundInSession({ intentId, orderId, reasonCode, releaseHeld }, ownSession);
    });
    return queued;
  } finally {
    await ownSession.endSession();
  }
}

export async function queueOrderRefund(order, reasonCode = 'ORDER_CANCELLED', session) {
  if (order.paymentMethod !== 'razorpay' || order.paymentStatus === 'refunded') return null;
  const queued = await queuePaymentIntentRefund(order.paymentIntent, reasonCode, {
    orderId: order._id,
    releaseHeld: false,
    session,
  });
  if (queued?.status === 'refunded') order.paymentStatus = 'refunded';
  return queued;
}

async function fetchRefunds(paymentId) {
  return withProviderTimeout(razorpayClient().payments.fetchMultipleRefund(paymentId, { count: 100 }));
}

function matchingProviderRefund(collection, intent) {
  const refunds = collection?.items || [];
  if (intent.refundId) {
    const byId = refunds.find((item) => item.id === intent.refundId);
    if (byId) return byId;
  }
  return refunds.find((item) => item.receipt === intent.refundReceipt && item.status !== 'failed') || null;
}

async function refundIntentPayment(intent, reasonCode = intent.refundReason || 'ORDER_REFUND') {
  if (!intent || intent.status === 'refunded' || Number(intent.refundAmountPaise) === 0) return intent;
  const paymentId = intent.verifiedPaymentId || intent.providerPaymentId;
  if (!paymentId) throw new AppError('Captured payment reference is missing', 409, 'PAYMENT_REFERENCE_MISSING');

  if (intent.refundId) {
    const known = matchingProviderRefund(await fetchRefunds(paymentId), intent);
    if (known?.status === 'processed') {
      await applyRazorpayRefund(known);
      return PaymentIntent.findById(intent._id);
    }
    if (known && known.status !== 'failed') {
      return PaymentIntent.findByIdAndUpdate(intent._id, {
        $set: {
          status: 'refund_pending',
          refundStatus: known.status,
          providerStatus: 'refund_pending',
          nextRefundAttemptAt: new Date(Date.now() + REFUND_RECONCILE_DELAY_MS),
        },
      }, { new: true });
    }
    await PaymentIntent.updateOne(
      { _id: intent._id, refundId: intent.refundId },
      { $set: { status: 'refund_failed', refundStatus: known?.status || 'unconfirmed' }, $unset: { refundId: 1, refundRequestedAt: 1 } },
    );
    intent = await PaymentIntent.findById(intent._id);
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - 30_000);
  const claimed = await PaymentIntent.findOneAndUpdate(
    {
      _id: intent._id,
      'reservation.state': { $in: ['released', 'consumed'] },
      $or: [
        { status: 'refund_failed' },
        { status: 'refund_pending', refundRequestedAt: { $exists: false } },
        { status: 'refund_pending', refundRequestedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: {
        status: 'refund_pending',
        refundRequestedAt: now,
        refundReason: reasonCode,
        nextRefundAttemptAt: new Date(now.getTime() + REFUND_RECONCILE_DELAY_MS),
      },
      $unset: { failureCode: 1 },
      $inc: { refundAttemptCount: 1 },
    },
    { new: true },
  );
  if (!claimed) return PaymentIntent.findById(intent._id);

  const receipt = claimed.refundReceipt || refundReceiptFor(claimed._id, claimed.refundAmountPaise);
  let refund;
  try {
    refund = matchingProviderRefund(await fetchRefunds(paymentId), { ...claimed.toObject?.(), refundReceipt: receipt }) || null;
  } catch {
    refund = null;
  }
  try {
    if (!refund) {
      refund = await withProviderTimeout(razorpayClient().payments.refund(paymentId, {
        amount: claimed.refundAmountPaise,
        speed: 'normal',
        receipt,
        notes: { reason: String(reasonCode).slice(0, 120) },
      }));
    }
  } catch {
    try {
      refund = matchingProviderRefund(await fetchRefunds(paymentId), { ...claimed.toObject?.(), refundReceipt: receipt });
    } catch {
      refund = null;
    }
    if (!refund) {
      await PaymentIntent.updateOne(
        { _id: claimed._id, status: 'refund_pending' },
        {
          $set: {
            status: 'refund_failed',
            refundStatus: 'requires_review',
            failureCode: 'AUTOMATIC_REFUND_UNCONFIRMED',
            nextRefundAttemptAt: new Date(Date.now() + REFUND_FAILURE_RETRY_DELAY_MS),
          },
        },
      );
      throw new AppError('Payment was captured but automatic refund could not be confirmed. Support review is required.', 503, 'PAYMENT_REFUND_REQUIRES_REVIEW');
    }
  }

  await PaymentIntent.updateOne(
    { _id: claimed._id },
    {
      $set: {
        status: refund.status === 'failed' ? 'refund_failed' : 'refund_pending',
        providerStatus: refund.status === 'failed' ? 'refund_failed' : 'refund_pending',
        refundId: refund.id,
        refundStatus: refund.status,
        refundReceipt: receipt,
        refundReason: reasonCode,
        nextRefundAttemptAt: new Date(Date.now() + (refund.status === 'failed'
          ? REFUND_FAILURE_RETRY_DELAY_MS
          : REFUND_RECONCILE_DELAY_MS)),
      },
      $unset: { activeDedupeKey: 1 },
    },
  );
  if (refund.status === 'processed') await applyRazorpayRefund(refund);
  return PaymentIntent.findById(claimed._id);
}

async function refundReleasedCapture(intent, payment) {
  if (['refund_pending', 'refund_failed'].includes(intent.status)) {
    return refundIntentPayment(intent, intent.refundReason || 'RESERVATION_EXPIRED');
  }
  const refundable = await PaymentIntent.findOneAndUpdate(
    {
      _id: intent._id,
      'reservation.state': 'released',
      status: { $in: ['initializing', 'created', 'authorized', 'verified', 'failed'] },
    },
    { $set: {
      providerPaymentId: payment.id,
      verifiedPaymentId: payment.id,
      providerStatus: payment.status,
      raw: providerPaymentSnapshot(payment),
      status: 'refund_pending',
      refundReason: 'RESERVATION_EXPIRED',
      refundAmountPaise: intent.amountPaise,
      refundReceipt: refundReceiptFor(intent._id, intent.amountPaise),
    } },
    { new: true },
  );
  return refundable ? refundIntentPayment(refundable, 'RESERVATION_EXPIRED') : PaymentIntent.findById(intent._id);
}

async function markIntentFromPayment(intent, payment, signature) {
  validateProviderPayment(payment, intent);
  const captured = payment.status === 'captured' && payment.captured !== false;
  if (captured && intent.reservation?.state === 'released') {
    return refundReleasedCapture(intent, payment);
  }
  const status = captured ? 'verified' : payment.status === 'authorized' ? 'authorized' : intent.status;
  const capturedExpiry = new Date(Date.now() + CAPTURED_RESERVATION_GRACE_MS);
  const update = {
    providerPaymentId: payment.id,
    providerStatus: payment.status,
    lastProviderSyncAt: new Date(),
    raw: providerPaymentSnapshot(payment),
    ...(captured ? {
      status: 'verified',
      verifiedPaymentId: payment.id,
      verifiedSignature: signature || intent.verifiedSignature,
      expiresAt: capturedExpiry,
      'reservation.expiresAt': capturedExpiry,
    } : {
      status,
      ...(status === 'authorized' ? { authorizedAt: intent.authorizedAt || new Date() } : {}),
    }),
  };
  const updated = await PaymentIntent.findOneAndUpdate(
    {
      _id: intent._id,
      status: { $nin: ['processing', 'consumed', 'refund_pending', 'refunded', 'refund_failed'] },
      'reservation.state': 'held',
    },
    { $set: update },
    { new: true },
  );
  if (updated) return updated;
  const current = await PaymentIntent.findById(intent._id);
  if (captured && current?.reservation?.state === 'released') return refundReleasedCapture(current, payment);
  return current || intent;
}

async function fetchProviderPayment(paymentId) {
  try {
    return await withProviderTimeout(razorpayClient().payments.fetch(paymentId));
  } catch (error) {
    throw normalizeRazorpayError(error);
  }
}

async function findCustomerIntent(customer, { paymentSessionId, razorpay_order_id: providerOrderId }) {
  const filter = { user: customer._id };
  if (paymentSessionId) filter._id = paymentSessionId;
  else filter.providerOrderId = providerOrderId;
  const intent = await PaymentIntent.findOne(filter);
  if (!intent) throw new AppError('Payment session not found', 404, 'PAYMENT_INTENT_NOT_FOUND');
  return intent;
}

export async function verifyRazorpayPayment(payload, customer) {
  const intent = await findCustomerIntent(customer, payload);
  verifyRazorpaySignature(payload, intent.providerOrderId);
  if (['verified', 'consumed', 'refund_pending', 'refunded', 'refund_failed'].includes(intent.status)) return toCheckoutPaymentSession(intent);
  if (intent.verifiedPaymentId && intent.verifiedPaymentId !== payload.razorpay_payment_id) {
    throw new AppError('A different payment is already linked to this session', 409, 'PAYMENT_ALREADY_LINKED');
  }
  let payment;
  for (const delay of [0, 400, 900, 1600]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    payment = validateProviderPayment(await fetchProviderPayment(payload.razorpay_payment_id), intent);
    if (payment.status === 'captured') break;
    if (!['created', 'authorized'].includes(payment.status)) break;
  }
  return toCheckoutPaymentSession(await markIntentFromPayment(intent, payment, payload.razorpay_signature));
}

async function reconcileIntentFromProvider(intent) {
  if (['verified', 'consumed', 'refund_pending', 'refunded', 'refund_failed'].includes(intent.status)) return intent;
  if (!intent.providerOrderId || intent.providerOrderId.startsWith('pending_')) {
    throw new AppError('Payment session is still initializing', 409, 'PAYMENT_SESSION_PROCESSING');
  }
  let collection;
  try {
    collection = await withProviderTimeout(razorpayClient().orders.fetchPayments(intent.providerOrderId));
  } catch (error) {
    throw normalizeRazorpayError(error);
  }
  const candidates = (collection?.items || []).filter((payment) => payment.order_id === intent.providerOrderId
    && Number(payment.amount) === Number(intent.amountPaise) && payment.currency === intent.currency);
  const payment = candidates.find((item) => item.status === 'captured')
    || candidates.find((item) => item.status === 'authorized') || candidates.at(-1);
  if (!payment) return intent;
  return markIntentFromPayment(intent, payment);
}

export async function reconcileRazorpayPaymentSession(sessionId, customer) {
  const intent = await findCustomerIntent(customer, { paymentSessionId: sessionId });
  return toCheckoutPaymentSession(await reconcileIntentFromProvider(intent));
}

export async function getPaymentSession(sessionId, customer) {
  return toCheckoutPaymentSession(await findCustomerIntent(customer, { paymentSessionId: sessionId }));
}

export async function getVerifiedPaymentIntentForOrder(paymentSessionId, customer, session) {
  const query = PaymentIntent.findOne({
    _id: paymentSessionId,
    user: customer._id,
    status: 'verified',
    'reservation.state': 'held',
  });
  if (session) query.session(session);
  const intent = await query;
  if (!intent) throw new AppError('Payment session is not captured, verified, and reserved', 409, 'PAYMENT_NOT_VERIFIED');
  if (!intent.checkoutSnapshot?.items || !intent.checkoutSnapshot?.totals) {
    throw new AppError('Payment session is missing its checkout snapshot', 409, 'PAYMENT_SNAPSHOT_MISSING');
  }
  return intent;
}

export async function getReservedSlotForIntent(intent, session) {
  const query = DeliverySlot.findById(intent.reservation?.slot);
  if (session) query.session(session);
  const slot = await query;
  if (!slot) throw new AppError('Reserved delivery slot not found', 409, 'SLOT_RESERVATION_MISSING');
  return slot;
}

export async function createCapturedRazorpayPaymentForOrder(order, intent, session) {
  return Payment.findOneAndUpdate(
    { providerPaymentId: intent.verifiedPaymentId || intent.providerPaymentId },
    { $setOnInsert: {
      order: order._id, provider: 'razorpay', providerOrderId: intent.providerOrderId,
      providerPaymentId: intent.verifiedPaymentId || intent.providerPaymentId,
      providerSignature: intent.verifiedSignature, amount: order.total, currency: intent.currency,
      status: 'captured', raw: intent.raw,
    } },
    { upsert: true, new: true, session },
  );
}

export async function consumeRazorpayPaymentIntent({ customer, paymentSessionId, items, couponCode, total, addressId, slotId, session }) {
  const cartHash = createCartHash(items, couponCode, total, addressId, slotId);
  const intent = await PaymentIntent.findOneAndUpdate(
    {
      _id: paymentSessionId,
      user: customer._id,
      cartHash,
      amountPaise: Math.round(Number(total) * 100),
      addressId,
      slotId,
      status: 'verified',
      'reservation.state': 'held',
      'reservation.slot': slotId,
    },
    { $set: { status: 'processing', 'reservation.state': 'consuming' } },
    { new: true, session },
  );
  if (!intent) throw new AppError('Verified payment session does not match this order', 409, 'PAYMENT_INTENT_MISMATCH');
  return intent;
}

export async function completeRazorpayPaymentIntent(intentId, orderId, session) {
  return PaymentIntent.findOneAndUpdate(
    { _id: intentId, status: 'processing', 'reservation.state': 'consuming' },
    {
      $set: { status: 'consumed', order: orderId, 'reservation.state': 'consumed', 'reservation.consumedAt': new Date() },
      $unset: { activeDedupeKey: 1 },
    },
    { new: true, session },
  );
}

export async function applyRazorpayRefund(refund) {
  if (!refund?.id || !refund?.payment_id || !Number.isFinite(Number(refund.amount))) return null;
  if (refund.status !== 'processed') {
    await PaymentIntent.updateOne(
      { $or: [{ providerPaymentId: refund.payment_id }, { verifiedPaymentId: refund.payment_id }], status: { $nin: ['refunded'] } },
      { $set: { status: 'refund_pending', providerStatus: 'refund_pending', refundId: refund.id, refundStatus: refund.status } },
    );
    return null;
  }

  const refundAmount = Number(refund.amount) / 100;
  let payment = await Payment.findOneAndUpdate(
    { providerPaymentId: refund.payment_id, processedRefundIds: { $ne: refund.id } },
    [
      { $set: {
        processedRefundIds: { $setUnion: [{ $ifNull: ['$processedRefundIds', []] }, [refund.id]] },
        amountRefunded: { $min: ['$amount', { $add: [{ $ifNull: ['$amountRefunded', 0] }, refundAmount] }] },
      } },
      { $set: { status: { $cond: [{ $gte: ['$amountRefunded', '$amount'] }, 'refunded', 'partially_refunded'] } } },
    ],
    { new: true },
  );
  if (!payment) payment = await Payment.findOne({ providerPaymentId: refund.payment_id });

  if (!payment) {
    let intent = await PaymentIntent.findOneAndUpdate(
      {
        $or: [{ providerPaymentId: refund.payment_id }, { verifiedPaymentId: refund.payment_id }],
        processedRefundIds: { $ne: refund.id },
      },
      [
        { $set: {
          processedRefundIds: { $setUnion: [{ $ifNull: ['$processedRefundIds', []] }, [refund.id]] },
          amountRefundedPaise: { $min: ['$amountPaise', { $add: [{ $ifNull: ['$amountRefundedPaise', 0] }, Number(refund.amount)] }] },
          refundId: refund.id,
          refundStatus: refund.status,
        } },
      ],
      { new: true },
    );
    if (!intent) {
      intent = await PaymentIntent.findOne({
        $or: [{ providerPaymentId: refund.payment_id }, { verifiedPaymentId: refund.payment_id }],
      });
    }
    if (!intent) return null;

    const fullyRefunded = Number(intent.amountRefundedPaise || 0) >= Number(intent.amountPaise);
    if (fullyRefunded) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const query = PaymentIntent.findById(intent._id);
          query.session(session);
          const current = await query;
          if (!current) return;
          current.status = 'refunded';
          current.providerStatus = 'refunded';
          current.refundId = refund.id;
          current.refundStatus = refund.status;
          current.nextRefundAttemptAt = undefined;
          current.activeDedupeKey = undefined;
          if (current.reservation?.state === 'held') {
            await releaseReservationResources(current, 'MANUAL_REFUND_PROCESSED', session);
          }
          await current.save({ session });
        });
      } finally {
        await session.endSession();
      }
    } else if (intent.reservation?.state === 'held') {
      await queuePaymentIntentRefund(intent._id, 'MANUAL_PARTIAL_REFUND', { releaseHeld: true });
    }
    return PaymentIntent.findById(intent._id);
  }

  const fullyRefunded = payment.status === 'refunded';
  await OrderPaymentStatusUpdate(
    payment.order,
    payment.status,
    fullyRefunded ? ['pending', 'paid', 'partially_refunded'] : ['pending', 'paid'],
  );
  const intent = await PaymentIntent.findOne({
    $or: [{ providerPaymentId: refund.payment_id }, { verifiedPaymentId: refund.payment_id }],
  });
  if (intent) {
    const update = {
      providerStatus: payment.status,
      refundId: refund.id,
      refundStatus: refund.status,
    };
    const unset = {};
    if (fullyRefunded) {
      update.status = 'refunded';
      update.refundAmountPaise = 0;
      unset.activeDedupeKey = 1;
      unset.nextRefundAttemptAt = 1;
    } else if (['refund_pending', 'refund_failed'].includes(intent.status)) {
      const remainingPaise = Math.max(0, Math.round((Number(payment.amount) - Number(payment.amountRefunded || 0)) * 100));
      update.status = 'refund_pending';
      update.refundAmountPaise = remainingPaise;
      update.refundReceipt = refundReceiptFor(intent._id, remainingPaise);
      delete update.refundId;
      delete update.refundStatus;
      unset.refundId = 1;
      unset.refundStatus = 1;
      unset.refundRequestedAt = 1;
      unset.nextRefundAttemptAt = 1;
    }
    await PaymentIntent.updateOne(
      fullyRefunded ? { _id: intent._id } : { _id: intent._id, status: { $ne: 'refunded' } },
      { $set: update, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    );
  }
  return payment;
}

export async function refundUnfulfillablePayment(paymentSessionId, customer, reasonCode) {
  const intent = await PaymentIntent.findOne({
    _id: paymentSessionId,
    user: customer._id,
    status: { $in: ['verified', 'refund_pending', 'refund_failed'] },
  });
  if (!intent) return null;
  const snapshot = intent.checkoutSnapshot;
  const expectedCartHash = snapshot?.totals ? createCartHash(
    snapshot.items || [],
    snapshot.couponCode,
    snapshot.totals.total,
    intent.addressId,
    intent.slotId,
  ) : null;
  if (!snapshot?.totals || expectedCartHash !== intent.cartHash) {
    throw new AppError('Captured checkout snapshot is invalid', 409, 'PAYMENT_INTENT_MISMATCH');
  }
  const queued = await queuePaymentIntentRefund(intent._id, reasonCode || 'ORDER_FINALIZATION_FAILED', { releaseHeld: true });
  if (!queued || queued.reservation?.state !== 'released') return null;
  return refundIntentPayment(queued, reasonCode || 'ORDER_FINALIZATION_FAILED');
}

export async function initiateOrderRefund(order, reasonCode = 'ORDER_CANCELLED') {
  if (order.paymentMethod !== 'razorpay' || order.paymentStatus === 'refunded') return null;
  let intent = await PaymentIntent.findOne({ _id: order.paymentIntent, order: order._id });
  if (!intent) throw new AppError('Payment intent for refund was not found', 409, 'PAYMENT_INTENT_NOT_FOUND');
  if (!['refund_pending', 'refund_failed'].includes(intent.status)) {
    intent = await queueOrderRefund(order, reasonCode);
  }
  if (!intent || intent.status === 'refunded') return intent;
  return refundIntentPayment(intent, reasonCode);
}

async function OrderPaymentStatusUpdate(orderId, paymentStatus, currentStatuses = ['pending', 'paid', 'partially_refunded']) {
  const { Order } = await import('../orders/order.model.js');
  return Order.updateOne(
    { _id: orderId, paymentStatus: { $in: currentStatuses } },
    { $set: { paymentStatus } },
  );
}

export async function applyRazorpayWebhookPayment(payment) {
  if (!payment?.order_id || !payment?.id) return null;
  const intent = await PaymentIntent.findOne({ providerOrderId: payment.order_id });
  if (!intent) return null;
  validateProviderPayment(payment, intent);
  if (['processing', 'consumed', 'refund_pending', 'refunded', 'refund_failed'].includes(intent.status)) return intent;
  if (payment.status === 'captured') return markIntentFromPayment(intent, payment);
  if (payment.status === 'authorized' && intent.status !== 'verified') return markIntentFromPayment(intent, payment);
  if (payment.status === 'failed' && intent.status !== 'verified') {
    return PaymentIntent.findOneAndUpdate(
      { _id: intent._id, status: { $nin: ['verified', 'processing', 'consumed'] } },
      { $set: { providerStatus: 'failed', failureCode: payment.error_code, failureDescription: payment.error_description, lastProviderSyncAt: new Date(), raw: providerPaymentSnapshot(payment) } },
      { new: true },
    );
  }
  return intent;
}

export function nextAuthorizedReservationExpiry(intent, now = new Date()) {
  const authorizedAt = new Date(intent.authorizedAt || intent.lastProviderSyncAt || intent.createdAt);
  const deadline = new Date(authorizedAt.getTime() + AUTHORIZED_RESERVATION_MAX_MS);
  if (!Number.isFinite(deadline.getTime()) || now >= deadline) return null;
  return new Date(Math.min(now.getTime() + AUTHORIZED_RESERVATION_GRACE_MS, deadline.getTime()));
}

async function extendAuthorizedReservation(intent, now) {
  const authorizedAt = new Date(intent.authorizedAt || intent.lastProviderSyncAt || intent.createdAt);
  const expiresAt = nextAuthorizedReservationExpiry(intent, now);
  if (!expiresAt) return false;
  await PaymentIntent.updateOne(
    { _id: intent._id, status: 'authorized', 'reservation.state': 'held' },
    { $set: { authorizedAt, expiresAt, 'reservation.expiresAt': expiresAt } },
  );
  return true;
}

export async function sweepExpiredPaymentReservations({ now = new Date(), limit = 50 } = {}) {
  const refundQuota = Math.min(limit, Math.max(1, Math.ceil(limit / 2)));
  const refundJobs = await PaymentIntent.find({
    'reservation.state': { $in: ['released', 'consumed'] },
    status: { $in: ['refund_pending', 'refund_failed'] },
    $or: [
      { nextRefundAttemptAt: { $exists: false } },
      { nextRefundAttemptAt: { $lte: now } },
    ],
  }).sort({ nextRefundAttemptAt: 1, updatedAt: 1 }).limit(refundQuota);
  const remaining = Math.max(0, limit - refundJobs.length);
  const reservationJobs = remaining ? await PaymentIntent.find({
    $or: [
      { 'reservation.state': 'held', 'reservation.expiresAt': { $lte: now } },
      { 'reservation.state': 'held', status: 'refunded' },
    ],
  }).sort({ 'reservation.expiresAt': 1, updatedAt: 1 }).limit(remaining) : [];
  const intents = [...refundJobs, ...reservationJobs];
  const result = { inspected: intents.length, released: 0, extended: 0, refunded: 0, skipped: 0 };

  for (let intent of intents) {
    try {
      if (intent.reservation?.state === 'consuming' || intent.status === 'processing') {
        result.skipped += 1;
        continue;
      }
      if (intent.reservation?.state === 'held' && intent.status === 'refunded') {
        const repaired = await releasePaymentIntentReservation(intent._id, 'REFUNDED_RESERVATION_REPAIR');
        if (repaired) result.released += 1;
        else result.skipped += 1;
        continue;
      }
      if (intent.reservation?.state === 'held' && intent.status === 'authorized') {
        intent = await reconcileIntentFromProvider(intent);
        if (intent.status === 'verified') {
          // Reconciliation just observed capture and assigned a fresh fulfillment grace period.
          result.extended += 1;
          continue;
        }
        if (intent.status === 'authorized' && await extendAuthorizedReservation(intent, now)) {
          result.extended += 1;
          continue;
        }
        if (intent.status === 'authorized') {
          const released = await releasePaymentIntentReservation(intent._id, 'AUTHORIZATION_EXPIRED');
          if (released) result.released += 1;
          else result.skipped += 1;
          continue;
        }
      }
      if (intent.reservation?.state === 'held' && intent.status === 'created') {
        intent = await reconcileIntentFromProvider(intent);
        if (intent.status === 'verified') {
          // A captured payment receives the normal fulfillment grace before refund recovery.
          result.extended += 1;
          continue;
        }
        if (intent.status === 'authorized') {
          if (await extendAuthorizedReservation(intent, now)) {
            result.extended += 1;
            continue;
          }
          const released = await releasePaymentIntentReservation(intent._id, 'AUTHORIZATION_EXPIRED');
          if (released) result.released += 1;
          else result.skipped += 1;
          continue;
        }
      }
      if (intent.reservation?.state === 'held' && intent.status === 'verified') {
        const queued = await queuePaymentIntentRefund(intent._id, 'RESERVATION_EXPIRED', { releaseHeld: true });
        if (!queued) {
          result.skipped += 1;
          continue;
        }
        result.released += 1;
        intent = queued;
      } else if (intent.reservation?.state === 'held' && ['refund_pending', 'refund_failed'].includes(intent.status)) {
        const released = await releasePaymentIntentReservation(intent._id, intent.refundReason || 'REFUND_RESERVATION_RELEASE');
        if (!released) {
          result.skipped += 1;
          continue;
        }
        result.released += 1;
        intent = released;
      } else if (intent.reservation?.state === 'held') {
        const released = await releasePaymentIntentReservation(intent._id, 'CHECKOUT_EXPIRED');
        if (released) result.released += 1;
        else result.skipped += 1;
        continue;
      }

      if (['refund_pending', 'refund_failed'].includes(intent.status)
        && ['released', 'consumed'].includes(intent.reservation?.state)) {
        const refunded = await refundIntentPayment(intent, intent.refundReason || 'ORDER_REFUND');
        if (refunded?.status === 'refunded' || refunded?.refundId) result.refunded += 1;
        else result.skipped += 1;
      }
    } catch {
      // Provider uncertainty must never release created/authorized reservations.
      // Durable refund jobs remain discoverable after a release or provider failure.
      result.skipped += 1;
    }
  }
  return result;
}

export function startExpiredReservationSweep({ intervalMs = SWEEP_INTERVAL_MS } = {}) {
  let running = null;
  const run = () => {
    if (!running) running = sweepExpiredPaymentReservations().catch((error) => {
      console.error('Expired payment reservation sweep failed:', error);
    }).finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return {
    async close() {
      clearInterval(timer);
      await running;
    },
  };
}
