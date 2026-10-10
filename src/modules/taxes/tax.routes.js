import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, authorize } from '../auth/auth.middleware.js';
import { audit } from '../audit/audit.service.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { ok, created } from '../../shared/utils/apiResponse.js';
import { validate } from '../../shared/validation/validate.js';
import { AppError } from '../../shared/utils/AppError.js';
import { TaxDocument, GstFiling, GstFilingEvent, TaxClassification } from './tax.model.js';
import { filingDocuments, getGstFiling, issueCreditNote, loadTaxReport, prepareGstFiling, primeTaxSeries, recordPortalFiling, recordTaxClassification } from './tax.service.js';
import { reportDateRange, taxDocumentVerified, taxClassificationVerified, filingEventVerified, gstFilingVerified } from './tax.domain.js';
import { classificationSchema, creditNoteSchema, portalFilingSchema, prepareFilingSchema, taxIdSchema, taxQuerySchema } from './tax.validation.js';
import { exportTaxWorkpaper } from './tax.export.js';
import { streamInvoicePdf } from '../orders/invoice.service.js';
import { env } from '../../config/env.js';

export const taxRoutes = Router();
taxRoutes.use(requireAuth, authorize('admin', 'manager', 'owner'));
taxRoutes.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
taxRoutes.get('/report', validate(taxQuerySchema, 'query'), asyncHandler(async (req, res) => {
  const { report } = await loadTaxReport(req.query);
  ok(res, report, 'GST outward-supply report loaded');
}));

taxRoutes.get('/documents', validate(taxQuerySchema, 'query'), asyncHandler(async (req, res) => {
  const range = reportDateRange(req.query);
  const filter = { issuedAt: { $gte: range.start, $lt: range.end } };
  if (req.query.kind) filter.kind = req.query.kind;
  if (req.query.search) {
    const search = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: search }, { 'content.order.orderNumber': search }];
  }
  const { page, limit } = req.query;
  const [documents, total] = await Promise.all([TaxDocument.find(filter).sort({ issuedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), TaxDocument.countDocuments(filter)]);
  ok(res, { items: documents.map((doc) => ({ id: doc._id, kind: doc.kind, number: doc.number, issuedAt: doc.issuedAt, orderNumber: doc.content.order.orderNumber, totals: doc.content.totals, source: doc.source, gstAdjustment: doc.content.gstAdjustment, checksum: doc.checksum, integrityVerified: taxDocumentVerified(doc) })), meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } }, 'Tax register loaded');
}));

async function sendExport(req, res, report, documents) {
  const file = exportTaxWorkpaper(req.params.type, report, documents);
  if (!file) throw new AppError('Unknown GST workpaper export.', 422, 'GST_EXPORT_INVALID');
  await audit({ req, action: 'tax.export', entityType: 'TaxReport', entityId: req.params.id || `${report.range.from}:${report.range.to}`, after: { type: req.params.type, documents: documents.length } });
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', `attachment; filename="gst-${report.range.from}-${report.range.to}-${req.params.type}.${file.extension}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file.body);
}
taxRoutes.get('/export/:type', validate(taxQuerySchema, 'query'), asyncHandler(async (req, res) => {
  const { report, documents } = await loadTaxReport(req.query);
  await sendExport(req, res, report, documents);
}));

// Keep the owner filing workflow unavailable until launch, including direct API calls.
const requireGstFilingEnabled = (_req, _res, next) => {
  if (!env.GST_FILING_ENABLED) return next(new AppError('GST filing is currently unavailable.', 404, 'GST_FILING_DISABLED'));
  return next();
};
taxRoutes.use('/filings', requireGstFilingEnabled);

taxRoutes.get('/filings', validate(taxQuerySchema, 'query'), asyncHandler(async (req, res) => {
  const range = reportDateRange(req.query);
  const filter = { period: { $gte: range.from.slice(0, 7), $lte: range.to.slice(0, 7) } };
  const filings = await GstFiling.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  const events = await GstFilingEvent.find({ filing: { $in: filings.map((filing) => filing._id) } }).lean();
  if (events.some((event) => !filingEventVerified(event))) throw new AppError('Filing acknowledgement integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
  ok(res, { items: filings.map((filing) => ({ id: filing._id, period: filing.period, createdAt: filing.createdAt, summary: filing.content.report.summary, checksum: filing.checksum, integrityVerified: gstFilingVerified(filing), acknowledgements: events.filter((event) => String(event.filing) === String(filing._id)) })) }, 'Immutable filing snapshots loaded');
}));
taxRoutes.post('/filings', authorize('owner'), validate(prepareFilingSchema), asyncHandler(async (req, res) => {
  const filing = await prepareGstFiling(req.body, req.user);
  await audit({ req, action: 'tax.filing.prepare', entityType: 'GstFiling', entityId: filing._id, after: { period: filing.period, checksum: filing.checksum } });
  created(res, { filing }, 'GST filing snapshot sealed');
}));
taxRoutes.get('/filings/:id/export/:type', validate(taxIdSchema, 'params'), asyncHandler(async (req, res) => {
  const filing = await getGstFiling(req.params.id);
  await sendExport(req, res, filing.content.report, await filingDocuments(filing));
}));
taxRoutes.post('/filings/:id/acknowledgements', authorize('owner'), validate(taxIdSchema, 'params'), validate(portalFilingSchema), asyncHandler(async (req, res) => {
  const acknowledgement = await recordPortalFiling(req.params.id, req.body, req.user);
  await audit({ req, action: 'tax.filing.acknowledge', entityType: 'GstFiling', entityId: req.params.id, after: acknowledgement });
  created(res, { acknowledgement }, 'External GST filing acknowledgement recorded');
}));
taxRoutes.get('/documents/:id', validate(taxIdSchema, 'params'), asyncHandler(async (req, res) => {
  const document = await TaxDocument.findById(req.params.id).lean();
  if (!document) throw new AppError('Tax document not found.', 404, 'TAX_DOCUMENT_NOT_FOUND');
  if (!taxDocumentVerified(document)) throw new AppError('Document integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
  const credits = await TaxDocument.find({ original: document._id }).lean();
  const classifications = await TaxClassification.find({ document: document._id }).sort({ createdAt: -1, _id: -1 }).lean();
  if (credits.some((entry) => !taxDocumentVerified(entry)) || classifications.some((entry) => !taxClassificationVerified(entry))) throw new AppError('Linked tax record integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
  ok(res, { document, credits, classifications }, 'Immutable tax document loaded');
}));
taxRoutes.get('/documents/:id/pdf', validate(taxIdSchema, 'params'), asyncHandler(async (req, res) => {
  const document = await TaxDocument.findById(req.params.id).lean();
  if (!document) throw new AppError('Tax document not found.', 404, 'TAX_DOCUMENT_NOT_FOUND');
  if (!taxDocumentVerified(document)) throw new AppError('Document integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
  const presentation = JSON.parse(JSON.stringify(document.content));
  if (document.kind === 'CREDIT_NOTE') {
    presentation.order = { ...presentation.order, documentType: presentation.documentClass, creditReason: presentation.reason, gstAdjustment: presentation.gstAdjustment, subtotal: presentation.lines.filter((line) => !line.isDelivery).reduce((sum, line) => sum + line.lineTotal, 0), deliveryFee: presentation.totals.deliveryFee, deliveryTax: presentation.lines.filter((line) => line.isDelivery).reduce((sum, line) => sum + line.taxAmount, 0), discount: 0 };
  }
  streamInvoicePdf(presentation.order, res, presentation);
}));
taxRoutes.post('/documents/:id/credit-notes', authorize('owner'), requireGstFilingEnabled, validate(taxIdSchema, 'params'), validate(creditNoteSchema), asyncHandler(async (req, res) => {
  await primeTaxSeries();
  const session = await mongoose.startSession();
  let document;
  try {
    await session.withTransaction(async () => {
      const original = await TaxDocument.findById(req.params.id).session(session);
      if (!original || original.kind !== 'INVOICE') throw new AppError('Original invoice not found.', 404, 'TAX_DOCUMENT_NOT_FOUND');
      document = await issueCreditNote(original, req.body, req.user, session);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally { await session.endSession(); }
  await audit({ req, action: 'tax.credit_note.issue', entityType: 'TaxDocument', entityId: document._id, after: { number: document.number, original: req.params.id, checksum: document.checksum } });
  created(res, { document }, 'Linked credit note issued');
}));
taxRoutes.post('/documents/:id/classifications', authorize('owner'), requireGstFilingEnabled, validate(taxIdSchema, 'params'), validate(classificationSchema), asyncHandler(async (req, res) => {
  const document = await TaxDocument.findById(req.params.id).lean();
  if (!document) throw new AppError('Tax document not found.', 404, 'TAX_DOCUMENT_NOT_FOUND');
  const classification = await recordTaxClassification(document, req.body, req.user);
  await audit({ req, action: 'tax.classification.record', entityType: 'TaxDocument', entityId: document._id, after: classification.content });
  created(res, { classification }, 'Filing classification appended; original invoice unchanged');
}));
