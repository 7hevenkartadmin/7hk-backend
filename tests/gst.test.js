import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCartTotals } from '../src/modules/orders/pricing.service.js';
import { invoiceLineItems, invoiceTotals } from '../src/modules/orders/invoice.service.js';
import { productSchema } from '../src/modules/catalog/catalog.validation.js';
import { Product } from '../src/modules/catalog/product.model.js';
import { checkoutTotalsForItems } from '../src/modules/orders/order.service.js';
import { Order } from '../src/modules/orders/order.model.js';

test('mixed GST rates reconcile discounted products, delivery, and invoice snapshots', () => {
  const items = [{ name: 'A', hsnCode: '1006', price: 100, quantity: 1, taxRate: 5 }, { name: 'B', hsnCode: '210690', price: 200, quantity: 1, taxRate: 18 }];
  const totals = calculateCartTotals({ items, couponDiscount: 30, deliveryFee: 30 });
  assert.equal(totals.productTax, 31.75);
  assert.equal(totals.deliveryTaxRate, 18);
  assert.equal(totals.deliveryTax, 4.58);
  assert.equal(totals.total, 300);
  const order = { items, ...totals };
  const lines = invoiceLineItems(order);
  assert.equal(lines[0].hsnCode, '1006');
  assert.equal(Math.round(lines.reduce((sum, line) => sum + line.taxAmount, 0) * 100), Math.round(totals.tax * 100));
  assert.equal(lines.reduce((sum, line) => sum + line.lineTotal, 0), totals.total);
  assert.equal(invoiceTotals(order).grandTotal, totals.total);
  assert.equal(invoiceTotals(order).cgst, totals.cgst);
});

test('a Rs 20 tax-inclusive product remains Rs 20 with GST extracted', () => {
  const items = [{ name: 'Kurkure', price: 20, mrp: 20, quantity: 1, taxRate: 5 }];
  const totals = calculateCartTotals({ items });
  assert.equal(totals.total, 20);
  assert.equal(totals.productTax, 0.95);
  assert.equal(totals.gstLines[0].taxableValue, 19.05);
  assert.equal(invoiceLineItems({ items, ...totals })[0].lineTotal, 20);
});

test('the customer Maggi example charges Rs 89 including highest-cart-rate delivery GST', () => {
  const items = [{ price: 55, mrp: 58, quantity: 1, taxRate: 5 }, { price: 14, mrp: 15, quantity: 1, taxRate: 5 }];
  const totals = calculateCartTotals({ items, deliveryFee: 20 });
  const lines = invoiceLineItems({ items, ...totals });
  assert.equal(totals.total, 89);
  assert.equal(totals.productTax, 3.29);
  assert.equal(totals.deliveryTax, 0.95);
  assert.equal(lines[0].lineTotal, 55);
  assert.equal(lines[1].lineTotal, 14);
  assert.equal(lines[2].lineTotal, 20);
  assert.equal(lines[2].taxRate, 5);
  assert.equal(invoiceTotals({ items, ...totals }).productDiscount, 4);
  assert.equal(totals.cgst, 2.12);
  assert.equal(totals.sgst, 2.12);
  assert.equal(Math.round(lines.reduce((sum, line) => sum + line.cgstAmount, 0) * 100), 212);
  assert.equal(Math.round(lines.reduce((sum, line) => sum + line.sgstAmount, 0) * 100), 212);
});

test('coupon allocation and delivery tax extraction preserve paise for tiny amounts', () => {
  const items = Array.from({ length: 7 }, () => ({ price: 0.03, quantity: 1, taxRate: 5 }));
  const totals = calculateCartTotals({ items, couponDiscount: 0.1, deliveryFee: 0.05 });
  assert.equal(Math.round(totals.gstLines.reduce((sum, line) => sum + line.couponDiscount, 0) * 100), 10);
  assert.equal(Math.round((totals.deliveryTaxableValue + totals.deliveryTax) * 100), 5);
  assert.ok(totals.gstLines.every((line) => line.taxableValue >= 0));
});

test('zero-rated goods carry no delivery GST and free delivery carries none', () => {
  assert.equal(calculateCartTotals({ items: [{ price: 100, quantity: 1, taxRate: 0 }], deliveryFee: 30 }).deliveryTax, 0);
  assert.equal(calculateCartTotals({ items: [{ price: 100, quantity: 1, taxRate: 18 }] }).deliveryTax, 0);
});

test('HSN validation preserves leading zeroes and rejects malformed codes at API and DB boundaries', async () => {
  const field = productSchema.shape.hsnCode;
  assert.equal(field.parse(' 0101 '), '0101');
  for (const code of ['123', '12345', 'ABC123', '123456789']) {
    assert.equal(field.safeParse(code).success, false);
  }
  const product = new Product({ name: 'Rice', category: 'Grains', unit: '1 kg', price: 100, mrp: 120, hsnCode: 'INVALID' });
  await assert.rejects(product.validate(), /HSN/);
});

test('delivery GST is extracted even when the product prices are zero', () => {
  const totals = calculateCartTotals({ items: [{ price: 0, quantity: 1, taxRate: 18 }], deliveryFee: 30 });
  assert.equal(totals.deliveryTax, 4.58);
  assert.equal(totals.total, 30);
});

test('captured payment tax allocations follow product identity when the cart is reordered', () => {
  const items = [{ productId: 'a', price: 100, quantity: 1, taxRate: 5 }, { productId: 'b', price: 200, quantity: 1, taxRate: 18 }];
  const snapshot = { items, totals: calculateCartTotals({ items, couponDiscount: 30, deliveryFee: 30 }) };
  const reordered = [{ product: { _id: 'b' } }, { product: { _id: 'a' } }];
  const totals = checkoutTotalsForItems(reordered, snapshot);
  assert.equal(totals.gstLines[0].taxRate, 18);
  assert.equal(totals.gstLines[1].taxRate, 5);
  assert.equal(totals.total, snapshot.totals.total);
  assert.equal(totals.deliveryTaxRate, snapshot.totals.deliveryTaxRate);
  assert.equal(totals.deliveryTax, snapshot.totals.deliveryTax);
  assert.equal(snapshot.totals.gstLines[0].taxRate, 5);
});

test('mixed 5% and 12% basket taxes all Rs 20 delivery at 12% without increasing prices', () => {
  const items = [{ name: 'Ruskit Gold', price: 38, mrp: 40, quantity: 1, taxRate: 5 }, { name: 'Noodles', price: 55, mrp: 58, quantity: 1, taxRate: 12 }];
  const totals = calculateCartTotals({ items, deliveryFee: 20 });
  const lines = invoiceLineItems({ items, ...totals });
  assert.equal(totals.pricingVersion, 4);
  assert.equal(totals.deliveryTaxRate, 12);
  assert.equal(totals.deliveryTax, 2.14);
  assert.equal(totals.deliveryTaxableValue, 17.86);
  assert.equal(totals.productTax, 7.70);
  assert.equal(totals.tax, 9.84);
  assert.equal(totals.cgst, 4.92);
  assert.equal(totals.sgst, 4.92);
  assert.equal(totals.total, 113);
  assert.equal(lines.filter((line) => line.isDelivery).length, 1);
  assert.equal(lines[2].taxRate, 12);
  assert.equal(lines[2].lineTotal, 20);
  assert.equal(invoiceTotals({ items, ...totals }).taxableValue, 103.16);
  assert.equal(Math.round(lines.reduce((sum, line) => sum + line.lineTotal, 0) * 100), 11300);
  const savedOrder = new Order({ items, ...totals }).toObject();
  assert.equal(savedOrder.deliveryTaxRate, 12);
  assert.equal(savedOrder.deliveryTaxableValue, 17.86);
  assert.equal(invoiceLineItems(savedOrder).at(-1).lineTotal, 20);
});

test('highest-cart delivery rate survives a full coupon and ignores zero-quantity entries', () => {
  const totals = calculateCartTotals({ items: [{ price: 20, quantity: 1, taxRate: 12 }, { price: 100, quantity: 0, taxRate: 18 }], couponDiscount: 20, deliveryFee: 20 });
  assert.equal(totals.deliveryTaxRate, 12);
  assert.equal(totals.productTax, 0);
  assert.equal(totals.deliveryTax, 2.14);
  assert.equal(totals.total, 20);
});

test('historical version 3 invoices retain their recorded delivery allocations and totals', () => {
  const order = {
    pricingVersion: 3, items: [{ price: 38, quantity: 1, taxRate: 5 }, { price: 55, quantity: 1, taxRate: 12 }],
    subtotal: 93, discount: 0, deliveryFee: 20, productTax: 7.70, deliveryTax: 1.66, tax: 9.36, cgst: 4.68, total: 113,
    gstLines: [
      { taxRate: 5, taxableValue: 36.19, productTax: 1.81, deliveryTaxableValue: 7.78, deliveryTax: 0.39, taxAmount: 2.20 },
      { taxRate: 12, taxableValue: 49.11, productTax: 5.89, deliveryTaxableValue: 10.56, deliveryTax: 1.27, taxAmount: 7.16 },
    ],
  };
  const lines = invoiceLineItems(order);
  assert.equal(lines.filter((line) => line.isDelivery).length, 2);
  assert.deepEqual(lines.filter((line) => line.isDelivery).map((line) => line.lineTotal), [8.17, 11.83]);
  assert.equal(invoiceTotals(order).tax, 9.36);
  assert.equal(invoiceTotals(order).grandTotal, 113);
});
