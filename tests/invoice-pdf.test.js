import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  amountInWords,
  invoiceLineItems,
  invoiceTotals,
  streamInvoicePdf,
} from '../src/modules/orders/invoice.service.js';

function sampleOrder() {
  return {
    _id: '68a000000000000000000101',
    id: '68a000000000000000000101',
    orderNumber: 'ORD-INVOICE01',
    createdAt: new Date('2026-09-01T04:15:00.000Z'),
    invoice: {
      number: 'INV-2026-ORD-INVOICE01',
      issuedAt: new Date('2026-09-01T04:15:00.000Z'),
    },
    customerSnapshot: { name: 'Abhishek Kumar', phone: '9876543210' },
    address: {
      recipientName: 'Abhishek Kumar',
      phone: '9876543210',
      line1: 'Floor 3, Gijeskes',
      line2: 'PMRX+F3R',
      landmark: 'Near Parihar Market',
      city: 'Parihar',
      state: 'Bihar',
      pincode: '843324',
    },
    items: [
      { name: 'Kurkure Masala Munch', sku: 'SNK-001', unit: '90 g', quantity: 1, price: 20, mrp: 25, taxRate: 5 },
      { name: 'Premium Grocery Product', sku: 'GRO-002', unit: '1 kg', quantity: 2, price: 40, mrp: 50, taxRate: 12 },
    ],
    subtotal: 100,
    tax: 10.6,
    deliveryFee: 30,
    discount: 5,
    couponCode: 'SAVE5',
    total: 135.6,
    paymentMethod: 'razorpay',
    paymentStatus: 'paid',
  };
}

test('invoice line calculations use persisted order tax and split it exactly across CGST and SGST', () => {
  const order = sampleOrder();
  const lines = invoiceLineItems(order);
  const totals = invoiceTotals(order, lines);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].discount, 5);
  assert.equal(lines[0].cgstAmount + lines[0].sgstAmount, lines[0].taxAmount);
  assert.equal(lines[1].cgstAmount + lines[1].sgstAmount, lines[1].taxAmount);
  assert.deepEqual(totals, {
    itemQuantity: 3,
    productMrp: 125,
    productDiscount: 25,
    taxableValue: 100,
    cgst: 5.3,
    sgst: 5.3,
    tax: 10.6,
    deliveryFee: 30,
    couponDiscount: 5,
    grandTotal: 135.6,
  });
});

test('invoice amount in words follows Indian numbering and preserves paise', () => {
  assert.equal(amountInWords(0), 'Zero Rupees Only');
  assert.equal(amountInWords(1), 'One Rupee Only');
  assert.equal(amountInWords(43.88), 'Forty-Three Rupees and Eighty-Eight Paise Only');
  assert.equal(amountInWords(12_34_567.05), 'Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven Rupees and Five Paise Only');
});

test('customer invoice download streams a private A4 PDF with a stable filename', async () => {
  const output = new PassThrough();
  const headers = {};
  const chunks = [];
  output.setHeader = (name, value) => { headers[name] = value; };
  output.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    output.on('finish', resolve);
    output.on('error', reject);
  });

  streamInvoicePdf(sampleOrder(), output);
  await finished;
  const pdf = Buffer.concat(chunks);
  assert.equal(headers['Content-Type'], 'application/pdf');
  assert.equal(headers['Content-Disposition'], 'attachment; filename="INV-2026-ORD-INVOICE01.pdf"');
  assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.equal(pdf.subarray(0, 8).toString('ascii').startsWith('%PDF-'), true);
  assert.ok(pdf.length > 5_000);
});
