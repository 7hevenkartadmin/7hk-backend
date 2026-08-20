import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Product } from "../src/modules/catalog/product.model.js";
import { Coupon } from "../src/modules/coupons/coupon.model.js";
import { Order } from "../src/modules/orders/order.model.js";
import { Payment } from "../src/modules/payments/payment.model.js";
import { User } from "../src/modules/users/user.model.js";
import { Address } from "../src/modules/addresses/address.model.js";

const objectId = () => new mongoose.Types.ObjectId();

test("product model applies defaults, trims text, and accepts barcode metadata", () => {
  const product = new Product({
    name: "  Fresh Tomato  ",
    slug: "fresh-tomato",
    category: "Vegetables",
    mrp: 40,
    price: 32,
    unit: "500 g",
    sku: "TOM-500",
    barcode: { value: "8901234567890" },
  });

  const error = product.validateSync();

  assert.equal(error, undefined);
  assert.equal(product.name, "Fresh Tomato");
  assert.equal(product.description, "");
  assert.equal(product.stock, 0);
  assert.equal(product.isActive, true);
  assert.equal(product.barcode.format, "EAN-13");
  assert.equal(product.barcode.source, "client");
});

test("product model rejects unsafe pricing, discount, stock, and rating values", () => {
  const product = new Product({
    name: "Broken Product",
    slug: "broken-product",
    category: "Test",
    mrp: -1,
    price: -5,
    discount: 150,
    unit: "1 pc",
    rating: 6,
    stock: -3,
    sku: "BROKEN-1",
  });

  const error = product.validateSync();

  assert.ok(error);
  assert.ok(error.errors.mrp);
  assert.ok(error.errors.price);
  assert.ok(error.errors.discount);
  assert.ok(error.errors.rating);
  assert.ok(error.errors.stock);
});

test("product model projects the default variant onto legacy commerce fields", async () => {
  const product = new Product({
    name: "Variant Product",
    slug: "variant-product",
    category: "snacks",
    mrp: 1,
    price: 1,
    unit: "legacy",
    sku: "LEGACY",
    variants: [
      {
        title: "Small",
        unit: "100 G",
        sku: "VAR-100",
        mrp: 40,
        price: 35,
        stock: 12,
        isDefault: true,
      },
      {
        title: "Large",
        unit: "250 G",
        sku: "VAR-250",
        mrp: 90,
        price: 80,
        stock: 7,
      },
    ],
  });

  await product.validate();
  assert.equal(product.sku, "VAR-100");
  assert.equal(product.unit, "100 G");
  assert.equal(product.price, 35);
  assert.equal(product.stock, 12);
  assert.equal(
    product.variants.filter((variant) => variant.isDefault).length,
    1,
  );
});

test("product model keeps search and operational indexes declared", () => {
  const indexes = Product.schema.indexes().map(([fields]) => fields);

  assert.ok(
    indexes.some(
      (fields) =>
        fields.name === "text" &&
        fields.description === "text" &&
        fields.brand === "text",
    ),
  );
  assert.ok(indexes.some((fields) => fields.slug === 1));
  assert.ok(indexes.some((fields) => fields.stock === 1));
  assert.ok(indexes.some((fields) => fields.isActive === 1));
});

test("user model normalizes email and stores only address references", () => {
  const addressId = objectId();
  const user = new User({
    name: "Customer",
    email: "  CUSTOMER@EXAMPLE.COM ",
    phone: "9999999999",
    passwordHash: "hashed-password",
    addresses: [addressId],
  });

  const error = user.validateSync();

  assert.equal(error, undefined);
  assert.equal(user.email, "customer@example.com");
  assert.equal(user.role, "customer");
  assert.equal(user.status, "active");
  assert.equal(String(user.addresses[0]), String(addressId));
});

test("address model owns delivery details and validates coordinates", () => {
  const address = new Address({
    userId: objectId(), recipientName: "Customer", phone: "9999999999",
    line1: "Main Road", city: "Patna", pincode: "800001",
    latitude: 25.6, longitude: 85.1,
    location: { type: "Point", coordinates: [85.1, 25.6] },
    distanceFromStoreKm: 2.4, deliveryZone: "A", deliveryCharge: 20,
  });
  assert.equal(address.validateSync(), undefined);
  address.latitude = undefined;
  assert.ok(address.validateSync()?.errors.latitude);
});

test("user phone validation is required for customers but does not block staff email login records", () => {
  const invalidCustomer = new User({
    name: "Customer",
    phone: "not-a-phone",
    passwordHash: "hashed-password",
    role: "customer",
  });
  const missingCustomerPhone = new User({
    name: "Customer",
    passwordHash: "hashed-password",
    role: "customer",
  });
  const legacyAdmin = new User({
    name: "Administrator",
    email: "admin@example.com",
    phone: "legacy-admin-value",
    passwordHash: "hashed-password",
    role: "admin",
  });
  const adminWithoutPhone = new User({
    name: "Administrator",
    email: "admin-without-phone@example.com",
    passwordHash: "hashed-password",
    role: "admin",
  });

  assert.ok(invalidCustomer.validateSync()?.errors.phone);
  assert.ok(missingCustomerPhone.validateSync()?.errors.phone);
  assert.equal(legacyAdmin.validateSync(), undefined);
  assert.equal(adminWithoutPhone.validateSync(), undefined);
});

test("user model rejects unsupported roles, statuses, and embedded address objects", () => {
  const user = new User({
    name: "Customer",
    phone: "9999999999",
    passwordHash: "hashed-password",
    role: "owner",
    status: "disabled",
    addresses: [
      {
        recipientName: "Customer",
        phone: "9999999999",
        line1: "Main Road",
        city: "Patna",
        pincode: "800001",
      },
    ],
  });

  const error = user.validateSync();

  assert.ok(error);
  assert.ok(error.errors.role);
  assert.ok(error.errors.status);
  assert.ok(error.errors["addresses.0"]);
});

test("order model accepts a complete grocery order and applies operational defaults", () => {
  const order = new Order({
    orderNumber: "ORD-1001",
    customer: objectId(),
    items: [
      {
        product: objectId(),
        name: "Milk",
        sku: "MILK-1L",
        unit: "1 L",
        quantity: 2,
        price: 62,
        mrp: 65,
        taxRate: 0,
      },
    ],
    subtotal: 124,
    total: 124,
    paymentMethod: "cod",
  });

  const error = order.validateSync();

  assert.equal(error, undefined);
  assert.equal(order.status, "placed");
  assert.equal(order.paymentStatus, "pending");
  assert.equal(order.discount, 0);
  assert.equal(order.deliveryFee, 0);
  assert.equal(order.tax, 0);
});

test("order model rejects invalid statuses, payments, totals, and item quantities", () => {
  const order = new Order({
    orderNumber: "ORD-1002",
    customer: objectId(),
    items: [
      {
        product: objectId(),
        name: "Milk",
        sku: "MILK-1L",
        unit: "1 L",
        quantity: 0,
        price: -1,
        mrp: -1,
      },
    ],
    subtotal: -10,
    total: -10,
    paymentMethod: "cashfree",
    paymentStatus: "unknown",
    status: "lost",
  });

  const error = order.validateSync();

  assert.ok(error);
  assert.ok(error.errors["items.0.quantity"]);
  assert.ok(error.errors["items.0.price"]);
  assert.ok(error.errors["items.0.mrp"]);
  assert.ok(error.errors.subtotal);
  assert.ok(error.errors.total);
  assert.ok(error.errors.paymentMethod);
  assert.ok(error.errors.paymentStatus);
  assert.ok(error.errors.status);
});

test("product model recomputes active variant stock aggregates and default mirrors", async () => {
  const product = new Product({
    name: "Aggregate Product",
    slug: "aggregate-product",
    category: "test",
    mrp: 1,
    price: 1,
    unit: "legacy",
    sku: "AGG-LEGACY",
    variants: [
      { title: "Default", unit: "1 pc", sku: "AGG-1", mrp: 10, price: 9, stock: 12, reservedStock: 4, isDefault: true, isActive: true },
      { title: "Large", unit: "2 pc", sku: "AGG-2", mrp: 20, price: 18, stock: 7, reservedStock: 2, isActive: true },
      { title: "Retired", unit: "3 pc", sku: "AGG-3", mrp: 30, price: 27, stock: 100, reservedStock: 0, isActive: false },
    ],
  });

  await product.validate();

  assert.equal(product.stock, 12);
  assert.equal(product.reservedStock, 4);
  assert.equal(product.totalStock, 19);
  assert.equal(product.availableStock, 13);
});

test("coupon and payment refund ledgers apply safe legacy defaults", () => {
  const coupon = new Coupon({
    code: "SAFE10",
    type: "flat",
    value: 10,
    startsAt: new Date("2026-01-01T00:00:00.000Z"),
    endsAt: new Date("2027-01-01T00:00:00.000Z"),
  });
  const payment = new Payment({
    order: objectId(),
    provider: "razorpay",
    amount: 100,
    refundReason: "ORDER_CANCELLED",
  });

  assert.equal(coupon.validateSync(), undefined);
  assert.equal(coupon.reservedCount, 0);
  assert.equal(payment.validateSync(), undefined);
  assert.equal(payment.amountRefunded, 0);
  assert.deepEqual(payment.processedRefundIds, []);
  assert.equal(payment.refundReason, "ORDER_CANCELLED");
});
