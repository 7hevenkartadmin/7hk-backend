import { Product } from '../catalog/product.model.js';
import { InventoryMovement } from '../orders/inventoryMovement.model.js';
import { AppError } from '../../shared/utils/AppError.js';
import { assertItemQuantity, maxOrderableQuantity, netAvailableStock } from '../../shared/utils/inventory.js';

function productIdFor(item) {
  return item.productId || item.product?._id || item.product;
}

function variantIdFor(item) {
  return item.variantId || item.variant?._id;
}

function selectVariant(product, variantId, { allowInactive = false } = {}) {
  if (!product.variants?.length) return null;
  const variant = variantId
    ? product.variants.id(variantId)
    : product.variants.find((entry) => entry.isDefault && (allowInactive || entry.isActive))
      || product.variants.find((entry) => allowInactive || entry.isActive);
  if (!variant || (!allowInactive && !variant.isActive)) {
    throw new AppError(`${product.name} variant is unavailable`, 409, 'VARIANT_UNAVAILABLE');
  }
  return variant;
}

async function loadProducts(items, session) {
  const ids = [...new Set(items.map((item) => String(productIdFor(item))))];
  const query = Product.find({ _id: { $in: ids } });
  if (session) query.session(session);
  const products = await query;
  const byId = new Map(products.map((product) => [String(product._id), product]));
  if (products.length !== ids.length) throw new AppError('Product not found in cart', 404, 'PRODUCT_NOT_FOUND');
  return byId;
}

async function mutateProducts(items, session, mutation, { allowInactive = false, enforceMaximum = true } = {}) {
  const byId = await loadProducts(items, session);
  const changed = new Map();
  const normalizedItems = [];

  for (const item of items) {
    const numericQuantity = Number(item.quantity);
    const quantity = enforceMaximum
      ? assertItemQuantity(numericQuantity)
      : numericQuantity;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new AppError('Inventory quantity must be a positive integer', 409, 'INVENTORY_QUANTITY_INVALID');
    }
    const product = byId.get(String(productIdFor(item)));
    if (!product) throw new AppError('Product not found in cart', 404, 'PRODUCT_NOT_FOUND');
    if (!allowInactive && product.isActive === false) throw new AppError('Product not found in cart', 404, 'PRODUCT_NOT_FOUND');
    const variant = selectVariant(product, variantIdFor(item), { allowInactive });
    await mutation({ product, variant, quantity, item });
    changed.set(String(product._id), product);
    normalizedItems.push({
      product: product._id,
      variantId: variant?._id,
      quantity,
    });
  }

  for (const product of changed.values()) await product.save({ session });
  return { products: [...changed.values()], items: normalizedItems };
}

function inventoryTarget(product, variant) {
  return variant || product;
}

export async function reserveInventory(items, session) {
  return mutateProducts(items, session, ({ product, variant, quantity }) => {
    const target = inventoryTarget(product, variant);
    const available = netAvailableStock(target.stock, target.reservedStock);
    if (available < quantity) {
      throw new AppError(`${product.name} has only ${available} left`, 409, 'INSUFFICIENT_STOCK', {
        maxOrderableQuantity: maxOrderableQuantity(target.stock, target.reservedStock),
      });
    }
    target.reservedStock = Number(target.reservedStock || 0) + quantity;
  });
}

export async function releaseReservedInventory(items, session) {
  return mutateProducts(items, session, ({ product, variant, quantity }) => {
    const target = inventoryTarget(product, variant);
    if (Number(target.reservedStock || 0) < quantity) {
      throw new AppError(`Inventory reservation for ${product.name} is inconsistent`, 409, 'INVENTORY_RESERVATION_MISMATCH');
    }
    target.reservedStock = Number(target.reservedStock || 0) - quantity;
  }, { allowInactive: true });
}

async function writeMovements(items, orderId, type, quantitySign, actorId, reason, session) {
  if (!items.length) return [];
  const rows = items.map((item) => ({
    idempotencyKey: `${type}:${orderId}:${item.product}:${item.variantId || 'default'}`,
    type,
    product: item.product,
    variantId: item.variantId,
    order: orderId,
    quantityDelta: quantitySign * item.quantity,
    actor: actorId,
    reason,
  }));
  return InventoryMovement.create(rows, { session });
}

export async function consumeReservedInventory(items, orderId, actorId, session) {
  const result = await mutateProducts(items, session, ({ product, variant, quantity }) => {
    const target = inventoryTarget(product, variant);
    if (Number(target.reservedStock || 0) < quantity || Number(target.stock || 0) < quantity) {
      throw new AppError(`Inventory reservation for ${product.name} is inconsistent`, 409, 'INVENTORY_RESERVATION_MISMATCH');
    }
    target.stock = Number(target.stock || 0) - quantity;
    target.reservedStock = Number(target.reservedStock || 0) - quantity;
  }, { allowInactive: true });
  await writeMovements(result.items, orderId, 'order_sold', -1, actorId, 'Reserved inventory consumed by paid order', session);
  return result;
}

export async function sellAvailableInventory(items, orderId, actorId, session) {
  const result = await mutateProducts(items, session, ({ product, variant, quantity }) => {
    const target = inventoryTarget(product, variant);
    const available = netAvailableStock(target.stock, target.reservedStock);
    if (available < quantity) {
      throw new AppError(`${product.name} has only ${available} left`, 409, 'INSUFFICIENT_STOCK', {
        maxOrderableQuantity: maxOrderableQuantity(target.stock, target.reservedStock),
      });
    }
    target.stock = Number(target.stock || 0) - quantity;
  });
  await writeMovements(result.items, orderId, 'order_sold', -1, actorId, 'Inventory sold by cash on delivery order', session);
  return result;
}

export async function restoreOrderInventory(items, orderId, actorId, session) {
  const result = await mutateProducts(items, session, ({ product, variant, quantity }) => {
    const target = inventoryTarget(product, variant);
    target.stock = Number(target.stock || 0) + quantity;
  }, { allowInactive: true, enforceMaximum: false });
  await writeMovements(result.items, orderId, 'order_cancelled', 1, actorId, 'Inventory restored after order cancellation', session);
  return result;
}

export function inventoryChanges(products, action, quantityByProduct = new Map()) {
  return products.map((product) => ({
    action,
    productId: String(product._id),
    stock: product.stock,
    availableStock: product.availableStock,
    quantityChanged: quantityByProduct.get(String(product._id)) || 0,
  }));
}
