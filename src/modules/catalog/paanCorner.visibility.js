import { AppError } from '../../shared/utils/AppError.js';
import { isPaanCornerItem } from '../payments/payment-policy.js';
import { Category } from './category.model.js';

export const PAAN_CORNER_CATEGORY_PATTERN = /^(?:paan|pan)[\s_-]*corner$/i;
export const PAAN_CORNER_REFERENCE_PATTERN = /(?:^|[\s/_-])(?:paan(?:[\s/_-]*corner)?|pan[\s/_-]*corner)(?:$|[\s/_-]|\d)/i;

export function containsPaanCornerReference(value) {
  return PAAN_CORNER_REFERENCE_PATTERN.test(String(value || ''));
}

export function isPaanCornerOrder(order) {
  if (order?.restrictedProductConsent?.policyVersion) return true;
  return Array.isArray(order?.items) && order.items.some(isPaanCornerItem);
}

export function assertNoPaanCornerItems(items = []) {
  if (!items.some(isPaanCornerItem)) return items;
  // Do not confirm the existence of a hidden catalog item to the Android client.
  throw new AppError('Product not found in cart', 404, 'PRODUCT_NOT_FOUND');
}

async function paanCornerCategoryIds() {
  const roots = await Category.find({
    parent: null,
    $or: [
      { slug: PAAN_CORNER_CATEGORY_PATTERN },
      { name: PAAN_CORNER_CATEGORY_PATTERN },
    ],
  }).distinct('_id');
  const children = roots.length
    ? await Category.find({ parent: { $in: roots } }).distinct('_id')
    : [];
  return { roots, all: [...roots, ...children] };
}

export async function paanCornerProductExclusion() {
  const ids = await paanCornerCategoryIds();
  const forbidden = [
    { category: PAAN_CORNER_CATEGORY_PATTERN },
    { categorySlug: PAAN_CORNER_CATEGORY_PATTERN },
  ];
  if (ids.roots.length) forbidden.push({ categoryRef: { $in: ids.roots } });
  if (ids.all.length) forbidden.push({ subcategoryRef: { $in: ids.all } });
  return { $nor: forbidden };
}

export async function paanCornerCategoryExclusion() {
  const ids = await paanCornerCategoryIds();
  return {
    _id: { $nin: ids.all },
    slug: { $not: PAAN_CORNER_CATEGORY_PATTERN },
    name: { $not: PAAN_CORNER_CATEGORY_PATTERN },
  };
}

export function combineMongoFilters(...filters) {
  const active = filters.filter((filter) => filter && Object.keys(filter).length > 0);
  if (active.length === 0) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
}

export function paanCornerTextExclusion(fields = []) {
  if (fields.length === 0) return {};
  return {
    $nor: fields.map((field) => ({ [field]: PAAN_CORNER_REFERENCE_PATTERN })),
  };
}

export function androidVisibleOrderFilter() {
  return {
    $nor: [
      { 'restrictedProductConsent.policyVersion': { $exists: true, $ne: '' } },
      { 'items.category': PAAN_CORNER_CATEGORY_PATTERN },
    ],
  };
}

export function androidVisiblePaymentIntentFilter() {
  return {
    $nor: [
      { 'checkoutSnapshot.items.category': PAAN_CORNER_CATEGORY_PATTERN },
      { 'checkoutSnapshot.items.categorySlug': PAAN_CORNER_CATEGORY_PATTERN },
    ],
  };
}
