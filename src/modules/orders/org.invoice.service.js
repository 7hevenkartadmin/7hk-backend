export function buildInvoice(order) {
  const issuedAt = new Date();
  const number = `INV-${issuedAt.getFullYear()}-${order.orderNumber}`;
  return {
    number,
    issuedAt,
    url: `/api/v1/orders/${order.id}/invoice`,
  };
}
