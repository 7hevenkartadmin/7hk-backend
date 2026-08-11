import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/utils/AppError.js';
import { Product } from '../catalog/product.model.js';
import { validateCoupon } from '../coupons/coupon.service.js';
import { calculateCartTotals, defaultDeliveryFee } from '../orders/pricing.service.js';
import { PaymentIntent } from './paymentIntent.model.js';
import { Payment } from './payment.model.js';
import { deliveryFeeForDistance } from '../settings/settings.service.js';

function razorpayClient() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    if (env.NODE_ENV === 'production') throw new AppError('Razorpay credentials are not configured', 500, 'PAYMENT_CONFIG_MISSING');
    return null;
  }
  return new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
}

function normalizeRazorpayError(error) {
  const providerStatus = Number(error?.statusCode || error?.status);
  const providerMessage = error?.error?.description || error?.description || error?.message;
  if (providerStatus === 401) {
    return new AppError('Razorpay rejected the configured API credentials. Verify the test key ID and secret, then restart the backend.', 502, 'PAYMENT_PROVIDER_AUTH_FAILED');
  }
  if (providerStatus === 400) {
    return new AppError(providerMessage || 'Razorpay rejected the payment order request', 502, 'PAYMENT_PROVIDER_REQUEST_FAILED');
  }
  return new AppError('Razorpay is temporarily unavailable. Please try again.', 503, 'PAYMENT_PROVIDER_UNAVAILABLE');
}

export async function createPaymentForOrder(order, session) {
  if (order.paymentMethod === 'cod') {
    const [payment] = await Payment.create([{ order: order._id, provider: 'cod', amount: order.total, status: 'created' }], { session });
    return payment;
  }

  const client = razorpayClient();
  let providerOrder = { id: `mock_rzp_${order.orderNumber}` };
  if (client) {
    providerOrder = await client.orders.create({
      amount: Math.round(order.total * 100),
      currency: 'INR',
      receipt: order.orderNumber,
      notes: { orderId: String(order._id) },
    });
  }

  const [payment] = await Payment.create([{
    order: order._id,
    provider: 'razorpay',
    providerOrderId: providerOrder.id,
    amount: order.total,
    status: 'created',
    raw: providerOrder,
  }], { session });
  return payment;
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
      quantity: item.quantity,
      price: variant?.price ?? product.price,
      mrp: variant?.mrp ?? product.mrp,
      taxRate: product.taxRate,
      name: product.name,
      sku: variant?.sku ?? product.sku,
      unit: variant?.unit ?? product.unit,
    };
  });
}

export function createCartHash(items, couponCode, total, addressId = '') {
  const normalized = {
    couponCode: couponCode || '',
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

export async function createRazorpayCheckoutSession(payload, customer) {
  const client = razorpayClient();
  if (!client) throw new AppError('Razorpay credentials are not configured', 500, 'PAYMENT_CONFIG_MISSING');

  const items = await hydrateCheckoutItems(payload.items);
  const subtotalOnly = calculateCartTotals({ items }).subtotal;
  const { discount } = await validateCoupon(payload.couponCode, subtotalOnly);
  const address = customer.addresses.id(payload.addressId);
  if (!address) throw new AppError('Delivery address not found', 404, 'ADDRESS_NOT_FOUND');
  const deliveryFee = subtotalOnly >= 499 ? 0 : await deliveryFeeForDistance(address.distanceFromStoreKm, defaultDeliveryFee(subtotalOnly));
  const totals = calculateCartTotals({ items, couponDiscount: discount, deliveryFee });
  const cartHash = createCartHash(payload.items, payload.couponCode, totals.total, payload.addressId);
  let providerOrder;
  try {
    providerOrder = await client.orders.create({
      amount: Math.round(totals.total * 100),
      currency: 'INR',
      receipt: `cart_${Date.now()}`,
      notes: { source: 'mobile_checkout', userId: String(customer._id) },
    });
  } catch (error) {
    throw normalizeRazorpayError(error);
  }
  await PaymentIntent.create({
    user: customer._id,
    providerOrderId: providerOrder.id,
    amount: totals.total,
    currency: 'INR',
    cartHash,
    raw: providerOrder,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  return {
    provider: 'razorpay',
    keyId: env.RAZORPAY_KEY_ID,
    orderId: providerOrder.id,
    amount: totals.total,
    amountPaise: Math.round(totals.total * 100),
    currency: 'INR',
    totals,
  };
}

export function toCheckoutPaymentSession(payment) {
  if (!payment || payment.provider !== 'razorpay') return null;
  return {
    provider: 'razorpay',
    keyId: env.RAZORPAY_KEY_ID,
    orderId: payment.providerOrderId,
    amount: payment.amount,
    amountPaise: Math.round(payment.amount * 100),
    currency: payment.currency || 'INR',
    status: payment.status,
  };
}

export function verifyRazorpaySignature(payload) {
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET || 'mock-secret')
    .update(`${payload.razorpay_order_id}|${payload.razorpay_payment_id}`)
    .digest('hex');

  if (env.RAZORPAY_KEY_SECRET && expected !== payload.razorpay_signature) {
    throw new AppError('Payment signature verification failed', 400, 'PAYMENT_SIGNATURE_INVALID');
  }
}

export async function createCapturedRazorpayPaymentForOrder(order, payload, session) {
  verifyRazorpaySignature(payload);
  const [payment] = await Payment.create([{
    order: order._id,
    provider: 'razorpay',
    providerOrderId: payload.razorpay_order_id,
    providerPaymentId: payload.razorpay_payment_id,
    providerSignature: payload.razorpay_signature,
    amount: order.total,
    status: 'captured',
    raw: payload,
  }], { session });
  return payment;
}

export async function consumeRazorpayPaymentIntent({ customer, payload, items, couponCode, total, addressId, session }) {
  verifyRazorpaySignature(payload);
  const cartHash = createCartHash(items, couponCode, total, addressId);
  const update = {
    status: 'consumed',
    verifiedPaymentId: payload.razorpay_payment_id,
    verifiedSignature: payload.razorpay_signature,
  };
  const options = session ? { new: true, session } : { new: true };
  const intent = await PaymentIntent.findOneAndUpdate(
    {
      user: customer._id,
      providerOrderId: payload.razorpay_order_id,
      cartHash,
      amount: total,
      status: { $in: ['created', 'verified'] },
    },
    update,
    options,
  );
  if (!intent) throw new AppError('Payment session does not match this order', 409, 'PAYMENT_INTENT_MISMATCH');
  return intent;
}

async function performRazorpayVerification(payload, customer, session) {
  const queryOptions = session ? { new: true, session } : { new: true };
  const payment = await Payment.findOneAndUpdate(
    { providerOrderId: payload.razorpay_order_id },
    {
      providerPaymentId: payload.razorpay_payment_id,
      providerSignature: payload.razorpay_signature,
      status: 'captured',
      raw: payload,
    },
    queryOptions
  ).populate('order');

  if (!payment) {
    const intent = await PaymentIntent.findOneAndUpdate(
      {
        user: customer._id,
        providerOrderId: payload.razorpay_order_id,
        status: 'created',
      },
      {
        status: 'verified',
        verifiedPaymentId: payload.razorpay_payment_id,
        verifiedSignature: payload.razorpay_signature,
      },
      session ? { new: true, session } : { new: true },
    );
    if (!intent) throw new AppError('Payment session not found', 404, 'PAYMENT_INTENT_NOT_FOUND');
    return {
      provider: 'razorpay',
      providerOrderId: payload.razorpay_order_id,
      providerPaymentId: payload.razorpay_payment_id,
      status: 'verified',
    };
  }
  if (customer && String(payment.order.customer) !== String(customer._id)) {
    throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  }

  payment.order.paymentStatus = 'paid';
  await payment.order.save(session ? { session } : undefined);
  return payment;
}

function isStandaloneTransactionError(error) {
  return error?.code === 20 || String(error?.message || '').includes('Transaction numbers are only allowed');
}

export async function verifyRazorpayPayment(payload, customer) {
  verifyRazorpaySignature(payload);

  const session = await Payment.startSession();
  try {
    let payment;
    await session.withTransaction(async () => {
      payment = await performRazorpayVerification(payload, customer, session);
    });
    return payment;
  } catch (error) {
    if (!isStandaloneTransactionError(error)) throw error;
    return performRazorpayVerification(payload, customer);
  } finally {
    session.endSession();
  }
}
