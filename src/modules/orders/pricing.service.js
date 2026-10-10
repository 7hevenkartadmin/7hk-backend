import { defaultFreeDeliveryThreshold } from '../settings/settings.defaults.js';

export function calculateCartTotals({ items, couponDiscount = 0, deliveryFee = 0 }) {
  const subtotal = round(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
  const discount = round(Math.max(0, Math.min(couponDiscount, subtotal)));
  // Allocate product coupon discounts in integer paise.
  const allocate = (amount, weights) => {
    weights = weights.map((weight) => Math.round(weight * 100));
    if (weights.length && !weights.some(Boolean)) weights = weights.map(() => 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    let remaining = Math.round(amount * 100);
    let remainingWeight = sum;
    return weights.map((weight) => {
      const paise = remainingWeight > 0 ? Math.round(remaining * weight / remainingWeight) : 0;
      remaining -= paise;
      remainingWeight -= weight;
      return paise / 100;
    });
  };
  const gross = items.map((item) => round(item.price * item.quantity));
  const discounts = allocate(discount, gross);
  const net = gross.map((value, index) => round(value - discounts[index]));
  const gstLines = items.map((item, index) => {
    const taxRate = Number(item.taxRate || 0);
    const productTax = round(net[index] * taxRate / (100 + taxRate));
    const taxAmount = productTax;
    const cgstAmount = round(taxAmount / 2);
    return { hsnCode: item.hsnCode || '', taxRate, couponDiscount: discounts[index], taxableValue: round(net[index] - productTax), productTax, taxAmount, cgstAmount, sgstAmount: round(taxAmount - cgstAmount) };
  });
  const productTax = round(gstLines.reduce((sum, line) => sum + line.productTax, 0));
  const deliveryTaxRate = Math.max(0, ...items.filter((item) => item.quantity > 0).map((item) => Number(item.taxRate || 0)));
  const deliveryTax = round(deliveryFee * deliveryTaxRate / (100 + deliveryTaxRate));
  const deliveryTaxableValue = round(deliveryFee - deliveryTax);
  const tax = round(productTax + deliveryTax);
  const cgst = round(tax / 2);
  const total = round(Math.max(0, subtotal + deliveryFee - discount));
  return { subtotal, tax, productTax, deliveryTax, deliveryTaxRate, deliveryTaxableValue, cgst, sgst: round(tax - cgst), pricingVersion: 4, gstLines, discount, deliveryFee, total };
}

export function deliveryTaxLines(gstLines = []) {
  const groups = new Map();
  for (const line of gstLines) {
    if (!line.deliveryTaxableValue && !line.deliveryTax) continue;
    const group = groups.get(line.taxRate) || { taxRate: line.taxRate, taxableValue: 0, taxAmount: 0 };
    group.taxableValue = round(group.taxableValue + line.deliveryTaxableValue);
    group.taxAmount = round(group.taxAmount + line.deliveryTax);
    groups.set(line.taxRate, group);
  }
  return [...groups.values()];
}

export function defaultDeliveryFee(subtotal, freeDeliveryThreshold = defaultFreeDeliveryThreshold) {
  return subtotal >= freeDeliveryThreshold ? 0 : 30;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
