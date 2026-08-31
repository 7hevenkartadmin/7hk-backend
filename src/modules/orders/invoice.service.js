import PDFDocument from "pdfkit";
import { formatStoreDate } from '../../shared/utils/storeDate.js';

export function buildInvoice(order) {
  const issuedAt = new Date();
  const number = `INV-${formatStoreDate(issuedAt, { year: 'numeric' })}-${order.orderNumber}`;
  return {
    number,
    issuedAt,
    url: `/api/v1/orders/${order.id}/invoice`,
  };
}

const money = (value) => `Rs. ${Number(value || 0).toFixed(2)}`;

export function streamInvoicePdf(order, response) {
  const invoice = order.invoice || buildInvoice(order);
  const document = new PDFDocument({
    size: "A4",
    margin: 48,
    info: { Title: invoice.number },
  });
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${invoice.number}.pdf"`,
  );
  response.setHeader("Cache-Control", "private, no-store");
  document.pipe(response);

  document
    .fontSize(22)
    .fillColor("#f38020")
    .text("7hevenkart", { continued: true });
  document
    .fontSize(11)
    .fillColor("#444")
    .text("  TAX INVOICE", { align: "right" });
  document.moveDown().fontSize(10).fillColor("#222");
  document.text(`Invoice: ${invoice.number}`);
  document.text(`Order: ${order.orderNumber}`);
  document.text(
    `Issued: ${formatStoreDate(invoice.issuedAt || order.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}`,
  );
  document.moveDown().fontSize(12).text("Bill to", { underline: true });
  document
    .fontSize(10)
    .text(
      order.customerSnapshot?.name ||
        order.address?.recipientName ||
        "Customer",
    );
  document.text(order.address?.phone || order.customerSnapshot?.phone || "");
  document.text(
    [
      order.address?.line1,
      order.address?.line2,
      order.address?.city,
      order.address?.state,
      order.address?.pincode,
    ]
      .filter(Boolean)
      .join(", "),
  );
  document.moveDown();

  const startY = document.y;
  document.font("Helvetica-Bold");
  document.text("Item", 48, startY, { width: 260 });
  document.text("Qty", 315, startY, { width: 45, align: "right" });
  document.text("Rate", 370, startY, { width: 75, align: "right" });
  document.text("Amount", 455, startY, { width: 90, align: "right" });
  document
    .moveTo(48, startY + 17)
    .lineTo(547, startY + 17)
    .strokeColor("#ddd")
    .stroke();
  document.font("Helvetica");
  let y = startY + 25;
  for (const item of order.items) {
    document.text(`${item.name} (${item.unit})`, 48, y, { width: 260 });
    document.text(String(item.quantity), 315, y, { width: 45, align: "right" });
    document.text(money(item.price), 370, y, { width: 75, align: "right" });
    document.text(money(item.price * item.quantity), 455, y, {
      width: 90,
      align: "right",
    });
    y += 24;
  }
  y += 8;
  const totalLine = (label, value, strong = false) => {
    document
      .font(strong ? "Helvetica-Bold" : "Helvetica")
      .text(label, 340, y, { width: 105, align: "right" });
    document.text(value, 455, y, { width: 90, align: "right" });
    y += 20;
  };
  const mrpTotal = order.items.reduce(
    (sum, item) => sum + item.mrp * item.quantity,
    0,
  );
  const productDiscount = Math.max(0, mrpTotal - order.subtotal);
  totalLine(
    "Product total (MRP)",
    money(productDiscount ? mrpTotal : order.subtotal),
  );
  if (productDiscount)
    totalLine("Product discount", `-${money(productDiscount)}`);
  if (order.tax) totalLine("Taxes", money(order.tax));
  totalLine("Delivery", order.deliveryFee ? money(order.deliveryFee) : "FREE");
  if (order.discount)
    totalLine(
      `Coupon${order.couponCode ? ` (${order.couponCode})` : ""}`,
      `-${money(order.discount)}`,
    );
  totalLine("Amount paid/due", money(order.total), true);
  document
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666")
    .text(
      "All prices and discounts were calculated and verified by the server at order placement.",
      48,
      y + 24,
      { align: "center" },
    );
  document
    .moveDown(1.5)
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#222")
    .text("Terms & support");
  document
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#555")
    .list([
      "Cancellation is available only before packing. For a voluntary prepaid cancellation, only Razorpay's actual transaction fee shown before confirmation may be retained; if the exact fee is unavailable, no fee is deducted.",
      "Staff or platform cancellations do not retain a customer cancellation fee.",
      "Open a delivered-order support ticket within 5 hours of the recorded delivery time for missing, wrong, damaged, expired or quality-affected items. Review and reasonable proof may be required; statutory consumer rights remain unaffected.",
    ], { bulletRadius: 1.5, textIndent: 10, bulletIndent: 2 });
  document.end();
}
