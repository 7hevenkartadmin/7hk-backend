import { customAlphabet } from 'nanoid';

const SKU_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SKU_TOKEN_LENGTH = 14;
const randomSkuToken = customAlphabet(SKU_ALPHABET, SKU_TOKEN_LENGTH);

export function generateSku() {
  return `7HK-${randomSkuToken()}`;
}

function nextUnusedSku(used, generator) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = String(generator()).trim().toUpperCase();
    if (candidate && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error('Unable to allocate a unique SKU candidate');
}

function withoutSku(value = {}) {
  const clean = { ...value };
  delete clean.sku;
  return clean;
}

function selectedVariantIndex(variants = []) {
  const preferred = variants.findIndex((variant) => variant.isDefault && variant.isActive !== false);
  if (preferred >= 0) return preferred;
  const active = variants.findIndex((variant) => variant.isActive !== false);
  return active >= 0 ? active : 0;
}

export function prepareNewProductSkus(payload, { generator = generateSku } = {}) {
  const clean = withoutSku(payload);
  const used = new Set();
  const incomingVariants = Array.isArray(payload.variants) ? payload.variants : [];

  if (incomingVariants.length === 0) {
    clean.sku = nextUnusedSku(used, generator);
    clean.variants = [];
    return clean;
  }

  clean.variants = incomingVariants.map((variant) => ({
    ...withoutSku(variant),
    sku: nextUnusedSku(used, generator),
  }));
  clean.sku = clean.variants[selectedVariantIndex(clean.variants)].sku;
  return clean;
}

export function prepareProductUpdateSkus(payload, existingVariants = [], { generator = generateSku } = {}) {
  const clean = withoutSku(payload);
  if (!Object.hasOwn(payload, 'variants')) return clean;

  const current = Array.from(existingVariants || []);
  const currentById = new Map(current.map((variant) => [String(variant._id), variant]));
  const used = new Set(current.map((variant) => String(variant.sku || '').trim().toUpperCase()).filter(Boolean));

  clean.variants = (payload.variants || []).map((variant) => {
    const incoming = withoutSku(variant);
    const existing = variant._id ? currentById.get(String(variant._id)) : null;
    if (existing) return { ...incoming, sku: existing.sku, reservedStock: Number(existing.reservedStock || 0) };

    delete incoming._id;
    return { ...incoming, sku: nextUnusedSku(used, generator) };
  });
  return clean;
}

export function isSkuDuplicateKeyError(error) {
  if (error?.code !== 11000) return false;
  const fields = Object.keys(error.keyPattern || {});
  if (fields.some((field) => field === 'sku' || field === 'variants.sku')) return true;
  return /product_sku_unique|product_variant_sku_unique|variants\.sku/i.test(String(error.message || ''));
}
