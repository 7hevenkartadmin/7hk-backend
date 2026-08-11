export function calculateCartTotals({ items, couponDiscount = 0, deliveryFee = 0 }) {
  const subtotal = round(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
  const tax = round(items.reduce((sum, item) => sum + item.price * item.quantity * ((item.taxRate || 0) / 100), 0));
  const discount = round(Math.min(couponDiscount, subtotal));
  const total = round(Math.max(0, subtotal + tax + deliveryFee - discount));
  return { subtotal, tax, discount, deliveryFee, total };
}

export function defaultDeliveryFee(subtotal) {
  return subtotal >= 499 ? 0 : 30;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
