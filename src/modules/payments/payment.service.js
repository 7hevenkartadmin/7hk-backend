import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/utils/AppError.js';
import { Product } from '../catalog/product.model.js';
import { validateCoupon } from '../coupons/coupon.service.js';
import { calculateCartTotals, defaultDeliveryFee } from '../orders/pricing.service.js';
import { deliveryFeeForDistance } from '../settings/settings.service.js';
import { assertStoreAcceptingOrders } from '../settings/storeAvailability.service.js';
import { PaymentIntent } from './paymentIntent.model.js';
import { Payment } from './payment.model.js';

const CHECKOUT_TTL_MS = 15 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 10000;
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
    id: order.id,
    amount: order.amount,
    amountPaid: order.amount_paid,
    amountDue: order.amount_due,
    currency: order.currency,
    receipt: order.receipt,
    status: order.status,
    attempts: order.attempts,
    createdAt: order.created_at,
  } : undefined;
}

function providerPaymentSnapshot(payment) {
  return payment ? {
    id: payment.id,
    orderId: payment.order_id,
    amount: payment.amount,
    amountCaptured: payment.amount_captured,
    amountRefunded: payment.amount_refunded,
    currency: payment.currency,
    status: payment.status,
    captured: payment.captured,
    method: payment.method,
    errorCode: payment.error_code,
    errorDescription: payment.error_description,
    createdAt: payment.created_at,
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

function assertIntentMatches(intent, { cartHash, amountPaise, addressId }) {
  if (intent.cartHash !== cartHash || Number(intent.amountPaise) !== amountPaise || !sameId(intent.addressId, addressId)) {
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
    expiresAt: intent.expiresAt,
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
      ? (item.variantId ? product.variants.id(item.variantId) : product.variants.find((entry) => entry.isDefault))
      : null;
    if (product.variants?.length && (!variant || !variant.isActive)) throw new AppError(`${product.name} variant is unavailable`, 409, 'VARIANT_UNAVAILABLE');
    const availableStock = variant?.stock ?? product.stock;
    if (availableStock < item.quantity) throw new AppError(`${product.name} has only ${availableStock} left`, 409, 'INSUFFICIENT_STOCK');
    return {
      product,
      variant,
      quantity: item.quantity,
      price: variant?.price ?? product.price,
      mrp: variant?.mrp ?? product.mrp,
      taxRate: product.taxRate,
      name: product.name,
      sku: variant?.sku ?? product.sku,
      unit: variant?.unit ?? product.unit,
      image: variant?.images?.[0] || product.image,
    };
  });
}

export function createCartHash(items, couponCode, total, addressId = '') {
  const normalized = {
    couponCode: String(couponCode || '').trim().toUpperCase(),
    addressId: String(addressId || ''),
    total: Math.round((Number(total) || 0) * 100),
    items: items
      .map((item) => ({
        productId: String(item.productId || item.product?._id || item.product),
        variantId: item.variantId ? String(item.variantId) : '',
        quantity: Number(item.quantity),
      }))
      .sort((a, b) => `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`)),
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
  const order = result?.items?.find((item) => (
    item.receipt === intent.receipt
    && Number(item.amount) === Number(intent.amountPaise)
    && item.currency === intent.currency
  ));
  return order ? validateProviderOrder(order, intent) : null;
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
      { _id: intent._id, status: 'initializing' },
      { $set: { providerOrderId: providerOrder.id, providerStatus: providerOrder.status, status: 'created', raw: providerOrderSnapshot(providerOrder), lastProviderSyncAt: new Date() } },
      { new: true },
    );
    return updated || PaymentIntent.findById(intent._id);
  } catch (error) {
    await PaymentIntent.updateOne(
      { _id: intent._id, status: 'initializing' },
      { $set: { status: 'failed', failureCode: error.code || 'PAYMENT_PROVIDER_UNAVAILABLE' }, $unset: { activeDedupeKey: 1 } },
    );
    throw normalizeRazorpayError(error);
  }
}

async function reusableIntent(intent, expected) {
  assertIntentMatches(intent, expected);
  if (intent.status === 'initializing') {
    const stale = Date.now() - new Date(intent.createdAt).getTime() > 5000;
    if (!stale) throw new AppError('Payment session is being prepared. Retry with the same idempotency key.', 409, 'PAYMENT_SESSION_PROCESSING');
    return initializeProviderOrder(intent, { recoverFirst: true });
  }
  if (intent.status === 'failed') {
    throw new AppError('This payment session failed. Start again with a new idempotency key.', 409, 'PAYMENT_SESSION_FAILED');
  }
  if (['refund_pending', 'refunded', 'refund_failed'].includes(intent.status)) {
    throw new AppError('This payment is in the refund process. Start a new checkout only after confirming its status.', 409, 'PAYMENT_REFUND_IN_PROGRESS');
  }
  if (intent.status === 'created' && new Date(intent.expiresAt) <= new Date()) {
    const reconciled = await reconcileIntentFromProvider(intent);
    if (['authorized', 'verified', 'processing', 'consumed'].includes(reconciled.status)) return reconciled;
    const renewed = await PaymentIntent.findOneAndUpdate(
      { _id: intent._id, status: 'created' },
      { $set: { expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS) }, $unset: { failureCode: 1, failureDescription: 1 } },
      { new: true },
    );
    return renewed || PaymentIntent.findById(intent._id);
  }
  return intent;
}

export async function createRazorpayCheckoutSession(payload, customer, idempotencyKey) {
  const items = await hydrateCheckoutItems(payload.items);
  const subtotalOnly = calculateCartTotals({ items }).subtotal;
  const { discount } = await validateCoupon(payload.couponCode, subtotalOnly);
  const address = customer.addresses.id(payload.addressId);
  if (!address) throw new AppError('Delivery address not found', 404, 'ADDRESS_NOT_FOUND');
  await assertStoreAcceptingOrders({ distanceKm: address.distanceFromStoreKm });
  const deliveryFee = subtotalOnly >= 499 ? 0 : await deliveryFeeForDistance(address.distanceFromStoreKm, defaultDeliveryFee(subtotalOnly));
  const totals = calculateCartTotals({ items, couponDiscount: discount, deliveryFee });
  const amountPaise = Math.round(totals.total * 100);
  const cartHash = createCartHash(payload.items, payload.couponCode, totals.total, payload.addressId);
  const activeDedupeKey = dedupeKey(customer._id, cartHash);
  const expected = { cartHash, amountPaise, addressId: payload.addressId };
  const checkoutSnapshot = {
    items: items.map((item) => ({
      productId: String(item.product._id),
      variantId: item.variant?._id ? String(item.variant._id) : '',
      quantity: item.quantity,
      price: item.price,
      mrp: item.mrp,
      taxRate: item.taxRate,
      name: item.name,
      sku: item.sku,
      unit: item.unit,
      image: item.image,
      category: item.product.category,
    })),
    couponCode: String(payload.couponCode || '').trim().toUpperCase(),
    totals,
  };

  let existing = await PaymentIntent.findOne({ user: customer._id, idempotencyKey });
  if (!existing) existing = await PaymentIntent.findOne({ activeDedupeKey });
  if (existing) return toCheckoutPaymentSession(await reusableIntent(existing, expected));

  let intent;
  try {
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
      checkoutSnapshot,
      status: 'initializing',
      expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
    });
    intent.providerOrderId = 'pending_' + intent._id;
    await intent.save();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    existing = await PaymentIntent.findOne({ $or: [{ user: customer._id, idempotencyKey }, { activeDedupeKey }] });
    if (!existing) throw error;
    return toCheckoutPaymentSession(await reusableIntent(existing, expected));
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
  if (payload.razorpay_order_id !== trustedOrderId) {
    throw new AppError('Payment order does not match the checkout session', 400, 'PAYMENT_ORDER_MISMATCH');
  }
  const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${trustedOrderId}|${payload.razorpay_payment_id}`)
    .digest('hex');
  if (!timingSafeHexEqual(expected, payload.razorpay_signature)) {
    throw new AppError('Payment signature verification failed', 400, 'PAYMENT_SIGNATURE_INVALID');
  }
}

export function validateProviderPayment(payment, intent) {
  if (!payment?.id
    || payment.order_id !== intent.providerOrderId
    || Number(payment.amount) !== Number(intent.amountPaise)
    || payment.currency !== intent.currency) {
    throw new AppError('Payment does not match the checkout session', 409, 'PAYMENT_PROVIDER_MISMATCH');
  }
  return payment;
}

async function markIntentFromPayment(intent, payment, signature) {
  validateProviderPayment(payment, intent);
  const captured = payment.status === 'captured' && payment.captured !== false;
  const status = captured ? 'verified' : payment.status === 'authorized' ? 'authorized' : intent.status;
  const update = {
    providerPaymentId: payment.id,
    providerStatus: payment.status,
    lastProviderSyncAt: new Date(),
    raw: providerPaymentSnapshot(payment),
    ...(captured ? { status: 'verified', verifiedPaymentId: payment.id, verifiedSignature: signature || intent.verifiedSignature } : { status }),
  };
  const updated = await PaymentIntent.findOneAndUpdate(
    { _id: intent._id, status: { $nin: ['processing', 'consumed', 'refund_pending', 'refunded', 'refund_failed'] } },
    { $set: update },
    { new: true },
  );
  return updated || intent;
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
  if (['verified', 'consumed', 'refund_pending', 'refunded', 'refund_failed'].includes(intent.status)) {
    return toCheckoutPaymentSession(intent);
  }
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
  const updated = await markIntentFromPayment(intent, payment, payload.razorpay_signature);
  return toCheckoutPaymentSession(updated);
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
  const candidates = (collection?.items || []).filter((payment) => (
    payment.order_id === intent.providerOrderId
    && Number(payment.amount) === Number(intent.amountPaise)
    && payment.currency === intent.currency
  ));
  const payment = candidates.find((item) => item.status === 'captured')
    || candidates.find((item) => item.status === 'authorized')
    || candidates.at(-1);
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
  });
  if (session) query.session(session);
  const intent = await query;
  if (!intent) throw new AppError('Payment session is not captured and verified', 409, 'PAYMENT_NOT_VERIFIED');
  if (!intent.checkoutSnapshot?.items || !intent.checkoutSnapshot?.totals) {
    throw new AppError('Payment session is missing its checkout snapshot', 409, 'PAYMENT_SNAPSHOT_MISSING');
  }
  return intent;
}

export async function createCapturedRazorpayPaymentForOrder(order, intent, session) {
  return Payment.findOneAndUpdate(
    { providerPaymentId: intent.verifiedPaymentId || intent.providerPaymentId },
    { $setOnInsert: {
      order: order._id,
      provider: 'razorpay',
      providerOrderId: intent.providerOrderId,
      providerPaymentId: intent.verifiedPaymentId || intent.providerPaymentId,
      providerSignature: intent.verifiedSignature,
      amount: order.total,
      currency: intent.currency,
      status: 'captured',
      raw: intent.raw,
    } },
    { upsert: true, new: true, session },
  );
}

export async function consumeRazorpayPaymentIntent({ customer, paymentSessionId, items, couponCode, total, addressId, session }) {
  const cartHash = createCartHash(items, couponCode, total, addressId);
  const intent = await PaymentIntent.findOneAndUpdate(
    {
      _id: paymentSessionId,
      user: customer._id,
      cartHash,
      amountPaise: Math.round(Number(total) * 100),
      addressId,
      status: 'verified',
    },
    { $set: { status: 'processing' } },
    { new: true, session },
  );
  if (!intent) throw new AppError('Verified payment session does not match this order', 409, 'PAYMENT_INTENT_MISMATCH');
  return intent;
}

export async function completeRazorpayPaymentIntent(intentId, orderId, session) {
  return PaymentIntent.findOneAndUpdate(
    { _id: intentId, status: 'processing' },
    { $set: { status: 'consumed', order: orderId }, $unset: { activeDedupeKey: 1 } },
    { new: true, session },
  );
}

export async function refundUnfulfillablePayment(paymentSessionId, customer, reasonCode, checkout) {
  const intent = await PaymentIntent.findOne({
    _id: paymentSessionId,
    user: customer._id,
    status: { $in: ['verified', 'refund_pending', 'refund_failed'] },
  });
  if (!intent) return null;
  const expectedCartHash = createCartHash(
    checkout?.items || [],
    checkout?.couponCode,
    intent.checkoutSnapshot?.totals?.total,
    checkout?.addressId,
  );
  if (!intent.checkoutSnapshot?.totals || expectedCartHash !== intent.cartHash) {
    throw new AppError('Refund request does not match the captured checkout', 409, 'PAYMENT_INTENT_MISMATCH');
  }
  if (intent.status === 'refund_pending' || intent.status === 'refunded') return intent;
  const paymentId = intent.verifiedPaymentId || intent.providerPaymentId;
  const receipt = 'rf_' + intent._id;
  let refund;
  try {
    refund = await withProviderTimeout(razorpayClient().payments.refund(paymentId, {
      amount: intent.amountPaise,
      speed: 'normal',
      receipt,
      notes: { reason: String(reasonCode || 'ORDER_FINALIZATION_FAILED').slice(0, 120) },
    }));
  } catch {
    try {
      const refunds = await withProviderTimeout(razorpayClient().payments.fetchMultipleRefund(paymentId, { count: 100 }));
      refund = refunds?.items?.find((item) => item.receipt === receipt);
    } catch {
      refund = null;
    }
    if (!refund) {
      await PaymentIntent.updateOne(
        { _id: intent._id },
        { $set: { status: 'refund_failed', refundStatus: 'requires_review', failureCode: 'AUTOMATIC_REFUND_UNCONFIRMED' } },
      );
      throw new AppError('Payment was captured but automatic refund could not be confirmed. Support review is required.', 503, 'PAYMENT_REFUND_REQUIRES_REVIEW');
    }
  }
  const completed = refund.status === 'processed';
  return PaymentIntent.findByIdAndUpdate(
    intent._id,
    {
      $set: {
        status: completed ? 'refunded' : 'refund_pending',
        providerStatus: completed ? 'refunded' : 'refund_pending',
        refundId: refund.id,
        refundStatus: refund.status,
        failureCode: reasonCode,
      },
      $unset: { activeDedupeKey: 1 },
    },
    { new: true },
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
