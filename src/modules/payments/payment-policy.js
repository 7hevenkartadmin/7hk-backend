import { AppError } from '../../shared/utils/AppError.js';

export const PAYMENT_METHODS = Object.freeze({
  RAZORPAY: 'razorpay',
  CASH_ON_DELIVERY: 'cod',
});

export const PAYMENT_POLICY_REASON_CODES = Object.freeze({
  PAAN_CORNER_COD_ONLY: 'PAAN_CORNER_COD_ONLY',
});

const PAAN_CORNER_IDENTIFIERS = new Set(['paan-corner', 'pan-corner']);

function normalizeCategoryIdentifier(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isPaanCornerItem(item) {
  const product = item?.product || item || {};
  const categoryRef = product.categoryRef && typeof product.categoryRef === 'object'
    ? product.categoryRef
    : {};
  return [
    categoryRef.slug,
    categoryRef.name,
    product.categorySlug,
    product.category,
    item?.categorySlug,
    item?.category,
  ].some((value) => PAAN_CORNER_IDENTIFIERS.has(normalizeCategoryIdentifier(value)));
}

export function paymentPolicyForItems(items = []) {
  const hasPaanCornerItem = items.some(isPaanCornerItem);
  return {
    version: 1,
    allowedPaymentMethods: hasPaanCornerItem
      ? [PAYMENT_METHODS.CASH_ON_DELIVERY]
      : [PAYMENT_METHODS.RAZORPAY, PAYMENT_METHODS.CASH_ON_DELIVERY],
    onlinePaymentAvailable: !hasPaanCornerItem,
    cashOnDeliveryRequired: hasPaanCornerItem,
    reasonCode: hasPaanCornerItem ? PAYMENT_POLICY_REASON_CODES.PAAN_CORNER_COD_ONLY : null,
    message: hasPaanCornerItem
      ? 'Orders containing Paan Corner items are available only with Cash on Delivery.'
      : null,
  };
}

export function assertPaymentMethodAllowed(items, paymentMethod) {
  const policy = paymentPolicyForItems(items);
  if (policy.allowedPaymentMethods.includes(paymentMethod)) return policy;
  throw new AppError(
    policy.message || 'The selected payment method is not available for this order.',
    422,
    'PAYMENT_METHOD_NOT_ALLOWED',
    { paymentPolicy: policy },
  );
}

export function assertOnlinePaymentAllowed(items) {
  return assertPaymentMethodAllowed(items, PAYMENT_METHODS.RAZORPAY);
}
