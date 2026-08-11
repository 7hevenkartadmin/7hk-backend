export async function sendOrderStatusNotification(order) {
  return {
    provider: 'mock',
    to: order.customerSnapshot?.phone,
    template: 'order_status_update',
    status: order.status,
    orderNumber: order.orderNumber,
  };
}

export async function sendOrderPlacedNotification(order) {
  return {
    provider: 'mock',
    to: order.customerSnapshot?.phone,
    template: 'order_placed',
    orderNumber: order.orderNumber,
  };
}
