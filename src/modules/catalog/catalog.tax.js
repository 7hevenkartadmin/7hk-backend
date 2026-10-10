import { AppError } from '../../shared/utils/AppError.js';

export const HSN_PATTERN = /^(?:\d{4}|\d{6}|\d{8})$/;

export function hasTaxDefaults(category) {
  return HSN_PATTERN.test(category?.hsnCode || '')
    && Number.isFinite(category?.taxRate) && category.taxRate >= 0 && category.taxRate <= 100;
}

function validateClassification(hsnCode, taxRate) {
  if (!HSN_PATTERN.test(hsnCode) || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
    throw new AppError('Enter a 4, 6 or 8 digit HSN and a GST rate between 0 and 100', 422, 'INVALID_TAX_CLASSIFICATION');
  }
  // Retain the existing special-valuation restriction until RSP pricing is supported.
  if (/^24|^21069020$/.test(hsnCode)) {
    throw new AppError('Tobacco and pan masala require RSP valuation support before activation', 400, 'SPECIAL_TAX_VALUATION_REQUIRED');
  }
}

export function productNeedsTaxDefaults(payload, existing = null) {
  if (payload.taxMode === 'subcategory') return true;
  if (payload.taxMode === 'override' || payload.taxMode === 'preserve') return false;
  if (Object.hasOwn(payload, 'hsnCode') || Object.hasOwn(payload, 'taxRate')) return false;
  return !existing || (Object.hasOwn(payload, 'subcategoryRef')
    && String(payload.subcategoryRef || '') !== String(existing.subcategoryRef || '')
    && existing.taxOrigin !== 'override');
}

// Defaults are copied at save time. Category edits never reprice saved products/orders.
export function resolveProductTax(payload, existing = null, subcategory = null) {
  const update = { ...payload };
  delete update.taxMode;
  if (payload.taxMode === 'preserve') {
    if (!existing) throw new AppError('New products cannot preserve an existing classification', 422, 'INVALID_TAX_MODE');
    delete update.hsnCode;
    delete update.taxRate;
    return update;
  }
  const inherit = productNeedsTaxDefaults(payload, existing);
  const taxEdited = Object.hasOwn(payload, 'hsnCode') || Object.hasOwn(payload, 'taxRate');
  if (!inherit && !taxEdited && payload.taxMode !== 'override') return update;

  if (inherit && !hasTaxDefaults(subcategory)) {
    return { ...update, hsnCode: '', taxRate: 0, taxOrigin: 'subcategory', taxStatus: 'review',
      taxProfile: '', taxSource: '', taxReviewedAt: null, taxReviewReason: 'Set HSN and GST on the subcategory or override them on this product' };
  }
  const hsnCode = String(inherit ? subcategory.hsnCode : payload.hsnCode ?? existing?.hsnCode ?? '').trim();
  const taxRate = inherit ? subcategory.taxRate : payload.taxRate ?? existing?.taxRate;
  validateClassification(hsnCode, taxRate);
  return { ...update, hsnCode, taxRate, taxOrigin: inherit ? 'subcategory' : 'override',
    taxStatus: 'verified', taxProfile: '', taxSource: '', taxReviewedAt: new Date(), taxReviewReason: '' };
}

export function normalizeCategoryTax(payload, existing = null) {
  const parent = Object.hasOwn(payload, 'parent') ? payload.parent : existing?.parent;
  const taxEdited = Object.hasOwn(payload, 'hsnCode') || Object.hasOwn(payload, 'taxRate');
  if (!parent) {
    if ((payload.hsnCode || (payload.taxRate !== undefined && payload.taxRate !== null))) {
      throw new AppError('HSN and GST defaults belong to a subcategory', 422, 'TAX_DEFAULTS_SUBCATEGORY_ONLY');
    }
    return taxEdited || existing?.parent ? { ...payload, hsnCode: '', taxRate: null } : payload;
  }
  if (!taxEdited) return payload;
  const hsnCode = String(payload.hsnCode ?? existing?.hsnCode ?? '').trim();
  const taxRate = Object.hasOwn(payload, 'taxRate') ? payload.taxRate : existing?.taxRate ?? null;
  if (!hsnCode && taxRate === null) return { ...payload, hsnCode: '', taxRate: null };
  validateClassification(hsnCode, taxRate);
  return { ...payload, hsnCode, taxRate };
}
