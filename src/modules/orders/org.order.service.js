import mongoose from "mongoose";
import { customAlphabet } from "nanoid";
import { Product } from "../catalog/product.model.js";
import { Coupon } from "../coupons/coupon.model.js";
import { validateCoupon } from "../coupons/coupon.service.js";
import { reserveSlot } from "../delivery/delivery.service.js";
import {
  consumeRazorpayPaymentIntent,
  createCapturedRazorpayPaymentForOrder,
  createPaymentForOrder,
  verifyRazorpaySignature,
} from "../payments/payment.service.js";
import {
  sendOrderPlacedNotification,
  sendOrderStatusNotification,
} from "../notifications/notification.service.js";
import { AppError } from "../../shared/utils/AppError.js";
import { publishInventoryChange } from "../../shared/realtime/inventory.events.js";
import { publishOrderChange } from "../../shared/realtime/order.events.js";
import { Order } from "./order.model.js";
import { buildInvoice } from "./invoice.service.js";
import { calculateCartTotals, defaultDeliveryFee } from "./pricing.service.js";
import { distanceInKm } from "../../shared/utils/distance.js";
import { env } from "../../config/env.js";
import {
  deliveryFeeForDistance,
  getCodSettings,
} from "../settings/settings.service.js";

const orderId = customAlphabet("123456789ABCDEFGHJKLMNPQRSTUVWXYZ", 8);
const allowedTransitions = {
  placed: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered"],
  delivered: [],
  cancelled: [],
};

function enforceDeliveryRadius(address) {
  if (
    typeof address.latitude !== "number" ||
    typeof address.longitude !== "number"
  ) {
    throw new AppError(
      "Delivery location is required. Please use map location.",
      422,
      "LOCATION_REQUIRED",
    );
  }
  const distance = distanceInKm(
    { latitude: env.STORE_LATITUDE, longitude: env.STORE_LONGITUDE },
    { latitude: address.latitude, longitude: address.longitude },
  );
  if (distance > env.DELIVERY_RADIUS_KM) {
    throw new AppError(
      `Delivery address is ${distance.toFixed(1)} km away. Service is available within ${env.DELIVERY_RADIUS_KM} km.`,
      422,
      "OUT_OF_DELIVERY_RADIUS",
      {
        distanceKm: Number(distance.toFixed(2)),
        radiusKm: env.DELIVERY_RADIUS_KM,
      },
    );
  }
  address.distanceFromStoreKm = Number(distance.toFixed(2));
  return address;
}

async function hydrateItems(inputItems, session) {
  const ids = inputItems.map((item) => item.productId);
  const products = await Product.find({
    _id: { $in: ids },
    isActive: true,
  }).session(session);
  const byId = new Map(
    products.map((product) => [String(product._id), product]),
  );

  return inputItems.map((item) => {
    const product = byId.get(item.productId);
    if (!product)
      throw new AppError("Product not found in cart", 404, "PRODUCT_NOT_FOUND");
    if (product.stock < item.quantity)
      throw new AppError(
        `${product.name} has only ${product.stock} left`,
        409,
        "INSUFFICIENT_STOCK",
      );
    return {
      product,
      quantity: item.quantity,
      price: product.price,
      mrp: product.mrp,
      taxRate: product.taxRate,
      name: product.name,
      sku: product.sku,
      unit: product.unit,
    };
  });
}

export async function quoteOrder(payload) {
  const items = await hydrateItems(payload.items);
  const subtotalOnly = calculateCartTotals({ items }).subtotal;
  const { coupon, discount } = await validateCoupon(
    payload.couponCode,
    subtotalOnly,
  );
  const deliveryFee = defaultDeliveryFee(subtotalOnly);
  const totals = calculateCartTotals({
    items,
    couponDiscount: discount,
    deliveryFee,
  });
  return {
    items: items.map(({ product, quantity, price, mrp, taxRate }) => ({
      product: product.id,
      name: product.name,
      sku: product.sku,
      unit: product.unit,
      category: product.category,
      quantity,
      price,
      mrp,
      taxRate,
    })),
    coupon: coupon ? { code: coupon.code, discount } : null,
    totals,
  };
}

export async function createOrder(customer, payload) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await performCreateOrder(customer, payload, session);
    });
  } catch (error) {
    if (
      error?.code !== 20 &&
      !String(error?.message || "").includes(
        "Transaction numbers are only allowed",
      )
    ) {
      throw error;
    }
    result = await performCreateOrder(customer, payload);
  } finally {
    session.endSession();
  }
  for (const change of result.inventoryChanges || [])
    publishInventoryChange(change);
  publishOrderChange({
    action: "order.created",
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
  const inventoryChanges = [];
  if (payload.paymentMethod === "razorpay")
    verifyRazorpaySignature(payload.razorpayPayment);
  const items = await hydrateItems(payload.items, session);
  const subtotalOnly = calculateCartTotals({ items }).subtotal;
  const { coupon, discount } = await validateCoupon(
    payload.couponCode,
    subtotalOnly,
  );
  const address = payload.address || customer.addresses.id(payload.addressId);
  if (!address)
    throw new AppError("Delivery address not found", 404, "ADDRESS_NOT_FOUND");
  const deliveryAddress = enforceDeliveryRadius(
    typeof address.toObject === "function" ? address.toObject() : address,
  );
  const deliveryFee =
    subtotalOnly >= 499
      ? 0
      : await deliveryFeeForDistance(
          deliveryAddress.distanceFromStoreKm,
          defaultDeliveryFee(subtotalOnly),
        );
  const totals = calculateCartTotals({
    items,
    couponDiscount: discount,
    deliveryFee,
  });
  if (payload.paymentMethod === "cod")
    await validateCodEligibility(customer, payload, totals);
  const slot = await reserveSlot(payload.slotId, session);
  if (payload.paymentMethod === "razorpay") {
    await consumeRazorpayPaymentIntent({
      customer,
      payload: payload.razorpayPayment,
      items: payload.items,
      couponCode: payload.couponCode,
      total: totals.total,
      session,
    });
  }

  for (const item of items) {
    const updated = await Product.findOneAndUpdate(
      { _id: item.product._id, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } },
      { session, new: true },
    );
    if (!updated)
      throw new AppError(
        `${item.name} went out of stock`,
        409,
        "INSUFFICIENT_STOCK",
      );
    inventoryChanges.push({
      action: "stock.decremented",
      productId: String(updated._id),
      stock: updated.stock,
      quantityChanged: -item.quantity,
      orderReason: "order.created",
    });
  }

  if (coupon)
    await Coupon.updateOne(
      { _id: coupon._id },
      { $inc: { usedCount: 1 } },
      { session },
    );

  const [order] = await Order.create(
    [
      {
        orderNumber: `ORD-${orderId()}`,
        customer: customer._id,
        customerSnapshot: {
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
        },
        items: items.map(
          ({ product, quantity, price, mrp, taxRate, name, sku, unit }) => ({
            product: product._id,
            quantity,
            price,
            mrp,
            taxRate,
            name,
            sku,
            unit,
            category: product.category,
          }),
        ),
        address: deliveryAddress,
        slot: {
          slotId: slot._id,
          date: slot.date,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
        },
        couponCode: coupon?.code,
        ...totals,
        paymentMethod: payload.paymentMethod,
        paymentStatus: payload.paymentMethod === "cod" ? "pending" : "pending",
        statusTimeline: [
          { status: "placed", note: "Order placed", actor: customer._id },
        ],
      },
    ],
    { session },
  );

  order.invoice = buildInvoice(order);
  await order.save({ session });
  if (payload.paymentMethod === "razorpay") {
    await createCapturedRazorpayPaymentForOrder(
      order,
      payload.razorpayPayment,
      session,
    );
    order.paymentStatus = "paid";
    await order.save({ session });
  } else {
    await createPaymentForOrder(order, session);
  }
  return { order, payment: null, inventoryChanges };
}

async function validateCodEligibility(customer, payload, totals) {
  const settings = await getCodSettings();
  if (!settings.isEnabled) {
    throw new AppError(
      "Cash on delivery is currently unavailable. Please choose online payment.",
      422,
      "COD_DISABLED",
    );
  }
  if (!payload.codTermsAccepted) {
    throw new AppError(
      "Please accept the cash on delivery terms before placing the order.",
      422,
      "COD_TERMS_REQUIRED",
    );
  }
  if (settings.maxOrderValue > 0 && totals.total > settings.maxOrderValue) {
    throw new AppError(
      `Cash on delivery is available up to Rs. ${settings.maxOrderValue}. Please choose online payment.`,
      422,
      "COD_ORDER_VALUE_LIMIT",
    );
  }
  if (settings.maxPendingOrdersPerCustomer > 0) {
    const pendingCodOrders = await Order.countDocuments({
      customer: customer._id,
      paymentMethod: "cod",
      status: { $nin: ["delivered", "cancelled"] },
    });
    if (pendingCodOrders >= settings.maxPendingOrdersPerCustomer) {
      throw new AppError(
        "You already have pending cash on delivery orders. Please complete them before placing another COD order.",
        429,
        "COD_PENDING_LIMIT",
      );
    }
  }
  if (settings.maxCancelledOrdersInWindow > 0) {
    const since = new Date(
      Date.now() - settings.cancellationWindowDays * 24 * 60 * 60 * 1000,
    );
    const cancelledCodOrders = await Order.countDocuments({
      customer: customer._id,
      paymentMethod: "cod",
      status: "cancelled",
      createdAt: { $gte: since },
    });
    if (cancelledCodOrders >= settings.maxCancelledOrdersInWindow) {
      throw new AppError(
        "Cash on delivery is disabled for this account because of repeated recent COD cancellations.",
        403,
        "COD_RISK_BLOCKED",
      );
    }
  }
}

export async function listCustomerOrders(customerId) {
  return Order.find({ customer: customerId }).sort({ createdAt: -1 });
}

export async function getOrderForCustomer(orderIdOrNumber, customer) {
  const filter = orderIdOrNumber.startsWith("ORD-")
    ? { orderNumber: orderIdOrNumber }
    : { _id: orderIdOrNumber };
  const order = await Order.findOne({ ...filter, customer: customer._id });
  if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
  return order;
}

export async function updateOrderStatus(id, payload, actor) {
  const order = await Order.findById(id);
  if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
  if (!allowedTransitions[order.status]?.includes(payload.status)) {
    throw new AppError(
      `Invalid order status transition from ${order.status} to ${payload.status}`,
      409,
      "INVALID_ORDER_TRANSITION",
    );
  }
  order.status = payload.status;
  if (payload.deliveryAgent) order.deliveryAgent = payload.deliveryAgent;
  order.statusTimeline.push({
    status: payload.status,
    note: payload.note || `Order marked ${payload.status}`,
    actor: actor._id,
  });
  if (payload.status === "delivered" && order.paymentMethod === "cod")
    order.paymentStatus = "paid";
  await order.save();
  publishOrderChange({
    action: "order.status.updated",
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    customerId: String(order.customer),
    status: order.status,
    paymentStatus: order.paymentStatus,
    total: order.total,
  });
  await sendOrderStatusNotification(order);
  return order;
}
