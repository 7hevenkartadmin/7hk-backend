import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { calculateCartTotals } from '../src/modules/orders/pricing.service.js';
import { invoiceLineItems, invoiceTotals, buildInvoice } from '../src/modules/orders/invoice.service.js';
import { creditNoteLines, csv, financialYearForDate, invoiceSeries, reportDateRange, sequentialInvoiceNumber, summarizeTaxDocuments, taxChecksum, taxDocumentVerified } from '../src/modules/taxes/tax.domain.js';
import { TaxDocument, GstFiling, GstFilingEvent, TaxClassification } from '../src/modules/taxes/tax.model.js';
import { Order } from '../src/modules/orders/order.model.js';
import { nextTaxNumber } from '../src/modules/taxes/tax.service.js';
import { classificationSchema, creditNoteSchema, prepareFilingSchema, taxQuerySchema } from '../src/modules/taxes/tax.validation.js';
import { exportTaxWorkpaper } from '../src/modules/taxes/tax.export.js';
import { createTestClient } from './helpers/http.js';
import { User } from '../src/modules/users/user.model.js';
import { signAccessToken } from '../src/modules/auth/token.service.js';

function fixture({ kind = 'INVOICE', issuedAt = '2026-10-10T08:43:00.000Z', number = 'I/2627/10/000001', original = null, gstAdjustment = true } = {}) {
  const items = [{ product: new mongoose.Types.ObjectId(), name: 'Ruskit Gold', sku: 'SKU-1', unit: '180 g', hsnCode: '19054000', price: 38, mrp: 40, quantity: 1, taxRate: 5 }, { product: new mongoose.Types.ObjectId(), name: 'Noodles', sku: 'SKU-2', unit: '280 g', hsnCode: '1902', price: 55, mrp: 58, quantity: 1, taxRate: 12 }];
  const order = { _id: new mongoose.Types.ObjectId(), customer: new mongoose.Types.ObjectId(), items, ...calculateCartTotals({ items, deliveryFee: 20 }), paymentMethod: 'cod', orderNumber: 'ORD-TEST', address: { state: 'Bihar' } };
  const lines = invoiceLineItems(order); lines.at(-1).hsnCode = '1902';
  const envelope = { kind, number, issuerGstin: '10IOFPK5192L1ZO', issuedAt, period: '2026-10', financialYear: '2026-27', series: number.slice(0, -7), sequence: 1, order: String(order._id), original, eventKey: 'fixture', source: 'issued' };
  const content = { document: envelope, order, invoice: { number, issuedAt }, seller: { gstin: envelope.issuerGstin }, lines, totals: invoiceTotals(order, lines), placeOfSupplyCode: '10', gstAdjustment };
  return { _id: new mongoose.Types.ObjectId(), ...envelope, content, checksum: taxChecksum(content) };
}

test('financial-year invoice series respect IST, April rollover and the 16-character limit', () => {
  assert.equal(financialYearForDate('2026-03-31T18:29:59Z'), '2025-26');
  assert.equal(financialYearForDate('2026-03-31T18:30:00Z'), '2026-27');
  const march = invoiceSeries('2026-03-31T18:29:59Z');
  const april = invoiceSeries('2026-03-31T18:30:00Z');
  assert.equal(sequentialInvoiceNumber(march.series, 1), 'I/2526/03/000001');
  assert.equal(sequentialInvoiceNumber(april.series, 1), 'I/2627/04/000001');
  assert.equal(sequentialInvoiceNumber(invoiceSeries('2026-10-01', 'CREDIT_NOTE').series, 1), 'C/2627/10/000001');
  assert.equal(sequentialInvoiceNumber(april.series, 999999).length, 16);
  for (const number of [0, -1, 1.5, 1000000]) assert.throws(() => sequentialInvoiceNumber(april.series, number), /exhausted/);
});

test('GST periods include whole India days and reject malformed or ambiguous ranges', () => {
  const month = reportDateRange({ period: '2028-02' });
  assert.equal(month.start.toISOString(), '2028-01-31T18:30:00.000Z');
  assert.equal(month.end.toISOString(), '2028-02-29T18:30:00.000Z');
  assert.equal(month.to, '2028-02-29');
  assert.equal(reportDateRange({ financialYear: '2026-27' }).to, '2027-03-31');
  for (const query of [{ period: '2026-13' }, { from: '2026-02-30' }, { from: '2026-10-02', to: '2026-10-01' }, { from: '2020-01-01', to: '2026-01-01' }, { financialYear: '2026-29' }]) assert.throws(() => reportDateRange(query));
  assert.equal(taxQuerySchema.safeParse({ period: '2026-10', financialYear: '2026-27' }).success, false);
});

test('ledger reports reconcile tax-inclusive product and delivery amounts in integer paise', () => {
  const doc = fixture();
  const report = summarizeTaxDocuments([doc], reportDateRange({ period: '2026-10' }));
  assert.equal(report.summary.tax, 9.84);
  assert.equal(report.summary.gross, 113);
  assert.equal(report.summary.taxableValue, 103.16);
  assert.equal(report.summary.productTax, 7.70);
  assert.equal(report.summary.deliveryTax, 2.14);
  assert.equal(report.daily[0].tax, report.monthly[0].tax);
  assert.equal(Math.round(report.hsn.reduce((sum, row) => sum + row.tax, 0) * 100), 984);
  assert.equal(report.b2cs.find((row) => row.taxRate === 12).gross, 75);
  assert.equal(report.documentsIssued[0].issued, 1);
});

test('partial credit notes preserve recorded tax and prevent over-crediting in quantity or money', () => {
  const doc = fixture();
  const first = creditNoteLines(doc, [{ lineIndex: 0, amount: 10, quantity: 0 }]);
  const remaining = creditNoteLines(doc, [{ lineIndex: 0, amount: 28, quantity: 1 }], [{ content: { lines: first } }]);
  assert.equal(Math.round((first[0].taxAmount + remaining[0].taxAmount) * 100), 181);
  assert.equal(Math.round((first[0].cgstAmount + remaining[0].cgstAmount) * 100), 91);
  assert.equal(Math.round((first[0].sgstAmount + remaining[0].sgstAmount) * 100), 90);
  assert.throws(() => creditNoteLines(doc, [{ lineIndex: 0, amount: 39 }]), /exceeds/);
  assert.throws(() => creditNoteLines(doc, [{ lineIndex: 0, amount: 38, quantity: 2 }]), /quantity/);
  assert.throws(() => creditNoteLines(doc, [{ lineIndex: 0, amount: 10 }, { lineIndex: 0, amount: 10 }]), /once/);
});

test('linked GST credits reduce output tax while commercial credits keep GST unchanged', () => {
  const invoice = fixture();
  const credit = fixture({ kind: 'CREDIT_NOTE', number: 'C/2627/10/000001', original: String(invoice._id) });
  const adjusted = summarizeTaxDocuments([invoice, credit], reportDateRange({ period: '2026-10' }));
  assert.equal(adjusted.summary.tax, 0);
  assert.equal(adjusted.summary.gross, 0);
  credit.content.gstAdjustment = false; credit.checksum = taxChecksum(credit.content);
  const commercial = summarizeTaxDocuments([invoice, credit], reportDateRange({ period: '2026-10' }));
  assert.equal(commercial.summary.tax, 9.84);
  assert.equal(commercial.summary.commercialCredits, 1);
  assert.equal(commercial.documentsIssued.length, 2);
  assert.equal(commercial.daily[0].creditNotes, 1);
});

test('checksum verification detects financial and indexed metadata tampering', () => {
  const doc = fixture();
  assert.equal(taxDocumentVerified(doc), true);
  doc.content.totals.tax = 1;
  assert.throws(() => summarizeTaxDocuments([doc], reportDateRange({ period: '2026-10' })), /Integrity/);
  const indexTamper = fixture(); indexTamper.number = 'I/2627/10/000099';
  assert.equal(taxDocumentVerified(indexTamper), false);
  assert.equal(taxChecksum({ b: 2, a: 1 }), taxChecksum({ a: 1, b: 2 }));
});

test('historical amount discrepancies are visible and cannot silently become filing totals', () => {
  const doc = fixture(); doc.content.totals.grandTotal = 120; doc.checksum = taxChecksum(doc.content);
  const report = summarizeTaxDocuments([doc], reportDateRange({ period: '2026-10' }));
  assert.equal(report.summary.gross, 120);
  assert.equal(report.issues.some((issue) => issue.code === 'TOTAL_RECONCILIATION'), true);
});

test('filing classification evidence resolves HSN without mutating the source invoice', () => {
  const doc = fixture(); doc.content.lines[0].hsnCode = ''; doc.checksum = taxChecksum(doc.content);
  const before = JSON.stringify(doc);
  const evidence = { document: doc._id, lineIndex: 0, createdAt: new Date(), content: { documentId: String(doc._id), lineIndex: 0, createdAt: new Date().toISOString(), hsnCode: '19054000', uqc: 'NOS' } };
  evidence.content.createdAt = evidence.createdAt.toISOString();
  evidence.checksum = taxChecksum(evidence.content);
  const report = summarizeTaxDocuments([doc], reportDateRange({ period: '2026-10' }), [evidence]);
  assert.equal(report.issues.some((issue) => issue.code === 'HSN_MISSING'), false);
  assert.equal(JSON.stringify(doc), before);
});

test('tax models reject updates, deletion and bulk mutation before database access', async () => {
  for (const model of [TaxDocument, GstFiling, GstFilingEvent, TaxClassification]) {
    await assert.rejects(model.updateOne({}, { $set: { period: '2026-09' } }), { code: 'TAX_RECORD_IMMUTABLE' });
    await assert.rejects(model.deleteMany({}), { code: 'TAX_RECORD_IMMUTABLE' });
    await assert.rejects(model.bulkWrite([{ deleteOne: { filter: {} } }]), { code: 'TAX_RECORD_IMMUTABLE' });
  }
});

test('issued order amounts cannot be changed through document saves, updates or renames', async () => {
  const doc = fixture();
  const order = Order.hydrate({ ...doc.content.order, invoice: { number: doc.number, issuedAt: doc.issuedAt } });
  order.tax = 1;
  await assert.rejects(order.save(), { code: 'INVOICE_IMMUTABLE' });
  await assert.rejects(Order.updateOne({}, { $set: { tax: 1 } }), { code: 'INVOICE_IMMUTABLE' });
  await assert.rejects(Order.updateOne({}, { $rename: { other: 'total' } }), { code: 'INVOICE_IMMUTABLE' });
});

test('invoice numbers cannot be allocated outside a transaction or fabricated on download', async () => {
  await assert.rejects(nextTaxNumber(new Date(), 'INVOICE', null), { code: 'TAX_TRANSACTION_REQUIRED' });
  assert.throws(() => buildInvoice({ orderNumber: 'ORD-TEST' }), { code: 'INVOICE_NOT_ISSUED' });
});

test('filing and credit validation require explicit review and exact paise', () => {
  assert.equal(prepareFilingSchema.safeParse({ period: '2026-10', reviewed: false, reviewNotes: 'Reviewed return' }).success, false);
  assert.equal(creditNoteSchema.safeParse({ reason: 'Returned goods', gstAdjustment: true, eligibilityConfirmed: true, idempotencyKey: '714d1542-c02e-49a2-8b1e-81ecafeb2d35', lines: [{ lineIndex: 0, amount: 1.001 }] }).success, false);
  assert.equal(classificationSchema.safeParse({ lineIndex: 0, hsnCode: '0101', uqc: 'NOS', reason: 'Supplier invoice reviewed', idempotencyKey: '714d1542-c02e-49a2-8b1e-81ecafeb2d35' }).success, true);
});

test('GST CSV exports are escaped, spreadsheet-safe and based on recorded amounts', () => {
  assert.match(csv([{ value: '=HYPERLINK("bad")' }], [['Value', 'value']]), /'=HYPERLINK/);
  const doc = fixture();
  const report = summarizeTaxDocuments([doc], reportDateRange({ period: '2026-10' }));
  const register = exportTaxWorkpaper('register', report, [doc]);
  assert.match(register.body, /I\/2627\/10\/000001/);
  assert.match(register.body, /"9.84","113"/);
  assert.equal(exportTaxWorkpaper('json', report, [doc]).extension, 'json');
  assert.equal(exportTaxWorkpaper('invalid', report), null);
});

test('tax records, exports and filing actions reject unauthenticated requests', async (t) => {
  const client = await createTestClient(); t.after(() => client.close());
  for (const path of ['/taxes/report', '/taxes/documents', '/taxes/export/register', '/taxes/filings']) {
    const { response } = await client.request(`/api/v1${path}`);
    assert.equal(response.status, 401);
  }
  const { response } = await client.request('/api/v1/taxes/filings', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(response.status, 401);
});

test('administrators cannot seal filings, issue credits or change classification evidence', async (t) => {
  const client = await createTestClient(); t.after(() => client.close());
  const user = { id: String(new mongoose.Types.ObjectId()), role: 'admin', tokenVersion: 0, status: 'active', staffSeat: 'PRIMARY_ADMIN', assignmentExpiresAt: new Date(Date.now() + 86400000) };
  t.mock.method(User, 'findById', async () => user);
  const authorization = `Bearer ${signAccessToken(user)}`;
  const id = String(new mongoose.Types.ObjectId());
  for (const path of ['/taxes/filings', `/taxes/filings/${id}/acknowledgements`, `/taxes/documents/${id}/credit-notes`, `/taxes/documents/${id}/classifications`]) {
    const { response } = await client.request(`/api/v1${path}`, { method: 'POST', headers: { authorization }, body: '{}' });
    assert.equal(response.status, 403);
  }
});
