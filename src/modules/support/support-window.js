export const DELIVERED_ORDER_SUPPORT_WINDOW_HOURS = 5;
export const DELIVERED_ORDER_SUPPORT_WINDOW_MS = DELIVERED_ORDER_SUPPORT_WINDOW_HOURS * 60 * 60 * 1000;

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function deliveredAtForSupport(order) {
  const candidates = [
    validDate(order?.deliveredAt),
    ...(order?.statusTimeline || [])
      .filter((entry) => entry?.status === 'delivered')
      .map((entry) => validDate(entry?.at)),
  ].filter(Boolean);

  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates.map((date) => date.getTime())));
}

export function deliveredOrderSupportPolicy(order, nowValue = new Date()) {
  const now = validDate(nowValue);
  if (!now) throw new TypeError('A valid current time is required');

  if (order?.status !== 'delivered') {
    return {
      eligible: false,
      deliveredAt: null,
      closesAt: null,
      windowHours: DELIVERED_ORDER_SUPPORT_WINDOW_HOURS,
      reasonCode: 'SUPPORT_TICKET_DELIVERY_REQUIRED',
    };
  }

  const deliveredAt = deliveredAtForSupport(order);
  if (!deliveredAt || deliveredAt.getTime() > now.getTime()) {
    return {
      eligible: false,
      deliveredAt: deliveredAt?.toISOString() || null,
      closesAt: null,
      windowHours: DELIVERED_ORDER_SUPPORT_WINDOW_HOURS,
      reasonCode: 'SUPPORT_TICKET_DELIVERY_TIME_UNAVAILABLE',
    };
  }

  const closesAt = new Date(deliveredAt.getTime() + DELIVERED_ORDER_SUPPORT_WINDOW_MS);
  const eligible = now.getTime() < closesAt.getTime();
  return {
    eligible,
    deliveredAt: deliveredAt.toISOString(),
    closesAt: closesAt.toISOString(),
    windowHours: DELIVERED_ORDER_SUPPORT_WINDOW_HOURS,
    reasonCode: eligible ? null : 'SUPPORT_TICKET_WINDOW_EXPIRED',
  };
}
