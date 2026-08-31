import PDFDocument from 'pdfkit';
import { storeBusiness } from '../../config/store.js';
import { formatStoreDate } from '../../shared/utils/storeDate.js';

const PAGE = { width: 595.28, height: 841.89, margin: 32 };
const CONTENT_WIDTH = PAGE.width - (PAGE.margin * 2);
const COLORS = {
  ink: '#151515',
  green: '#0c831f',
  paleGreen: '#eaf6ec',
  yellow: '#f8cb46',
  paper: '#ffffff',
  muted: '#555555',
  light: '#f6f7f6',
  line: '#202020',
};

const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const number = (value) => roundMoney(value).toFixed(2);
const money = (value) => `Rs. ${number(value)}`;
const safeText = (value, fallback = '-') => String(value ?? '').trim() || fallback;

export function buildInvoice(order) {
  const issuedAt = new Date();
  const numberValue = `INV-${formatStoreDate(issuedAt, { year: 'numeric' })}-${order.orderNumber}`;
  return {
    number: numberValue,
    issuedAt,
    url: `/api/v1/orders/${order.id}/invoice`,
  };
}

export function invoiceLineItems(order) {
  const lines = (order.items || []).map((item, index) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = roundMoney(item.price);
    const unitMrp = roundMoney(item.mrp ?? item.price);
    const taxableValue = roundMoney(unitPrice * quantity);
    const taxRate = Math.max(0, Number(item.taxRate || 0));
    const taxAmount = roundMoney(taxableValue * (taxRate / 100));
    return {
      serial: index + 1,
      sku: safeText(item.sku),
      description: safeText(item.name, 'Item'),
      unit: safeText(item.unit, ''),
      quantity,
      unitMrp,
      discount: roundMoney(Math.max(0, unitMrp - unitPrice) * quantity),
      taxableValue,
      taxRate,
      taxAmount,
    };
  });

  if (lines.length > 0) {
    const calculatedTax = roundMoney(lines.reduce((sum, line) => sum + line.taxAmount, 0));
    const trustedTax = roundMoney(order.tax ?? calculatedTax);
    const adjustment = roundMoney(trustedTax - calculatedTax);
    lines[lines.length - 1].taxAmount = roundMoney(lines[lines.length - 1].taxAmount + adjustment);
  }

  return lines.map((line) => {
    const cgstAmount = roundMoney(line.taxAmount / 2);
    const sgstAmount = roundMoney(line.taxAmount - cgstAmount);
    return {
      ...line,
      cgstRate: line.taxRate / 2,
      sgstRate: line.taxRate / 2,
      cgstAmount,
      sgstAmount,
      lineTotal: roundMoney(line.taxableValue + line.taxAmount),
    };
  });
}

export function invoiceTotals(order, lines = invoiceLineItems(order)) {
  const itemQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  const productMrp = roundMoney(lines.reduce((sum, line) => sum + (line.unitMrp * line.quantity), 0));
  const productDiscount = roundMoney(lines.reduce((sum, line) => sum + line.discount, 0));
  const taxableValue = roundMoney(order.subtotal ?? lines.reduce((sum, line) => sum + line.taxableValue, 0));
  const tax = roundMoney(order.tax ?? lines.reduce((sum, line) => sum + line.taxAmount, 0));
  const cgst = roundMoney(tax / 2);
  return {
    itemQuantity,
    productMrp,
    productDiscount,
    taxableValue,
    cgst,
    sgst: roundMoney(tax - cgst),
    tax,
    deliveryFee: roundMoney(order.deliveryFee),
    couponDiscount: roundMoney(order.discount),
    grandTotal: roundMoney(order.total),
  };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function underThousand(value) {
  const parts = [];
  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (remainder < 20) {
    if (remainder) parts.push(ONES[remainder]);
  } else {
    const tens = TENS[Math.floor(remainder / 10)];
    const ones = ONES[remainder % 10];
    parts.push(ones ? `${tens}-${ones}` : tens);
  }
  return parts.join(' ');
}

function integerInIndianWords(value) {
  if (value === 0) return 'Zero';
  const parts = [];
  const groups = [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1_000, 'Thousand']];
  let remaining = value;
  for (const [size, groupLabel] of groups) {
    const group = Math.floor(remaining / size);
    if (group) {
      parts.push(`${underThousand(group)} ${groupLabel}`);
      remaining %= size;
    }
  }
  if (remaining) parts.push(underThousand(remaining));
  return parts.join(' ');
}

export function amountInWords(value) {
  const paiseTotal = Math.max(0, Math.round(Number(value || 0) * 100));
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  return `${integerInIndianWords(rupees)} Rupee${rupees === 1 ? '' : 's'}${paise ? ` and ${integerInIndianWords(paise)} Paise` : ''} Only`;
}

function setText(document, { font = 'Helvetica', size = 7, color = COLORS.ink } = {}) {
  return document.font(font).fontSize(size).fillColor(color);
}

function box(document, x, y, width, height, fill = null, lineWidth = 0.65) {
  document.save().lineWidth(lineWidth).strokeColor(COLORS.line);
  if (fill) document.rect(x, y, width, height).fillAndStroke(fill, COLORS.line);
  else document.rect(x, y, width, height).stroke();
  document.restore();
}

function label(document, text, x, y, width) {
  setText(document, { font: 'Helvetica-Bold', size: 6.5, color: COLORS.muted })
    .text(String(text).toUpperCase(), x, y, { width, characterSpacing: 0.25, lineBreak: false });
}

function value(document, text, x, y, width, options = {}) {
  setText(document, { font: options.bold ? 'Helvetica-Bold' : 'Helvetica', size: options.size || 7.2, color: options.color || COLORS.ink })
    .text(safeText(text), x, y, {
      width,
      lineGap: options.lineGap ?? 1,
      align: options.align || 'left',
      height: options.height,
      ellipsis: Boolean(options.height),
    });
}

function drawBrandHeader(document, invoice, continued = false) {
  const x = PAGE.margin;
  const y = PAGE.margin;
  const height = continued ? 46 : 58;
  box(document, x, y, CONTENT_WIDTH, height, COLORS.paper, 0.9);
  document.save().rect(x, y, 7, height).fill(COLORS.green).restore();
  setText(document, { font: 'Helvetica-Bold', size: continued ? 20 : 25 })
    .text('7heven', x + 17, y + (continued ? 11 : 14), { continued: true, lineBreak: false });
  document.fillColor(COLORS.green).text('kart', { lineBreak: false });
  const titleWidth = 180;
  setText(document, { font: 'Helvetica-Bold', size: continued ? 14 : 18 })
    .text(continued ? 'Tax Invoice - continued' : 'Tax Invoice', x + CONTENT_WIDTH - titleWidth - 12, y + (continued ? 14 : 17), { width: titleWidth, align: 'right', lineBreak: false });
  if (!continued) {
    document.save().rect(x + CONTENT_WIDTH - 14, y, 14, 14).fill(COLORS.yellow).restore();
  } else {
    value(document, invoice.number, x + 220, y + 29, 330, { size: 6.5, align: 'right', color: COLORS.muted });
  }
  return y + height;
}

function addressText(address) {
  return [address?.line1, address?.line2, address?.landmark, address?.city].filter(Boolean).join(', ');
}

function drawFirstPageDetails(document, order, invoice, startY) {
  const x = PAGE.margin;
  const sellerWidth = 330;
  const metaWidth = CONTENT_WIDTH - sellerWidth;
  const sellerHeight = 105;
  box(document, x, startY, sellerWidth, sellerHeight);
  box(document, x + sellerWidth, startY, metaWidth, sellerHeight);

  document.save().rect(x, startY, sellerWidth, 17).fill(COLORS.paleGreen).restore();
  label(document, 'Sold by / Seller', x + 8, startY + 5, sellerWidth - 16);
  value(document, storeBusiness.legalName.toUpperCase(), x + 8, startY + 24, sellerWidth - 16, { bold: true, size: 8.2 });
  value(document, `Trading as ${storeBusiness.tradeName}`, x + 8, startY + 38, sellerWidth - 16, { bold: true, size: 6.8, color: COLORS.green });
  value(document, storeBusiness.address, x + 8, startY + 51, sellerWidth - 16, { size: 6.8, height: 25 });
  label(document, 'GSTIN', x + 8, startY + 82, 44);
  value(document, storeBusiness.gstin, x + 54, startY + 81, 130, { bold: true });
  label(document, 'Support', x + 188, startY + 82, 46);
  value(document, storeBusiness.supportEmail, x + 236, startY + 81, sellerWidth - 244, { size: 6.6 });

  const metaX = x + sellerWidth;
  document.save().rect(metaX, startY, metaWidth, 17).fill(COLORS.light).restore();
  label(document, 'Invoice details', metaX + 8, startY + 5, metaWidth - 16);
  const metaRows = [
    ['Invoice number', invoice.number],
    ['Invoice date', formatStoreDate(invoice.issuedAt || order.createdAt, { dateStyle: 'medium', timeStyle: 'short' })],
    ['Order ID', order.orderNumber],
    ['Order date', formatStoreDate(order.createdAt || invoice.issuedAt, { dateStyle: 'medium', timeStyle: 'short' })],
  ];
  metaRows.forEach(([rowLabel, rowValue], index) => {
    const rowY = startY + 24 + (index * 18);
    label(document, rowLabel, metaX + 8, rowY, 65);
    value(document, rowValue, metaX + 76, rowY - 1, metaWidth - 84, { bold: index === 0, size: 6.7, align: 'right' });
  });

  const customerY = startY + sellerHeight;
  const customerHeight = 89;
  box(document, x, customerY, sellerWidth, customerHeight);
  box(document, metaX, customerY, metaWidth, customerHeight);
  document.save().rect(x, customerY, sellerWidth, 17).fill(COLORS.light).restore();
  label(document, 'Invoice to', x + 8, customerY + 5, sellerWidth - 16);
  const customerName = order.customerSnapshot?.name || order.address?.recipientName || 'Customer';
  value(document, customerName, x + 8, customerY + 24, sellerWidth - 16, { bold: true, size: 8 });
  value(document, `Mobile: ${order.customerSnapshot?.phone || order.address?.phone || '-'}`, x + 8, customerY + 38, sellerWidth - 16, { size: 6.8 });
  value(document, addressText(order.address), x + 8, customerY + 51, sellerWidth - 16, { size: 6.8, height: 30 });

  document.save().rect(metaX, customerY, metaWidth, 17).fill(COLORS.paleGreen).restore();
  label(document, 'Delivery & payment', metaX + 8, customerY + 5, metaWidth - 16);
  const deliveryRows = [
    ['Pin code', order.address?.pincode],
    ['State', order.address?.state || 'Bihar'],
    ['Place of supply', order.address?.state || 'Bihar'],
    ['Payment', `${safeText(order.paymentMethod).toUpperCase()} - ${safeText(order.paymentStatus)}`],
  ];
  deliveryRows.forEach(([rowLabel, rowValue], index) => {
    const rowY = customerY + 24 + (index * 15);
    label(document, rowLabel, metaX + 8, rowY, 70);
    value(document, rowValue, metaX + 80, rowY - 1, metaWidth - 88, { size: 6.7, align: 'right' });
  });
  return customerY + customerHeight;
}

const TABLE_COLUMNS = [
  { key: 'serial', label: 'Sr.', width: 22, align: 'center' },
  { key: 'sku', label: 'SKU', width: 57 },
  { key: 'description', label: 'Item description', width: 116 },
  { key: 'unitMrp', label: 'MRP\n(Rs.)', width: 43, align: 'right' },
  { key: 'discount', label: 'Discount\n(Rs.)', width: 45, align: 'right' },
  { key: 'quantity', label: 'Qty.', width: 28, align: 'center' },
  { key: 'taxableValue', label: 'Taxable\nvalue', width: 50, align: 'right' },
  { key: 'cgst', label: 'CGST\n% / Rs.', width: 48, align: 'right' },
  { key: 'sgst', label: 'SGST\n% / Rs.', width: 48, align: 'right' },
  { key: 'lineTotal', label: 'Total\n(Rs.)', width: 74, align: 'right' },
];

function drawTableHeader(document, y) {
  let x = PAGE.margin;
  const height = 34;
  for (const column of TABLE_COLUMNS) {
    box(document, x, y, column.width, height, COLORS.light);
    setText(document, { font: 'Helvetica-Bold', size: 5.8 })
      .text(column.label, x + 3, y + 8, { width: column.width - 6, align: column.align || 'left', lineGap: 0.5 });
    x += column.width;
  }
  return y + height;
}

function lineValue(line, key) {
  if (key === 'description') return line.unit ? `${line.description}\n${line.unit}` : line.description;
  if (key === 'cgst') return `${number(line.cgstRate)}%\n${number(line.cgstAmount)}`;
  if (key === 'sgst') return `${number(line.sgstRate)}%\n${number(line.sgstAmount)}`;
  if (['unitMrp', 'discount', 'taxableValue', 'lineTotal'].includes(key)) return number(line[key]);
  return String(line[key]);
}

function tableRowHeight(document, line) {
  setText(document, { size: 6.2 });
  const descriptionHeight = document.heightOfString(lineValue(line, 'description'), { width: 110, lineGap: 0.7 });
  const skuHeight = document.heightOfString(line.sku, { width: 51, lineGap: 0.7 });
  return Math.max(30, Math.min(48, Math.max(descriptionHeight, skuHeight) + 10));
}

function drawTableRow(document, line, y, height) {
  let x = PAGE.margin;
  for (const column of TABLE_COLUMNS) {
    box(document, x, y, column.width, height);
    setText(document, { font: column.key === 'description' ? 'Helvetica-Bold' : 'Helvetica', size: 6.2 })
      .text(lineValue(line, column.key), x + 3, y + 5, {
        width: column.width - 6,
        height: height - 8,
        align: column.align || 'left',
        lineGap: 0.7,
        ellipsis: true,
      });
    x += column.width;
  }
  return y + height;
}

function drawTableTotal(document, totals, y) {
  const values = ['', '', 'Total', '', number(totals.productDiscount), String(totals.itemQuantity), number(totals.taxableValue), number(totals.cgst), number(totals.sgst), number(totals.taxableValue + totals.tax)];
  let x = PAGE.margin;
  const height = 24;
  TABLE_COLUMNS.forEach((column, index) => {
    box(document, x, y, column.width, height, index === 2 ? COLORS.paleGreen : COLORS.paper, 0.8);
    setText(document, { font: 'Helvetica-Bold', size: 6.5 })
      .text(values[index], x + 3, y + 8, { width: column.width - 6, align: column.align || 'left', lineBreak: false });
    x += column.width;
  });
  return y + height;
}

function drawSummaryLine(document, labelText, amount, x, y, width, strong = false, negative = false) {
  setText(document, { font: strong ? 'Helvetica-Bold' : 'Helvetica', size: strong ? 8.4 : 7 })
    .text(labelText, x, y, { width: width - 80, lineBreak: false });
  document.text(`${negative ? '- ' : ''}${money(amount)}`, x + width - 80, y, { width: 80, align: 'right', lineBreak: false });
}

function drawFinalSections(document, order, invoice, totals, y) {
  const x = PAGE.margin;
  const wordsHeight = 43;
  box(document, x, y, CONTENT_WIDTH, wordsHeight, COLORS.paper, 0.8);
  label(document, 'Amount in words', x + 8, y + 7, 100);
  value(document, amountInWords(totals.grandTotal), x + 112, y + 7, CONTENT_WIDTH - 120, { bold: true, size: 7.4, height: 28 });
  y += wordsHeight;

  const summaryHeight = 105;
  const leftWidth = 310;
  const rightWidth = CONTENT_WIDTH - leftWidth;
  box(document, x, y, leftWidth, summaryHeight);
  box(document, x + leftWidth, y, rightWidth, summaryHeight);
  label(document, 'Seller declaration', x + 8, y + 8, leftWidth - 16);
  value(document, `${storeBusiness.tradeName} is operated by ${storeBusiness.legalName}. This invoice is generated from the final server-verified order record.`, x + 8, y + 22, leftWidth - 16, { size: 6.8, height: 29 });
  label(document, 'GSTIN', x + 8, y + 56, 42);
  value(document, storeBusiness.gstin, x + 52, y + 55, 120, { bold: true });
  value(document, `For ${storeBusiness.legalName}`, x + 175, y + 56, leftWidth - 183, { bold: true, size: 6.5, align: 'center' });
  document.moveTo(x + 188, y + 87).lineTo(x + leftWidth - 12, y + 87).lineWidth(0.5).strokeColor(COLORS.line).stroke();
  value(document, 'Authorised signatory', x + 175, y + 91, leftWidth - 183, { size: 5.8, align: 'center' });

  const summaryX = x + leftWidth + 8;
  const summaryWidth = rightWidth - 16;
  drawSummaryLine(document, 'Item taxable value', totals.taxableValue, summaryX, y + 8, summaryWidth);
  drawSummaryLine(document, 'CGST', totals.cgst, summaryX, y + 23, summaryWidth);
  drawSummaryLine(document, 'SGST', totals.sgst, summaryX, y + 38, summaryWidth);
  drawSummaryLine(document, 'Delivery charge', totals.deliveryFee, summaryX, y + 53, summaryWidth);
  if (totals.couponDiscount > 0) drawSummaryLine(document, `Coupon${order.couponCode ? ` (${order.couponCode})` : ''}`, totals.couponDiscount, summaryX, y + 68, summaryWidth, false, true);
  document.moveTo(summaryX, y + 84).lineTo(summaryX + summaryWidth, y + 84).lineWidth(0.8).strokeColor(COLORS.line).stroke();
  drawSummaryLine(document, order.paymentStatus === 'paid' ? 'Amount paid' : 'Amount payable', totals.grandTotal, summaryX, y + 90, summaryWidth, true);
  y += summaryHeight;

  const terms = [
    'For an order query, contact customer support through the platform or email the support address printed on this invoice.',
    'Never share card numbers, CVV, bank account details, UPI PIN, delivery OTP or pickup OTP with support personnel.',
    "Cancellation is available only before packing. A voluntary prepaid cancellation may retain only Razorpay's actual recorded processing fee; if that exact fee is unavailable, no fee is deducted.",
    'Open a delivered-order support ticket within 5 hours of the recorded delivery time for missing, wrong, damaged, expired or quality-affected items. Reasonable proof may be required.',
    'Perishable, opened or hygiene-sensitive goods are not returnable for change of mind. Statutory consumer rights remain unaffected.',
  ];
  const termsHeight = 102;
  box(document, x, y, CONTENT_WIDTH, termsHeight);
  document.save().rect(x, y, CONTENT_WIDTH, 17).fill(COLORS.light).restore();
  label(document, 'Terms & conditions', x + 8, y + 5, CONTENT_WIDTH - 16);
  setText(document, { size: 6.2, color: COLORS.ink });
  let termY = y + 23;
  terms.forEach((term, index) => {
    const text = `${index + 1}. ${term}`;
    document.text(text, x + 8, termY, { width: CONTENT_WIDTH - 16, lineGap: 0.8 });
    termY += document.heightOfString(text, { width: CONTENT_WIDTH - 16, lineGap: 0.8 }) + 2;
  });
  y += termsHeight;

  const footerHeight = 24;
  document.save().rect(x, y, CONTENT_WIDTH, footerHeight).fill(COLORS.paleGreen).restore();
  value(document, `Help: ${storeBusiness.supportEmail}`, x + 8, y + 8, CONTENT_WIDTH / 2, { bold: true, size: 6.5, color: COLORS.green });
  value(document, `Invoice: ${invoice.number}`, x + (CONTENT_WIDTH / 2), y + 8, 180, { size: 6.2, align: 'right' });
}

function addContinuationPage(document, invoice, includeTableHeader = true) {
  document.addPage();
  const y = drawBrandHeader(document, invoice, true) + 12;
  return includeTableHeader ? drawTableHeader(document, y) : y;
}

function addPageNumbers(document) {
  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    setText(document, { size: 5.8, color: COLORS.muted })
      .text(`Page ${index - range.start + 1} of ${range.count}`, PAGE.width - PAGE.margin - 75, PAGE.height - 62, { width: 75, align: 'right', lineBreak: false });
  }
}

export function streamInvoicePdf(order, response) {
  const invoice = order.invoice || buildInvoice(order);
  const lines = invoiceLineItems(order);
  const totals = invoiceTotals(order, lines);
  const document = new PDFDocument({
    size: 'A4',
    margin: PAGE.margin,
    bufferPages: true,
    info: {
      Title: invoice.number,
      Author: storeBusiness.legalName,
      Subject: `Tax invoice for ${order.orderNumber}`,
    },
  });
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Disposition', `attachment; filename="${invoice.number}.pdf"`);
  response.setHeader('Cache-Control', 'private, no-store');
  document.pipe(response);

  let y = drawBrandHeader(document, invoice);
  y = drawFirstPageDetails(document, order, invoice, y);
  y = drawTableHeader(document, y);
  for (const line of lines) {
    const rowHeight = tableRowHeight(document, line);
    if (y + rowHeight > PAGE.height - 72) y = addContinuationPage(document, invoice, true);
    y = drawTableRow(document, line, y, rowHeight);
  }
  if (y + 24 > PAGE.height - 72) y = addContinuationPage(document, invoice, true);
  y = drawTableTotal(document, totals, y);

  if (y + 274 > PAGE.height - 32) y = addContinuationPage(document, invoice, false);
  drawFinalSections(document, order, invoice, totals, y);
  addPageNumbers(document);
  document.end();
}
