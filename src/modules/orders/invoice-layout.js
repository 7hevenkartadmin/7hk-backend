import { storeBusiness } from '../../config/store.js';
import { formatStoreDate } from '../../shared/utils/storeDate.js';
import { formatStoreBrandName } from '../../shared/utils/brandName.js';

const PAGE = { width: 595.28, height: 841.89, margin: 36 };
const WIDTH = PAGE.width - PAGE.margin * 2;
const C = { ink: '#18271f', green: '#137d43', pale: '#edf7f0', muted: '#64736b', line: '#dce5df', light: '#f5f8f6' };
const number = (value) => Number(value || 0).toFixed(2);
const money = (value) => `Rs. ${number(value)}`;
const safe = (value, fallback = '-') => String(value ?? '').trim() || fallback;
const terms = [
  'For an order query, contact support through the platform or the email printed below. Never share card details, UPI PIN or delivery/pickup OTP with support.',
  "Cancellation is available only before packing. A voluntary prepaid cancellation may retain only Razorpay's actual recorded processing fee; if the exact fee is unavailable, no fee is deducted.",
  'Open a delivered-order support ticket within 5 hours of the recorded delivery time for missing, wrong, damaged, expired or quality-affected items. Reasonable proof may be required.',
  'Perishable, opened or hygiene-sensitive goods are not returnable for change of mind. Statutory consumer rights remain unaffected.',
];
const documentTerms = (order) => order.creditReason ? ['Retain this credit note with the original invoice and supporting return/adjustment records. Payment refunds are accounted for separately. For a query, contact the support email below.'] : terms;

function text(doc, content, x, y, width, { size = 8, bold = false, color = C.ink, align = 'left', ...options } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color)
    .text(safe(content), x, y, { width, align, lineGap: 1.5, ...options });
}
function label(doc, content, x, y, width) { text(doc, content.toUpperCase(), x, y, width, { size: 7, bold: true, color: C.muted, lineBreak: false }); }
function rule(doc, y, x = PAGE.margin, width = WIDTH) { doc.save().strokeColor(C.line).lineWidth(0.6).moveTo(x, y).lineTo(x + width, y).stroke().restore(); }
function card(doc, x, y, width, height, fill = C.light) { doc.save().roundedRect(x, y, width, height, 7).fill(fill).restore(); }
function height(doc, content, width, size = 8, bold = false) { return doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).heightOfString(content, { width, lineGap: 1.5 }); }

function header(doc, order, invoice, continued = false, seller = storeBusiness) {
  const x = PAGE.margin;
  doc.save().roundedRect(x, 32, 4, 27, 2).fill(C.green).restore();
  text(doc, formatStoreBrandName(seller.tradeName), x + 13, 31, 260, { size: 24, bold: true });
  const title = { CREDIT_NOTE: 'CREDIT NOTE', COMMERCIAL_CREDIT_NOTE: 'COMMERCIAL CREDIT NOTE', BILL_OF_SUPPLY: 'BILL OF SUPPLY', INVOICE_CUM_BILL_OF_SUPPLY: 'INVOICE-CUM-BILL OF SUPPLY' }[order.documentType] || 'TAX INVOICE';
  text(doc, continued ? `${title} / CONTINUED` : title, x + 245, 34, WIDTH - 245, { size: title.length > 20 ? 9 : 13, bold: true, align: 'right' });
  text(doc, invoice.number, x + 245, 54, WIDTH - 245, { size: 8, color: C.muted, align: 'right' });
  if (continued) { rule(doc, 77); return 91; }
  text(doc, seller.legalName, x, 70, 300, { size: 9, bold: true });
  text(doc, seller.address, x, 84, 305, { size: 7.5, color: C.muted, height: 19, ellipsis: true });
  text(doc, `GSTIN ${seller.gstin}`, x, 105, 305, { size: 8, bold: true });
  if (invoice.originalNumber) text(doc, `Against ${invoice.originalNumber} (${formatStoreDate(invoice.originalIssuedAt, { dateStyle: 'short' })})`, x + 245, 73, WIDTH - 245, { size: 7.5, align: 'right', color: C.muted });
  text(doc, formatStoreDate(invoice.issuedAt || order.createdAt, { dateStyle: 'medium', timeStyle: 'short' }), x + 310, 89, WIDTH - 310, { size: 8, color: C.muted, align: 'right' });
  text(doc, `Order ${order.orderNumber}`, x + 310, 105, WIDTH - 310, { size: 8, align: 'right' });
  rule(doc, 116);
  return 128;
}

function details(doc, order, y) {
  const x = PAGE.margin;
  const gap = 14;
  const left = 305;
  const right = WIDTH - left - gap;
  const name = order.customerSnapshot?.name || order.address?.recipientName || 'Customer';
  const address = [order.address?.line1, order.address?.line2, order.address?.landmark, order.address?.city, order.address?.state, order.address?.pincode].filter(Boolean).join(', ');
  const addressHeight = height(doc, address || '-', left - 26, 7.5);
  const blockHeight = Math.max(87, 54 + addressHeight + 12);
  card(doc, x, y, left, blockHeight);
  card(doc, x + left + gap, y, right, blockHeight);
  label(doc, 'Bill to', x + 13, y + 10, left - 26);
  text(doc, name, x + 13, y + 24, left - 26, { size: 10, bold: true, height: 14, ellipsis: true });
  text(doc, `Phone ${safe(order.customerSnapshot?.phone || order.address?.phone)}`, x + 13, y + 40, left - 26, { size: 8, color: C.muted });
  text(doc, address, x + 13, y + 54, left - 26, { size: 7.5, color: C.muted });
  const rightX = x + left + gap + 13;
  label(doc, 'Payment & supply', rightX, y + 10, right - 26);
  text(doc, order.taxRecordLocked ? `${safe(order.paymentMethod).toUpperCase()} / method at issue` : `${safe(order.paymentMethod).toUpperCase()} / ${safe(order.paymentStatus)}`, rightX, y + 26, right - 26, { size: 9, bold: true });
  label(doc, 'Place of supply', rightX, y + 47, right - 26);
  text(doc, order.address?.state || 'Bihar', rightX, y + 62, right - 26, { size: 9 });
  return y + blockHeight + 14;
}

const columns = [
  { key: 'description', title: 'ITEM / HSN', width: 170 },
  { key: 'quantity', title: 'QTY', width: 31, align: 'center' },
  { key: 'unitMrp', title: 'MRP', width: 39, align: 'right' },
  { key: 'discount', title: 'SAVINGS', width: 51, align: 'right' },
  { key: 'taxableValue', title: 'TAXABLE', width: 59, align: 'right' },
  { key: 'cgst', title: 'CGST', width: 50, align: 'right' },
  { key: 'sgst', title: 'SGST', width: 50, align: 'right' },
  { key: 'lineTotal', title: 'AMOUNT / Rs.', width: WIDTH - 450, align: 'right' },
];

function tableHeader(doc, y) {
  card(doc, PAGE.margin, y, WIDTH, 30, C.green);
  let x = PAGE.margin;
  for (const col of columns) {
    text(doc, col.title, x + 7, y + 10, col.width - 14, { size: 6.6, bold: true, color: '#ffffff', align: col.align, lineBreak: false });
    x += col.width;
  }
  return y + 34;
}

function lineMeta(line) {
  if (line.isDelivery) return `GST ${line.taxRate}% included`;
  return [line.unit, `HSN ${safe(line.hsnCode)}`, `SKU ${safe(line.sku)}`, line.allocatedCouponDiscount ? `Coupon ${money(line.allocatedCouponDiscount)}` : '', line.deliveryTaxableValue ? `Delivery allocation ${money(line.deliveryTaxableValue)}` : ''].filter(Boolean).join(' | ');
}
function rowHeight(doc, line) { return Math.max(46, height(doc, line.description, 156, 8.5, true) + height(doc, lineMeta(line), 156, 6.5) + 20); }
function tableRow(doc, line, y, rowSize) {
  if (line.isDelivery) card(doc, PAGE.margin, y + 1, WIDTH, rowSize - 2, C.pale);
  let x = PAGE.margin;
  for (const col of columns) {
    const innerWidth = col.width - 14;
    if (col.key === 'description') {
      text(doc, line.description, x + 7, y + 9, innerWidth, { size: 8.5, bold: true });
      const titleHeight = height(doc, line.description, innerWidth, 8.5, true);
      text(doc, lineMeta(line), x + 7, y + 12 + titleHeight, innerWidth, { size: 6.5, color: C.muted });
    } else if (col.key === 'cgst' || col.key === 'sgst') {
      text(doc, `${number(line[`${col.key}Rate`])}%`, x + 7, y + 9, innerWidth, { size: 6.5, color: C.muted, align: 'right' });
      text(doc, number(line[`${col.key}Amount`]), x + 7, y + 22, innerWidth, { size: 8, align: 'right' });
    } else {
      const content = line.isDelivery && ['quantity', 'unitMrp', 'discount'].includes(col.key) ? '-' : col.key === 'quantity' ? String(line.quantity) : number(line[col.key]);
      text(doc, content, x + 7, y + 14, innerWidth, { size: 8, bold: col.key === 'lineTotal', align: col.align, lineBreak: false });
    }
    x += col.width;
  }
  rule(doc, y + rowSize);
  return y + rowSize;
}

function tableTotal(doc, totals, y) {
  const fields = ['TOTAL', String(totals.itemQuantity), '', number(totals.productDiscount), number(totals.taxableValue), number(totals.cgst), number(totals.sgst), number(totals.taxableValue + totals.tax)];
  card(doc, PAGE.margin, y + 5, WIDTH, 29);
  let x = PAGE.margin;
  columns.forEach((col, index) => { text(doc, fields[index] || ' ', x + 7, y + 15, col.width - 14, { size: 7.5, bold: true, align: col.align, lineBreak: false }); x += col.width; });
  return y + 40;
}

function summaryRow(doc, title, amount, x, y, width, { bold = false, color = C.ink, negative = false } = {}) {
  text(doc, title, x, y, width - 91, { size: bold ? 10 : 8, bold, color, lineBreak: false });
  text(doc, `${negative ? '- ' : ''}${money(amount)}`, x + width - 91, y, 91, { size: bold ? 13 : 8, bold: true, color, align: 'right', lineBreak: false });
}

function finalHeight(doc, totals, order) {
  const termsSize = documentTerms(order).reduce((sum, term) => sum + height(doc, term, WIDTH - 12, 7) + 5, 0);
  return 145 + (totals.couponDiscount ? 18 : 0) + 37 + 26 + termsSize + 16 + (order.creditReason ? height(doc, `Reason: ${order.creditReason}`, WIDTH, 8) + 30 : 0);
}

function finalSections(doc, order, totals, y, amountInWords, seller) {
  const x = PAGE.margin;
  const leftWidth = 255;
  const rightX = x + leftWidth + 22;
  const rightWidth = WIDTH - leftWidth - 22;
  const inclusive = order.pricingVersion >= 3;
  const credit = ['CREDIT_NOTE', 'COMMERCIAL_CREDIT_NOTE'].includes(order.documentType);
  label(doc, credit ? order.gstAdjustment ? 'GST adjustment' : 'Reference GST / no tax adjustment' : inclusive ? 'GST included in this invoice' : 'GST breakdown', x, y + 4, leftWidth);
  summaryRow(doc, 'Taxable value', totals.taxableValue, x, y + 24, leftWidth);
  summaryRow(doc, 'CGST', totals.cgst, x, y + 41, leftWidth);
  summaryRow(doc, 'SGST', totals.sgst, x, y + 58, leftWidth);
  summaryRow(doc, 'Total GST', totals.tax, x, y + 75, leftWidth);
  if (order.pricingVersion >= 3) {
    const deliveryLabel = order.pricingVersion === 4 ? `Delivery GST ${number(order.deliveryTaxRate)}%` : 'Delivery GST';
    summaryRow(doc, deliveryLabel, order.deliveryTax || 0, x, y + 97, leftWidth);
    text(doc, 'Included in the delivery charge shown.', x, y + 112, leftWidth, { size: 7, color: C.muted });
  }
  label(doc, 'Payment summary / Rs.', rightX, y + 4, rightWidth);
  summaryRow(doc, inclusive ? 'Items (GST included)' : 'Items before coupon', order.subtotal, rightX, y + 26, rightWidth);
  summaryRow(doc, inclusive ? 'Delivery (GST included)' : 'Delivery charge', totals.deliveryFee, rightX, y + 45, rightWidth);
  let totalY = y + 67;
  if (totals.couponDiscount > 0) {
    summaryRow(doc, 'Coupon discount', totals.couponDiscount, rightX, y + 64, rightWidth, { negative: true });
    totalY += 18;
  }
  if (!inclusive) { summaryRow(doc, 'GST', totals.tax, rightX, totalY, rightWidth); totalY += 24; }
  card(doc, rightX - 10, totalY, rightWidth + 20, 43, C.green);
  summaryRow(doc, credit ? 'Amount credited' : order.taxRecordLocked ? 'Invoice total' : order.paymentStatus === 'paid' ? 'Amount paid' : 'Amount payable', totals.grandTotal, rightX, totalY + 14, rightWidth, { bold: true, color: '#ffffff' });
  text(doc, credit ? order.gstAdjustment ? 'GST credit against the original supply. Payment refunds are recorded separately.' : 'Commercial credit only. Original output GST is unchanged.' : inclusive ? 'All prices include GST. No additional tax is added.' : 'Amounts reflect the recorded order totals.', rightX, totalY + 53, rightWidth, { size: 7, color: C.muted });
  y = Math.max(y + 140, totalY + 75);
  label(doc, 'Amount in words', x, y, WIDTH);
  text(doc, amountInWords(totals.grandTotal), x, y + 15, WIDTH, { size: 8.5, bold: true });
  y += 37;
  if (order.creditReason) {
    text(doc, `Reason: ${order.creditReason}`, x, y, WIDTH, { size: 8 });
    y += height(doc, `Reason: ${order.creditReason}`, WIDTH, 8) + 15;
  }
  rule(doc, y);
  label(doc, 'Terms & support', x, y + 12, WIDTH);
  let termY = y + 26;
  for (const term of documentTerms(order)) { text(doc, term, x, termY, WIDTH, { size: 7, color: C.muted }); termY += height(doc, term, WIDTH, 7) + 5; }
  text(doc, `Issued electronically by ${seller.legalName}.`, x, termY + 5, WIDTH, { size: 7, color: C.muted });
}

export function renderInvoiceDocument(doc, order, invoice, lines, totals, amountInWords, seller = storeBusiness) {
  let y = details(doc, order, header(doc, order, invoice, false, seller));
  y = tableHeader(doc, y);
  for (const line of lines) {
    const size = rowHeight(doc, line);
    if (y + size > PAGE.height - 77) { doc.addPage(); y = tableHeader(doc, header(doc, order, invoice, true, seller)); }
    y = tableRow(doc, line, y, size);
  }
  if (y + 48 > PAGE.height - 77) { doc.addPage(); y = tableHeader(doc, header(doc, order, invoice, true, seller)); }
  y = tableTotal(doc, totals, y);
  if (y + finalHeight(doc, totals, order) > PAGE.height - 77) { doc.addPage(); y = header(doc, order, invoice, true, seller); }
  finalSections(doc, order, totals, y, amountInWords, seller);
  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index += 1) {
    doc.switchToPage(index);
    rule(doc, PAGE.height - 58);
    text(doc, `Help: ${seller.supportEmail}`, PAGE.margin, PAGE.height - 47, 290, { size: 7, color: C.green, bold: true, lineBreak: false });
    text(doc, `Page ${index - pages.start + 1} of ${pages.count}`, PAGE.width - PAGE.margin - 95, PAGE.height - 47, 95, { size: 7, color: C.muted, align: 'right', lineBreak: false });
  }
}
