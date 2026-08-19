export const MAX_ITEM_QUANTITY = 10;

export function netAvailableStock(stock, reservedStock = 0) {
  return Math.max(0, Number(stock || 0) - Number(reservedStock || 0));
}

export function maxOrderableQuantity(stock, reservedStock = 0, { isActive = true } = {}) {
  if (!isActive) return 0;
  return Math.min(MAX_ITEM_QUANTITY, netAvailableStock(stock, reservedStock));
}

export function assertItemQuantity(quantity) {
  const normalized = Number(quantity);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > MAX_ITEM_QUANTITY) {
    const error = new RangeError(`Item quantity must be between 1 and ${MAX_ITEM_QUANTITY}`);
    error.code = 'ITEM_QUANTITY_LIMIT';
    throw error;
  }
  return normalized;
}
