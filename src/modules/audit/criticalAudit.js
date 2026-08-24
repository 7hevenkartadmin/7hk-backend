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

export function criticalAuditType(log = {}) {
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
