import mongoose from 'mongoose';
import { customAlphabet } from 'nanoid';
import { Product } from '../catalog/product.model.js';
import {
  claimCoupon,
  consumeCouponReservation,
  validateCoupon,
} from '../coupons/coupon.service.js';
import { releaseSlot, reserveSlot } from '../delivery/delivery.service.js';
import {
  completeRazorpayPaymentIntent,
  consumeRazorpayPaymentIntent,
  createCapturedRazorpayPaymentForOrder,
  createPaymentForOrder,
  getReservedSlotForIntent,
  getVerifiedPaymentIntentForOrder,
  initiateOrderRefund,
  queueOrderRefund,
  refundUnfulfillablePayment,
} from '../payments/payment.service.js';
import { sendOrderPlacedNotification, sendOrderStatusNotification } from '../notifications/notification.service.js';
import { AppError } from '../../shared/utils/AppError.js';
import { maxOrderableQuantity, netAvailableStock } from '../../shared/utils/inventory.js';
import { publishInventoryChange } from '../../shared/realtime/inventory.events.js';
import { publishOrderChange } from '../../shared/realtime/order.events.js';
import { Order } from './order.model.js';
import { buildInvoice } from './invoice.service.js';
import { calculateCartTotals, defaultDeliveryFee } from './pricing.service.js';
import { distanceInKm } from '../../shared/utils/distance.js';
import { env } from '../../config/env.js';
import { deliveryFeeForDistance, getCodSettings } from '../settings/settings.service.js';
import { assertStoreAcceptingOrders, getStoreAvailability } from '../settings/storeAvailability.service.js';
import { PaymentIntent } from '../payments/paymentIntent.model.js';
import { deliveryOtpForOrder, matchesDeliveryOtp } from './delivery-otp.service.js';
import { findOwnedAddress } from '../addresses/address.service.js';
import {
  consumeReservedInventory,
  inventoryChanges,
  restoreOrderInventory,
  sellAvailableInventory,
} from '../inventory/inventory.service.js';

const orderId = customAlphabet('123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8);
const allowedTransitions = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function canTransitionOrderStatus(currentStatus, nextStatus) {
  return Boolean(allowedTransitions[currentStatus]?.includes(nextStatus));
}

function enforceDeliveryRadius(address) {
  if (typeof address.latitude !== 'number' || typeof address.longitude !== 'number') {
    throw new AppError('Delivery location is required. Please use map location.', 422, 'LOCATION_REQUIRED');
  }
  const distance = distanceInKm(
    { latitude: env.STORE_LATITUDE, longitude: env.STORE_LONGITUDE },
    { latitude: address.latitude, longitude: address.longitude },
  );
  if (distance > env.DELIVERY_RADIUS_KM) {
    throw new AppError(`Delivery address is ${distance.toFixed(1)} km away. Service is available within ${env.DELIVERY_RADIUS_KM} km.`, 422, 'OUT_OF_DELIVERY_RADIUS', { distanceKm: Number(distance.toFixed(2)), radiusKm: env.DELIVERY_RADIUS_KM });
  }
  address.distanceFromStoreKm = Number(distance.toFixed(2));
  return address;
}

export function deliveryAddressForOrder(paymentMethod, currentAddress, checkoutSnapshot) {
  const source = paymentMethod === 'razorpay' ? checkoutSnapshot?.deliveryAddress : currentAddress;
  if (!source) {
    throw new AppError('Payment session is missing its immutable delivery-address snapshot', 409, 'PAYMENT_SNAPSHOT_MISSING');
  }
  const address = typeof source.toObject === 'function' ? source.toObject() : source;
  return enforceDeliveryRadius({ ...address });
}

function purchasableVariant(product, variantId) {
  if (!product.variants?.length) return null;
  const variant = variantId
    ? product.variants.id(variantId)
    : product.variants.find((item) => item.isDefault && item.isActive);
  if (!variant || !variant.isActive) throw new AppError(`${product.name} variant is unavailable`, 409, 'VARIANT_UNAVAILABLE');
  return variant;
}

async function hydrateItems(inputItems, session, { checkAvailability = true } = {}) {
  const ids = inputItems.map((item) => item.productId);
  const query = Product.find({ _id: { $in: ids }, isActive: true });
  if (session) query.session(session);
  const products = await query;
  const byId = new Map(products.map((product) => [String(product._id), product]));

  return inputItems.map((item) => {
    const product = byId.get(item.productId);
    if (!product) throw new AppError('Product not found in cart', 404, 'PRODUCT_NOT_FOUND');
    const variant = purchasableVariant(product, item.variantId);
    const target = variant || product;
    const available = netAvailableStock(target.stock, target.reservedStock);
    const safeMaximum = maxOrderableQuantity(target.stock, target.reservedStock, { isActive: target.isActive !== false });
    if (checkAvailability && available < item.quantity) {
      throw new AppError(`${product.name} has only ${available} left`, 409, 'INSUFFICIENT_STOCK', {
        maxOrderableQuantity: safeMaximum,
      });
    }
    return {
      product,
      variant,
      quantity: item.quantity,
      maxOrderableQuantity: safeMaximum,
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

function applyCheckoutSnapshot(items, snapshot) {
  if (!snapshot?.items || snapshot.items.length !== items.length) {
    throw new AppError('Cart does not match the captured payment', 409, 'PAYMENT_INTENT_MISMATCH');
  }
  const snapshotByItem = new Map(snapshot.items.map((item) => [
    `${item.productId}:${item.variantId || ''}`,
    item,
  ]));
  return items.map((item) => {
    const key = `${item.product._id}:${item.variant?._id || ''}`;
    const paidItem = snapshotByItem.get(key);
    if (!paidItem || Number(paidItem.quantity) !== Number(item.quantity)) {
      throw new AppError('Cart does not match the captured payment', 409, 'PAYMENT_INTENT_MISMATCH');
    }
    return {
      ...item,
      price: paidItem.price,
      mrp: paidItem.mrp,
      taxRate: paidItem.taxRate,
      name: paidItem.name,
      sku: paidItem.sku,
      unit: paidItem.unit,
      image: paidItem.image,
    };
  });
}

export async function quoteOrder(customer, payload) {
  const items = await hydrateItems(payload.items);
  const subtotalOnly = calculateCartTotals({ items }).subtotal;
  const { coupon, discount } = await validateCoupon(payload.couponCode, subtotalOnly, customer._id);
  const selectedAddress = payload.addressId ? await findOwnedAddress(customer._id, payload.addressId) : null;
  if (payload.addressId && !selectedAddress) throw new AppError('Delivery address not found', 404, 'ADDRESS_NOT_FOUND');
  await assertStoreAcceptingOrders({ distanceKm: selectedAddress?.distanceFromStoreKm });
  const deliveryFee = selectedAddress
    ? (subtotalOnly >= 499 ? 0 : await deliveryFeeForDistance(selectedAddress.distanceFromStoreKm, defaultDeliveryFee(subtotalOnly)))
    : defaultDeliveryFee(subtotalOnly);
  const totals = calculateCartTotals({ items, couponDiscount: discount, deliveryFee });
  return {
    items: items.map(({ product, variant, quantity, maxOrderableQuantity: safeMaximum, price, mrp, taxRate, sku, unit, image }) => ({
      product: product.id,
      variantId: variant?._id,
      name: product.name,
      sku,
      unit,
      image,
      category: product.category,
      quantity,
      maxOrderableQuantity: safeMaximum,
      price,
      mrp,
      taxRate,
    })),
    coupon: coupon ? { code: coupon.code, discount } : null,
    totals,
  };
}

export async function createOrder(customer, payload) {
  if (payload.paymentMethod === 'razorpay' && payload.paymentSessionId) {
    const existingOrder = await Order.findOne({ customer: customer._id, paymentIntent: payload.paymentSessionId });
    if (existingOrder) return { order: existingOrder, payment: null };
  }
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await performCreateOrder(customer, payload, session);
    });
  } catch (error) {
    if (error?.code !== 20 && !String(error?.message || '').includes('Transaction numbers are only allowed')) {
      if (payload.paymentMethod === 'razorpay'
        && ['PRODUCT_NOT_FOUND', 'VARIANT_UNAVAILABLE', 'INVENTORY_RESERVATION_MISMATCH', 'ADDRESS_NOT_FOUND', 'OUT_OF_DELIVERY_RADIUS', 'SLOT_RESERVATION_MISSING', 'COUPON_RESERVATION_MISMATCH', 'PAYMENT_SNAPSHOT_MISSING'].includes(error?.code)) {
        const refund = await refundUnfulfillablePayment(payload.paymentSessionId, customer, error.code);
        if (!refund) {
          throw new AppError('This payment is already being finalized by another request.', 409, 'PAYMENT_FINALIZATION_IN_PROGRESS');
        }
        throw new AppError('The paid order could not be finalized. A full refund has been initiated.', 409, 'PAYMENT_REFUND_INITIATED');
      }
      throw error;
    }
    if (env.NODE_ENV === 'production') {
      throw new AppError('Order database transactions are unavailable', 503, 'ORDER_TRANSACTION_UNAVAILABLE');
    }
    result = await performCreateOrder(customer, payload);
  } finally {
    await session.endSession();
  }
  for (const change of result.inventoryChanges || []) publishInventoryChange(change);
  publishOrderChange({
    action: 'order.created',
    orderId: String(result.order._id),
    orderNumber: result.order.orderNumber,
    customerId: String(result.order.customer),
    status: result.order.status,
    paymentStatus: result.order.paymentStatus,
    total: result.order.total,
  });
  await sendOrderPlacedNotification(result.order);
  return { order: result.order, payment: result.payment };
}

async function performCreateOrder(customer, payload, session) {
  let paymentIntent;
  let items;
  let coupon;
  let couponRedemption;
  let couponCode = payload.couponCode;
  let totals;
  let couponDiscount = 0;
  let subtotalOnly = 0;
  let slot;
  let paymentPreview;
  const orderObjectId = new mongoose.Types.ObjectId();

  if (payload.paymentMethod === 'razorpay') {
    paymentPreview = await getVerifiedPaymentIntentForOrder(payload.paymentSessionId, customer, session);
    items = applyCheckoutSnapshot(await hydrateItems(payload.items, session, { checkAvailability: false }), paymentPreview.checkoutSnapshot);
    totals = paymentPreview.checkoutSnapshot.totals;
    couponCode = paymentPreview.checkoutSnapshot.couponCode || undefined;
    slot = await getReservedSlotForIntent(paymentPreview, session);
  } else {
    items = await hydrateItems(payload.items, session);
    subtotalOnly = calculateCartTotals({ items }).subtotal;
    const validatedCoupon = await validateCoupon(payload.couponCode, subtotalOnly, customer._id, session);
    coupon = validatedCoupon.coupon;
    couponDiscount = validatedCoupon.discount;
  }

  const address = await findOwnedAddress(customer._id, payload.addressId, session);
  if (!address) throw new AppError('Delivery address not found', 404, 'ADDRESS_NOT_FOUND');
  const deliveryAddress = deliveryAddressForOrder(payload.paymentMethod, address, paymentPreview?.checkoutSnapshot);
  if (payload.paymentMethod === 'cod') {
    const deliveryFee = subtotalOnly >= 499 ? 0 : await deliveryFeeForDistance(
      deliveryAddress.distanceFromStoreKm,
      defaultDeliveryFee(subtotalOnly),
    );
    totals = calculateCartTotals({ items, couponDiscount, deliveryFee });
  }
  await assertOrderAvailability(customer, payload, deliveryAddress.distanceFromStoreKm, session);
  if (payload.paymentMethod === 'cod') {
    await validateCodEligibility(customer, payload, totals);
    slot = await reserveSlot(payload.slotId, session);
    if (coupon) {
      const claim = await claimCoupon({
        couponId: coupon._id,
        userId: customer._id,
        subtotal: subtotalOnly,
        session,
        orderId: orderObjectId,
      });
      coupon = claim.coupon;
      couponRedemption = claim.redemption;
    }
  } else {
    paymentIntent = await consumeRazorpayPaymentIntent({
      customer,
      paymentSessionId: payload.paymentSessionId,
      items: payload.items,
      couponCode,
      total: totals.total,
      addressId: payload.addressId,
      slotId: payload.slotId,
      session,
    });
  }

  const [order] = await Order.create([{
    _id: orderObjectId,
    orderNumber: `ORD-${orderId()}`,
    customer: customer._id,
    customerSnapshot: { name: customer.name, phone: customer.phone, email: customer.email },
    items: items.map(({ product, variant, quantity, price, mrp, taxRate, name, sku, unit, image }) => ({
      product: product._id,
      variantId: variant?._id,
      quantity,
      price,
      mrp,
      taxRate,
      name,
      sku,
      unit,
      image,
      category: product.category,
    })),
    address: deliveryAddress,
    slot: { slotId: slot._id, date: slot.date, startsAt: slot.startsAt, endsAt: slot.endsAt },
    couponCode: couponCode || coupon?.code,
    couponRedemption: paymentIntent?.reservation?.couponRedemption || couponRedemption?._id,
    ...totals,
    paymentMethod: payload.paymentMethod,
    paymentStatus: 'pending',
    paymentIntent: paymentIntent?._id,
    statusTimeline: [{ status: 'placed', note: 'Order placed', actor: customer._id }],
  }], { session });

  const mutation = payload.paymentMethod === 'razorpay'
    ? await consumeReservedInventory(paymentIntent.reservation.items, order._id, customer._id, session)
    : await sellAvailableInventory(items, order._id, customer._id, session);
  const couponRedemptionId = paymentIntent?.reservation?.couponRedemption || couponRedemption?._id;
  if (couponRedemptionId) {
    const consumedCoupon = await consumeCouponReservation(couponRedemptionId, order._id, session);
    if (!consumedCoupon) {
      throw new AppError('Coupon reservation could not be consumed', 409, 'COUPON_RESERVATION_MISMATCH');
    }
  }
  const quantityByProduct = new Map();
  for (const item of items) {
    const key = String(item.product._id);
    quantityByProduct.set(key, (quantityByProduct.get(key) || 0) - item.quantity);
  }
  const changes = inventoryChanges(mutation.products, 'stock.decremented', quantityByProduct);

  order.invoice = buildInvoice(order);
  await order.save({ session });
  if (payload.paymentMethod === 'razorpay') {
    await createCapturedRazorpayPaymentForOrder(order, paymentIntent, session);
    order.paymentStatus = 'paid';
    await order.save({ session });
    await completeRazorpayPaymentIntent(paymentIntent._id, order._id, session);
  } else {
    await createPaymentForOrder(order, session);
  }
  return { order, payment: null, inventoryChanges: changes };
}

async function assertOrderAvailability(customer, payload, distanceKm, session) {
  const availability = await getStoreAvailability({ distanceKm });
  if (availability.acceptingOrders) return availability;
  if (payload.paymentMethod === 'razorpay' && payload.paymentSessionId) {
    const query = PaymentIntent.findOne({
      _id: payload.paymentSessionId,
      user: customer._id,
      status: { $in: ['verified', 'processing', 'consumed'] },
    }).select('createdAt');
    if (session) query.session(session);
    const intent = await query;
    if (intent) return { acceptingOrders: true, reasonCode: 'CAPTURED_PAYMENT_GRACE' };
  }
  throw new AppError(availability.message, 409, availability.reasonCode, { availability });
}

async function validateCodEligibility(customer, payload, totals) {
  const settings = await getCodSettings();
  if (!settings.isEnabled) throw new AppError('Cash on delivery is currently unavailable. Please choose online payment.', 422, 'COD_DISABLED');
  if (!payload.codTermsAccepted) throw new AppError('Please accept the cash on delivery terms before placing the order.', 422, 'COD_TERMS_REQUIRED');
  if (settings.maxOrderValue > 0 && totals.total > settings.maxOrderValue) {
    throw new AppError(`Cash on delivery is available up to Rs. ${settings.maxOrderValue}. Please choose online payment.`, 422, 'COD_ORDER_VALUE_LIMIT');
  }
  if (settings.maxPendingOrdersPerCustomer > 0) {
    const pendingCodOrders = await Order.countDocuments({
      customer: customer._id,
      paymentMethod: 'cod',
      status: { $nin: ['delivered', 'cancelled'] },
    });
    if (pendingCodOrders >= settings.maxPendingOrdersPerCustomer) {
      throw new AppError('You already have pending cash on delivery orders. Please complete them before placing another COD order.', 429, 'COD_PENDING_LIMIT');
    }
  }
  if (settings.maxCancelledOrdersInWindow > 0) {
    const since = new Date(Date.now() - settings.cancellationWindowDays * 24 * 60 * 60 * 1000);
    const cancelledCodOrders = await Order.countDocuments({
      customer: customer._id,
      paymentMethod: 'cod',
      status: 'cancelled',
      createdAt: { $gte: since },
    });
    if (cancelledCodOrders >= settings.maxCancelledOrdersInWindow) {
      throw new AppError('Cash on delivery is disabled for this account because of repeated recent COD cancellations.', 403, 'COD_RISK_BLOCKED');
    }
  }
}

function customerOrderPayload(order) {
  const payload = typeof order.toObject === 'function' ? order.toObject() : { ...order };
  if (payload.status === 'out_for_delivery') payload.deliveryOtp = deliveryOtpForOrder(payload._id);
  return payload;
}

export async function listCustomerOrders(customerId) {
  const orders = await Order.find({ customer: customerId }).sort({ createdAt: -1 });
  return orders.map(customerOrderPayload);
}

export async function getOrderForCustomer(orderIdOrNumber, customer) {
  const filter = orderIdOrNumber.startsWith('ORD-') ? { orderNumber: orderIdOrNumber } : { _id: orderIdOrNumber };
  const order = await Order.findOne({ ...filter, customer: customer._id });
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  return customerOrderPayload(order);
}

export async function verifyDeliveryOtp(id, otp, actor) {
  const current = await Order.findById(id).select('_id status paymentMethod');
  if (!current) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (current.status !== 'out_for_delivery') {
    throw new AppError('Delivery OTP can only be verified for an out-for-delivery order', 409, 'DELIVERY_OTP_NOT_READY');
  }
  if (!matchesDeliveryOtp(current._id, otp)) throw new AppError('Invalid delivery OTP', 401, 'DELIVERY_OTP_INVALID');
  const order = await Order.findOneAndUpdate(
    { _id: current._id, status: 'out_for_delivery' },
    {
      $set: { status: 'delivered', ...(current.paymentMethod === 'cod' ? { paymentStatus: 'paid' } : {}) },
      $push: { statusTimeline: { status: 'delivered', note: 'Delivery verified with customer OTP', actor: actor._id, at: new Date() } },
    },
    { new: true, runValidators: true },
  );
  if (!order) throw new AppError('Order delivery was already verified', 409, 'DELIVERY_ALREADY_VERIFIED');
  publishOrderChange({
    action: 'order.status.updated', orderId: String(order._id), orderNumber: order.orderNumber,
    customerId: String(order.customer), status: order.status, paymentStatus: order.paymentStatus, total: order.total,
  });
  await sendOrderStatusNotification(order);
  return order;
}

export async function cancelOrder(id, payload, actor) {
  const session = await mongoose.startSession();
  let order;
  let changes = [];
  let changed = false;
  let refundQueued = false;
  try {
    await session.withTransaction(async () => {
      const query = Order.findById(id);
      query.session(session);
      order = await query;
      if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
      if (order.status === 'cancelled') return;
      if (!canTransitionOrderStatus(order.status, 'cancelled')) {
        throw new AppError(`Invalid order status transition from ${order.status} to cancelled`, 409, 'INVALID_ORDER_TRANSITION');
      }
      if (!order.inventoryRestoredAt) {
        const restored = await restoreOrderInventory(order.items, order._id, actor._id, session);
        changes = inventoryChanges(restored.products, 'stock.restored');
        await releaseSlot(order.slot?.slotId, session);
        // Coupon eligibility is intentionally permanent after order creation.
        // Cancellation/refund restores inventory and the delivery slot only.
        order.inventoryRestoredAt = new Date();
      }
      order.status = 'cancelled';
      order.statusTimeline.push({ status: 'cancelled', note: payload.note || 'Order cancelled', actor: actor._id });
      if (order.paymentMethod === 'razorpay' && ['paid', 'partially_refunded'].includes(order.paymentStatus)) {
        refundQueued = Boolean(await queueOrderRefund(order, 'ORDER_CANCELLED', session));
      }
      await order.save({ session });
      changed = true;
    });
  } finally {
    await session.endSession();
  }

  if (!changed) return { order, changed: false };
  for (const change of changes) publishInventoryChange(change);
  if (refundQueued) {
    try {
      await initiateOrderRefund(order, 'ORDER_CANCELLED');
      order = await Order.findById(order._id);
    } catch (error) {
      console.error('Queued order refund provider attempt failed:', error);
    }
  }
  return { order, changed: true };
}

export async function updateOrderStatus(id, payload, actor) {
  if (payload.status === 'cancelled') {
    const { order: cancelled, changed } = await cancelOrder(id, payload, actor);
    if (!changed) return cancelled;
    publishOrderChange({
      action: 'order.status.updated', orderId: String(cancelled._id), orderNumber: cancelled.orderNumber,
      customerId: String(cancelled.customer), status: cancelled.status, paymentStatus: cancelled.paymentStatus, total: cancelled.total,
    });
    await sendOrderStatusNotification(cancelled);
    return cancelled;
  }

  const order = await Order.findById(id);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (payload.status === 'delivered') throw new AppError('Verify the customer delivery OTP to complete this order', 409, 'DELIVERY_OTP_REQUIRED');
  if (!canTransitionOrderStatus(order.status, payload.status)) {
    throw new AppError(`Invalid order status transition from ${order.status} to ${payload.status}`, 409, 'INVALID_ORDER_TRANSITION');
  }
  order.status = payload.status;
  if (payload.deliveryAgent) order.deliveryAgent = payload.deliveryAgent;
  order.statusTimeline.push({ status: payload.status, note: payload.note || `Order marked ${payload.status}`, actor: actor._id });
  await order.save();
  publishOrderChange({
    action: 'order.status.updated', orderId: String(order._id), orderNumber: order.orderNumber,
    customerId: String(order.customer), status: order.status, paymentStatus: order.paymentStatus, total: order.total,
  });
  await sendOrderStatusNotification(order);
  return order;
}
