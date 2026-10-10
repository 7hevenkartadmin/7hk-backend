import PDFDocument from 'pdfkit';
import { storeBusiness } from '../../config/store.js';
import { AppError } from '../../shared/utils/AppError.js';
import { deliveryTaxLines } from './pricing.service.js';
import { renderInvoiceDocument } from './invoice-layout.js';

const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const safeText = (value, fallback = '-') => String(value ?? '').trim() || fallback;

export function buildInvoice(order) {
  if (!order.invoice?.number) throw new AppError('This order has no issued invoice. It needs ledger reconciliation before download.', 409, 'INVOICE_NOT_ISSUED');
  return order.invoice;
}

export function invoiceLineItems(order) {
  const lines = (order.items || []).map((item, index) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = roundMoney(item.price);
    const unitMrp = roundMoney(item.mrp ?? item.price);
    const snapshot = [2, 3, 4].includes(order.pricingVersion) ? order.gstLines?.[index] : null;
    const taxableValue = roundMoney(snapshot ? snapshot.taxableValue + (order.pricingVersion >= 3 ? 0 : snapshot.deliveryTaxableValue) : unitPrice * quantity);
    const taxRate = Math.max(0, Number(item.taxRate || 0));
    const taxAmount = roundMoney((order.pricingVersion >= 3 ? snapshot?.productTax : snapshot?.taxAmount) ?? taxableValue * (taxRate / 100));
    return {
      serial: index + 1,
      sku: safeText(item.sku),
      hsnCode: safeText(item.hsnCode),
      unitPrice,
      deliveryTaxableValue: order.pricingVersion >= 3 ? 0 : roundMoney(snapshot?.deliveryTaxableValue),
      allocatedCouponDiscount: roundMoney(snapshot?.couponDiscount),
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

  if (order.pricingVersion === 3) {
    for (const delivery of deliveryTaxLines(order.gstLines)) {
      lines.push({ ...delivery, serial: lines.length + 1, sku: '-', hsnCode: '', description: `Delivery (GST ${delivery.taxRate}%)`, unit: '', quantity: 0, unitMrp: 0, unitPrice: 0, discount: 0, allocatedCouponDiscount: 0, deliveryTaxableValue: 0, isDelivery: true });
    }
  }
  if (order.pricingVersion === 4 && Number(order.deliveryFee) > 0) {
    const taxRate = Number(order.deliveryTaxRate || 0);
    lines.push({ serial: lines.length + 1, sku: '-', hsnCode: '', description: 'Delivery charge', unit: '', quantity: 0, unitMrp: 0, unitPrice: 0, discount: 0, allocatedCouponDiscount: 0, deliveryTaxableValue: 0, isDelivery: true, taxRate, taxableValue: roundMoney(order.deliveryTaxableValue), taxAmount: roundMoney(order.deliveryTax) });
  }

  if (lines.length > 0) {
    const calculatedTax = roundMoney(lines.reduce((sum, line) => sum + line.taxAmount, 0));
    const trustedTax = roundMoney(order.tax ?? calculatedTax);
    const adjustment = roundMoney(trustedTax - calculatedTax);
    lines[lines.length - 1].taxAmount = roundMoney(lines[lines.length - 1].taxAmount + adjustment);
  }

  let cumulativeTax = 0;
  let cumulativeCgst = 0;
  return lines.map((line) => {
    cumulativeTax = roundMoney(cumulativeTax + line.taxAmount);
    const cgstAmount = order.pricingVersion >= 3
      ? roundMoney(roundMoney(cumulativeTax / 2) - cumulativeCgst)
      : roundMoney(line.taxAmount / 2);
    cumulativeCgst = roundMoney(cumulativeCgst + cgstAmount);
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
  const taxableValue = roundMoney(order.pricingVersion >= 3 ? lines.reduce((sum, line) => sum + line.taxableValue, 0) : order.pricingVersion === 2 ? Number(order.subtotal) - Number(order.discount || 0) + Number(order.deliveryFee || 0) : order.subtotal ?? lines.reduce((sum, line) => sum + line.taxableValue, 0));
  const tax = roundMoney(order.tax ?? lines.reduce((sum, line) => sum + line.taxAmount, 0));
  const cgst = roundMoney(order.cgst ?? tax / 2);
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

export function streamInvoicePdf(order, response, presentation) {
  if (presentation) order = presentation.order;
  const invoice = presentation?.invoice || order.invoice || buildInvoice(order);
  const lines = presentation?.lines || invoiceLineItems(order);
  const totals = presentation?.totals || invoiceTotals(order, lines);
  const seller = presentation?.seller || storeBusiness;
  const document = new PDFDocument({
    size: 'A4',
    margin: 36,
    bufferPages: true,
    info: {
      Title: invoice.number,
      Author: seller.legalName,
      Subject: `Tax invoice for ${order.orderNumber}`,
    },
  });
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Disposition', `attachment; filename="${invoice.number.replaceAll('/', '-')}.pdf"`);
  response.setHeader('Cache-Control', 'private, no-store');
  document.pipe(response);

  renderInvoiceDocument(document, order, invoice, lines, totals, amountInWords, seller);
  document.end();
}
