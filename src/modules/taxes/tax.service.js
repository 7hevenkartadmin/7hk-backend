import mongoose from 'mongoose';
import { TaxDocument, InvoiceCounter, GstFiling, GstFilingEvent, TaxClassification } from './tax.model.js';
import { creditNoteLines, financialYearForDate, invoiceSeries, paise, reportDateRange, rupees, sequentialInvoiceNumber, summarizeTaxDocuments, taxChecksum, taxDocumentVerified, taxClassificationVerified, gstFilingVerified } from './tax.domain.js';
import { invoiceLineItems, invoiceTotals } from '../orders/invoice.service.js';
import { Order } from '../orders/order.model.js';
import { storeBusiness } from '../../config/store.js';
import { storeDateKey } from '../../shared/utils/storeDate.js';
import { AppError } from '../../shared/utils/AppError.js';

const plain = (value) => JSON.parse(JSON.stringify(value));
const stateCodes = { bihar: '10', 'uttar pradesh': '09', jharkhand: '20', 'west bengal': '19', delhi: '07', maharashtra: '27', gujarat: '24', rajasthan: '08', punjab: '03', haryana: '06', 'madhya pradesh': '23', chhattisgarh: '22', odisha: '21', assam: '18', sikkim: '11', 'arunachal pradesh': '12', nagaland: '13', manipur: '14', mizoram: '15', tripura: '16', meghalaya: '17', karnataka: '29', kerala: '32', 'tamil nadu': '33', telangana: '36', 'andhra pradesh': '37', goa: '30', puducherry: '34', uttarakhand: '05', 'himachal pradesh': '02', 'jammu and kashmir': '01', ladakh: '38', chandigarh: '04', lakshadweep: '31', 'andaman and nicobar islands': '35', 'dadra and nagar haveli and daman and diu': '26' };

export async function nextTaxNumber(issuedAt, kind, session) {
  if (!session?.inTransaction()) throw new AppError('Invoice issuance requires a database transaction.', 503, 'TAX_TRANSACTION_REQUIRED');
  const series = invoiceSeries(issuedAt, kind, storeBusiness.gstin);
  const counter = await InvoiceCounter.findOneAndUpdate({ _id: series.key }, { $inc: { sequence: 1 } }, { upsert: true, new: true, session });
  return { ...series, sequence: counter.sequence, number: sequentialInvoiceNumber(series.series, counter.sequence) };
}

export async function primeTaxSeries(date = new Date()) {
  for (const kind of ['INVOICE', 'CREDIT_NOTE', 'COMMERCIAL_CREDIT_NOTE', 'BILL_OF_SUPPLY', 'INVOICE_CUM_BILL_OF_SUPPLY']) {
    const series = invoiceSeries(date, kind, storeBusiness.gstin);
    try { await InvoiceCounter.updateOne({ _id: series.key }, { $setOnInsert: { sequence: 0 } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
  }
}

function documentClassForOrder(order) {
  const rates = order.items.filter((item) => item.quantity > 0).map((item) => Number(item.taxRate || 0));
  return rates.every((rate) => rate === 0) ? 'BILL_OF_SUPPLY' : rates.some((rate) => rate === 0) ? 'INVOICE_CUM_BILL_OF_SUPPLY' : 'TAX_INVOICE';
}

function snapshot(order, invoice, source) {
  const savedOrder = plain({
    orderNumber: order.orderNumber, createdAt: order.createdAt, invoice,
    customerSnapshot: order.customerSnapshot, address: order.address, items: order.items,
    pricingVersion: order.pricingVersion, subtotal: order.subtotal, discount: order.discount,
    deliveryFee: order.deliveryFee, deliveryTaxRate: order.deliveryTaxRate, deliveryTax: order.deliveryTax,
    productTax: order.productTax, tax: order.tax, total: order.total, couponCode: order.couponCode,
    paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus,
    restrictedProductConsent: order.restrictedProductConsent, documentType: invoice.documentType || 'TAX_INVOICE', taxRecordLocked: true,
  });
  const lines = invoiceLineItems(order);
  if (source === 'issued' && order.pricingVersion === 4) {
    for (const line of lines.filter((entry) => entry.isDelivery)) {
      line.hsnCode = order.items.find((item) => Number(item.taxRate) === line.taxRate && item.quantity > 0)?.hsnCode || '';
    }
  }
  return {
    order: savedOrder, invoice: plain(invoice), seller: plain(storeBusiness), lines, totals: invoiceTotals(order, lines),
    placeOfSupplyCode: stateCodes[String(order.address?.state || '').trim().toLowerCase()] || '',
    supplyType: 'B2C', documentClass: source === 'issued' ? documentClassForOrder(order) : 'TAX_INVOICE', taxPolicy: order.pricingVersion === 4 ? 'highest_cart_rate_delivery' : 'historical_order_snapshot',
  };
}

async function insertDocument({ order, kind, numbering, original, eventKey, source, content }, session) {
  const issuedAt = new Date(content.invoice.issuedAt);
  const base = { kind, number: content.invoice.number, issuerGstin: content.seller.gstin, issuedAt, period: storeDateKey(issuedAt).slice(0, 7), financialYear: financialYearForDate(issuedAt), series: numbering?.series, sequence: numbering?.sequence, order: order._id, original: original?._id, eventKey, source };
  const payload = plain({ ...content, document: { ...base, order: String(order._id), original: original ? String(original._id) : null } });
  const [document] = await TaxDocument.create([{ ...base, content: payload, checksum: taxChecksum(payload) }], { session });
  if (kind === 'INVOICE') await InvoiceCounter.updateOne({ _id: `credit-lock:${document._id}` }, { $setOnInsert: { sequence: 0 } }, { upsert: true, session });
  return document;
}

export async function issueOrderInvoice(order, session) {
  const existing = await TaxDocument.findOne({ eventKey: `invoice:${order._id}` }).session(session);
  if (existing) return { ...existing.content.invoice, documentId: existing._id, checksum: existing.checksum };
  const issuedAt = new Date();
  const documentType = documentClassForOrder(order);
  const numbering = await nextTaxNumber(issuedAt, documentType, session);
  const invoice = { number: numbering.number, issuedAt, documentType, url: `/api/v1/orders/${order._id}/invoice` };
  const document = await insertDocument({ order, kind: 'INVOICE', numbering, eventKey: `invoice:${order._id}`, source: 'issued', content: snapshot(order, invoice, 'issued') }, session);
  return { ...invoice, documentId: document._id, checksum: document.checksum };
}

export async function importLegacyInvoice(order, session) {
  if (!order.invoice?.number || !order.invoice?.issuedAt) return null;
  const existing = await TaxDocument.findOne({ eventKey: `invoice:${order._id}` }).session(session);
  if (existing) return existing;
  return insertDocument({ order, kind: 'INVOICE', eventKey: `invoice:${order._id}`, source: 'legacy_import', content: snapshot(order, order.invoice.toObject?.() || order.invoice, 'legacy_import') }, session);
}

export async function invoicePresentationForOrder(order) {
  const document = await TaxDocument.findOne({ kind: 'INVOICE', order: order._id }).lean();
  if (!document) return null;
  if (!taxDocumentVerified(document)) throw new AppError('Invoice integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
  return document.content;
}

export function creditNoteDeadline(document) {
  return new Date(`${Number(document.financialYear.slice(0, 4)) + 1}-11-30T23:59:59.999+05:30`);
}

export async function issueCreditNote(original, payload, actor, session, { automatic = false } = {}) {
  await InvoiceCounter.findOneAndUpdate({ _id: `credit-lock:${original._id}` }, { $inc: { sequence: 1 } }, { upsert: true, new: true, session });
  const eventKey = automatic ? `cancel:${original.order}` : `credit:${original._id}:${payload.idempotencyKey}`;
  const existing = await TaxDocument.findOne({ eventKey }).session(session);
  if (existing) return existing;
  if (!taxDocumentVerified(original)) throw new AppError('Original invoice integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
  const issuedAt = new Date();
  const previous = await TaxDocument.find({ original: original._id, kind: 'CREDIT_NOTE' }).session(session).lean();
  if (payload.gstAdjustment && issuedAt > creditNoteDeadline(original)) throw new AppError('GST credit-note reporting deadline has passed. Use a commercial credit note and review the return with your accountant.', 409, 'GST_CREDIT_NOTE_DEADLINE');
  const lines = creditNoteLines(original, payload.lines, previous);
  const sum = (field) => rupees(lines.reduce((total, line) => total + paise(line[field]), 0));
  const documentClass = payload.gstAdjustment ? 'CREDIT_NOTE' : 'COMMERCIAL_CREDIT_NOTE';
  const numbering = await nextTaxNumber(issuedAt, documentClass, session);
  const invoice = { number: numbering.number, issuedAt, originalNumber: original.number, originalIssuedAt: original.issuedAt };
  const content = {
    ...plain(original.content), invoice, lines,
    documentClass,
    reason: payload.reason, gstAdjustment: payload.gstAdjustment,
    eligibilityAttestedBy: actor ? String(actor._id) : null, automatic,
    cancellationFee: Number(payload.cancellationFee || 0),
    totals: { ...original.content.totals, itemQuantity: lines.reduce((total, line) => total + line.quantity, 0), taxableValue: sum('taxableValue'), tax: sum('taxAmount'), cgst: sum('cgstAmount'), sgst: sum('sgstAmount'), grandTotal: sum('lineTotal'), couponDiscount: 0, productDiscount: 0, productMrp: 0, deliveryFee: rupees(lines.filter((line) => line.isDelivery).reduce((total, line) => total + paise(line.lineTotal), 0)) },
  };
  return insertDocument({ order: { _id: original.order }, kind: 'CREDIT_NOTE', numbering, original, eventKey, source: 'issued', content }, session);
}

export async function recordOrderCancellation(order, actor, session) {
  if (!order.invoice?.number) return;
  const original = await TaxDocument.findOne({ kind: 'INVOICE', order: order._id }).session(session) || await importLegacyInvoice(order, session);
  if (!original) return;
  // Prior-year annual-return eligibility cannot be inferred from order data.
  if (original.financialYear !== financialYearForDate(new Date())) return;
  const notes = await TaxDocument.find({ original: original._id, kind: 'CREDIT_NOTE' }).session(session).lean();
  const selections = original.content.lines.map((line, lineIndex) => {
    const used = notes.flatMap((note) => note.content.lines).filter((entry) => entry.originalLineIndex === lineIndex);
    return { lineIndex, amount: rupees(paise(line.lineTotal) - used.reduce((sum, entry) => sum + paise(entry.lineTotal), 0)), quantity: line.quantity - used.reduce((sum, entry) => sum + entry.quantity, 0) };
  }).filter((line) => line.amount > 0);
  if (!selections.length) return;
  await issueCreditNote(original, { lines: selections, reason: 'Order cancelled before supply; original invoice retained.', gstAdjustment: new Date() <= creditNoteDeadline(original), cancellationFee: order.refund?.cancellationFeeAmount || 0 }, actor, session, { automatic: true });
}

export async function loadTaxReport(query, { session, asOf = new Date(), references } = {}) {
  const range = reportDateRange(query);
  const filter = references ? { _id: { $in: references.map((entry) => entry.id) } } : { issuedAt: { $gte: range.start, $lt: range.end }, recordedAt: { $lte: asOf } };
  const find = TaxDocument.find(filter).sort({ issuedAt: 1, _id: 1 }).lean();
  if (session) find.session(session);
  const documents = await find;
  const classificationIds = documents.flatMap((document) => [document._id, document.original].filter(Boolean));
  const classifications = await TaxClassification.find({ document: { $in: classificationIds }, createdAt: { $lte: asOf } }).sort({ createdAt: -1, _id: -1 }).session(session || null).lean();
  const report = summarizeTaxDocuments(documents, range, classifications);
  const issuers = new Set(documents.map((document) => document.issuerGstin));
  if (issuers.size > 1) report.issues.push({ code: 'ISSUER_GSTIN', message: 'This period contains more than one seller GSTIN. Reconcile separate returns for each registration.' });
  const ledgerOrderIds = documents.filter((document) => document.kind === 'INVOICE').map((document) => document.order);
  const pendingQuery = Order.find({ _id: { $in: ledgerOrderIds }, $or: [{ status: 'cancelled' }, { 'refund.amount': { $gt: 0 } }, { paymentStatus: { $in: ['partially_refunded', 'refunded', 'cod_refund_approved'] } }] }).select('orderNumber status refund paymentStatus').lean();
  if (session) pendingQuery.session(session);
  const pending = await pendingQuery;
  const credits = await TaxDocument.find({ kind: 'CREDIT_NOTE', order: { $in: ledgerOrderIds }, recordedAt: { $lte: asOf } }).session(session || null).lean();
  const creditedAmounts = new Map();
  for (const credit of credits) {
    if (!taxDocumentVerified(credit)) throw new AppError('Credit note integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
    const key = String(credit.order);
    creditedAmounts.set(key, (creditedAmounts.get(key) || 0) + paise(credit.content.totals.grandTotal));
  }
  for (const order of pending) {
    const original = documents.find((doc) => doc.kind === 'INVOICE' && String(doc.order) === String(order._id));
    const required = order.status === 'cancelled' || order.paymentStatus === 'refunded' ? paise(original.content.totals.grandTotal) : paise(order.refund?.amount);
    if ((creditedAmounts.get(String(order._id)) || 0) < required || (required === 0 && ['partially_refunded', 'cod_refund_approved'].includes(order.paymentStatus))) report.issues.push({ number: order.orderNumber, code: 'REFUND_REVIEW', message: 'Cancellation/refund needs matching linked credit notes. Payment refunds do not automatically reduce GST.' });
  }
  for (const doc of documents) {
    if (!doc.content.placeOfSupplyCode || doc.content.placeOfSupplyCode !== doc.issuerGstin.slice(0, 2)) report.issues.push({ number: doc.number, code: 'PLACE_OF_SUPPLY', message: 'Only local intra-state B2C supplies are supported; review place of supply and IGST.' });
    if (doc.content.lines.some((line) => line.taxRate === 0 && !line.isDelivery)) report.issues.push({ number: doc.number, code: 'ZERO_RATE_REVIEW', message: 'Confirm whether 0% supplies are nil-rated, exempt or non-GST before entering the return.' });
    if (doc.content.cancellationFee > 0) report.issues.push({ number: doc.number, code: 'CANCELLATION_FEE_REVIEW', message: 'Retained cancellation/processing fee needs separate accounting and GST review.' });
  }
  const missing = await Order.countDocuments({ 'invoice.issuedAt': { $gte: range.start, $lt: range.end }, _id: { $nin: ledgerOrderIds }, 'invoice.number': { $exists: true } }).session(session || null);
  if (missing) report.issues.push({ code: 'LEDGER_IMPORT_REQUIRED', message: `${missing} saved invoices have not been imported into the ledger.`, count: missing });
  return { report: { ...report, classificationEvidence: classifications.map((entry) => ({ id: String(entry._id), checksum: entry.checksum, content: entry.content })), generatedAt: asOf.toISOString(), seller: documents[0]?.content.seller || storeBusiness, coverage: { ledgerInvoices: ledgerOrderIds.length, unimportedInvoices: missing }, scope: 'Local B2C outward supplies. Output GST before input-tax credit; not a submitted return.' }, documents };
}

export async function prepareGstFiling(payload, actor) {
  const session = await mongoose.startSession();
  let filing;
  try {
    await session.withTransaction(async () => {
      const range = reportDateRange({ period: payload.period });
      if (range.end > new Date()) throw new AppError('Prepare a filing snapshot after the tax month ends.', 409, 'GST_PERIOD_OPEN');
      const asOf = new Date();
      const { report, documents } = await loadTaxReport({ period: payload.period }, { session, asOf });
      if (report.coverage.unimportedInvoices || report.issues.some((issue) => ['REFUND_REVIEW', 'PLACE_OF_SUPPLY', 'HSN_MISSING', 'TOTAL_RECONCILIATION', 'ISSUER_GSTIN'].includes(issue.code))) throw new AppError('Resolve missing records, classifications, credit notes, amount reconciliation, seller or place-of-supply issues before preparing the filing.', 409, 'GST_FILING_REVIEW_REQUIRED', report.issues);
      const hsnDigits = payload.hsnDigits || 4;
      if (report.hsn.some((entry) => entry.hsnCode.length < hsnDigits)) throw new AppError(`The selected turnover requires at least ${hsnDigits}-digit HSN codes. Append verified classification evidence before sealing.`, 409, 'HSN_DIGITS_REQUIRED');
      const content = plain({ period: payload.period, asOf, report, references: documents.map((doc) => ({ id: String(doc._id), checksum: doc.checksum })), classificationReferences: report.classificationEvidence.map((entry) => ({ id: entry.id, checksum: entry.checksum })), reviewNotes: payload.reviewNotes, reviewedBy: String(actor._id), hsnDigits, deliveryPolicyAcknowledged: true });
      if (Buffer.byteLength(JSON.stringify(content)) > 10_000_000) throw new AppError('This period exceeds the filing snapshot size limit. Contact your accountant to export the ledger in smaller ranges.', 422, 'GST_SNAPSHOT_TOO_LARGE');
      [filing] = await GstFiling.create([{ period: payload.period, preparedBy: actor._id, createdAt: asOf, content, checksum: taxChecksum(content) }], { session });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally { await session.endSession(); }
  return filing;
}

export async function getGstFiling(id) {
  const filing = await GstFiling.findById(id).lean();
  if (!filing) throw new AppError('Filing snapshot not found.', 404, 'GST_FILING_NOT_FOUND');
  if (!gstFilingVerified(filing)) throw new AppError('Filing snapshot integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
  return filing;
}

export async function filingDocuments(filing) {
  const documents = await TaxDocument.find({ _id: { $in: filing.content.references.map((entry) => entry.id) } }).sort({ issuedAt: 1, _id: 1 }).lean();
  const byId = new Map(documents.map((document) => [String(document._id), document]));
  for (const entry of filing.content.references) {
    const doc = byId.get(entry.id);
    if (!doc || doc.checksum !== entry.checksum || !taxDocumentVerified(doc)) throw new AppError('A referenced tax document failed integrity verification.', 409, 'TAX_INTEGRITY_FAILED');
  }
  const classifications = await TaxClassification.find({ _id: { $in: (filing.content.classificationReferences || []).map((entry) => entry.id) } }).lean();
  const classificationMap = new Map(classifications.map((entry) => [String(entry._id), entry]));
  for (const entry of filing.content.classificationReferences || []) {
    const evidence = classificationMap.get(entry.id);
    if (!evidence || evidence.checksum !== entry.checksum || !taxClassificationVerified(evidence)) throw new AppError('Referenced classification evidence failed integrity verification.', 409, 'TAX_INTEGRITY_FAILED');
  }
  return documents;
}

export async function recordPortalFiling(id, payload, actor) {
  const filing = await getGstFiling(id);
  await filingDocuments(filing);
  if (new Date(payload.filedAt) > new Date()) throw new AppError('Filing date cannot be in the future.', 422, 'GST_FILED_DATE_INVALID');
  if (storeDateKey(new Date(payload.filedAt)) <= filing.content.report.range.to) throw new AppError('A return cannot be recorded as filed before its tax period ends.', 422, 'GST_FILED_DATE_INVALID');
  const content = plain({ filing: String(filing._id), period: filing.period, ...payload, filedAt: new Date(payload.filedAt).toISOString(), recordedBy: String(actor._id) });
  try { return await GstFilingEvent.create({ ...content, content, checksum: taxChecksum(content) }); }
  catch (error) {
    if (error.code === 11000) throw new AppError('This return already has an immutable filing acknowledgement.', 409, 'GST_RETURN_ALREADY_RECORDED');
    throw error;
  }
}

export async function recordTaxClassification(document, payload, actor) {
  if (!document.content.lines[payload.lineIndex]) throw new AppError('Invoice line not found.', 422, 'TAX_LINE_NOT_FOUND');
  if (!taxDocumentVerified(document)) throw new AppError('Original document integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
  const eventKey = `classification:${document._id}:${payload.idempotencyKey}`;
  const content = plain({ documentId: String(document._id), originalNumber: document.number, lineIndex: payload.lineIndex, hsnCode: payload.hsnCode, uqc: payload.uqc, reason: payload.reason, recordedBy: String(actor._id), createdAt: new Date() });
  try { return await TaxClassification.create({ document: document._id, lineIndex: payload.lineIndex, eventKey, createdAt: content.createdAt, content, checksum: taxChecksum(content) }); }
  catch (error) { if (error.code === 11000) return TaxClassification.findOne({ eventKey }); throw error; }
}
