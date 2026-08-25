function comparableVariant(variant = {}) {
  return {
    key: String(variant.sku || variant._id || variant.title || ''),
    mrp: Number(variant.mrp || 0),
    price: Number(variant.price || 0),
  };
}

function productPriceSignature(value = {}) {
  if (Array.isArray(value.variants) && value.variants.length) {
    return value.variants
      .map(comparableVariant)
      .sort((left, right) => left.key.localeCompare(right.key));
  }
  return [{ key: 'default', mrp: Number(value.mrp || 0), price: Number(value.price || 0) }];
}

function deliveryChargeSignature(value = {}) {
  return (Array.isArray(value.deliveryZones) ? value.deliveryZones : [])
    .map((zone) => ({ code: String(zone.code || zone._id || ''), charge: Number(zone.charge || 0) }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

export const CRITICAL_AUDIT_TYPES = ['product_price', 'coupon_creation', 'delivery_charge'];

function legacyProductPriceFilter() {
  return {
    criticalType: { $exists: false },
    action: 'product.update',
    $expr: { $or: [
      { $ne: [{ $ifNull: ['$before.price', null] }, { $ifNull: ['$after.price', null] }] },
      { $ne: [{ $ifNull: ['$before.mrp', null] }, { $ifNull: ['$after.mrp', null] }] },
      { $ne: [{ $ifNull: ['$before.variants.price', []] }, { $ifNull: ['$after.variants.price', []] }] },
      { $ne: [{ $ifNull: ['$before.variants.mrp', []] }, { $ifNull: ['$after.variants.mrp', []] }] },
    ] },
  };
}

function legacyDeliveryChargeFilter() {
  return {
    criticalType: { $exists: false },
    action: 'settings.update',
    $expr: { $ne: [
      { $ifNull: ['$before.deliveryZones.charge', []] },
      { $ifNull: ['$after.deliveryZones.charge', []] },
    ] },
  };
}

export function criticalAuditMongoFilter(type = 'all') {
  const materialized = type === 'all'
    ? { criticalType: { $in: CRITICAL_AUDIT_TYPES } }
    : { criticalType: type };
  const legacyByType = {
    product_price: legacyProductPriceFilter(),
    coupon_creation: { criticalType: { $exists: false }, action: 'coupon.create' },
    delivery_charge: legacyDeliveryChargeFilter(),
  };
  if (type !== 'all') return { $or: [materialized, legacyByType[type]] };
  return { $or: [materialized, ...CRITICAL_AUDIT_TYPES.map((item) => legacyByType[item])] };
}

export function criticalAuditType(log = {}) {
  if (CRITICAL_AUDIT_TYPES.includes(log.criticalType)) return log.criticalType;
  if (log.action === 'coupon.create') return 'coupon_creation';
  if (log.action === 'product.update') {
    return JSON.stringify(productPriceSignature(log.before)) !== JSON.stringify(productPriceSignature(log.after))
      ? 'product_price'
      : null;
  }
  if (log.action === 'settings.update') {
    return JSON.stringify(deliveryChargeSignature(log.before)) !== JSON.stringify(deliveryChargeSignature(log.after))
      ? 'delivery_charge'
      : null;
  }
  return null;
}
