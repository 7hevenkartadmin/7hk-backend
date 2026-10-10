import mongoose from 'mongoose';
import { AppError } from '../../shared/utils/AppError.js';
import { taxChecksum } from './tax.domain.js';

export function appendOnly(schema) {
  schema.pre('save', function () {
    if (!this.isNew) throw new AppError('Tax records are immutable. Record a linked correction instead.', 409, 'TAX_RECORD_IMMUTABLE');
  });
  for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'bulkWrite']) {
    schema.pre(operation, function () { throw new AppError('Tax records cannot be changed or deleted.', 409, 'TAX_RECORD_IMMUTABLE'); });
  }
  schema.pre('deleteOne', { document: true, query: false }, function () { throw new AppError('Tax records cannot be deleted.', 409, 'TAX_RECORD_IMMUTABLE'); });
  schema.pre('validate', function () {
    if (this.isNew && this.content && taxChecksum(this.content) !== this.checksum) throw new AppError('Invalid tax record integrity checksum.', 422, 'TAX_CHECKSUM_INVALID');
  });
}

const documentSchema = new mongoose.Schema({
  eventKey: { type: String, required: true },
  kind: { type: String, enum: ['INVOICE', 'CREDIT_NOTE'], required: true },
  number: { type: String, required: true },
  issuerGstin: { type: String, required: true },
  issuedAt: { type: Date, required: true },
  period: { type: String, required: true },
  financialYear: { type: String, required: true },
  series: String,
  sequence: Number,
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  original: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxDocument' },
  source: { type: String, enum: ['issued', 'legacy_import'], required: true },
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  checksum: { type: String, required: true },
  recordedAt: { type: Date, default: Date.now, immutable: true },
}, { versionKey: false });
documentSchema.index({ eventKey: 1 }, { unique: true, name: 'tax_document_event_unique' });
documentSchema.index({ issuerGstin: 1, financialYear: 1, number: 1 }, { unique: true, name: 'tax_document_number_unique' });
documentSchema.index({ kind: 1, order: 1 }, { unique: true, partialFilterExpression: { kind: 'INVOICE' }, name: 'tax_order_invoice_unique' });
documentSchema.index({ issuedAt: 1, _id: 1 }, { name: 'tax_document_date' });
documentSchema.index({ original: 1 }, { name: 'tax_document_original' });
appendOnly(documentSchema);

const counterSchema = new mongoose.Schema({ _id: String, sequence: { type: Number, default: 0 } }, { versionKey: false });

const filingSchema = new mongoose.Schema({
  period: { type: String, required: true },
  preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  checksum: { type: String, required: true },
}, { versionKey: false });
filingSchema.index({ period: 1, createdAt: -1 }, { name: 'gst_filing_period' });
appendOnly(filingSchema);

const filingEventSchema = new mongoose.Schema({
  filing: { type: mongoose.Schema.Types.ObjectId, ref: 'GstFiling', required: true },
  period: { type: String, required: true },
  returnType: { type: String, enum: ['GSTR1', 'GSTR3B'], required: true },
  arn: { type: String, required: true },
  filedAt: { type: Date, required: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recordedAt: { type: Date, default: Date.now },
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  checksum: { type: String, required: true },
}, { versionKey: false });
filingEventSchema.index({ filing: 1, returnType: 1 }, { unique: true, name: 'gst_filing_return_unique' });
filingEventSchema.index({ period: 1, returnType: 1 }, { unique: true, name: 'gst_period_return_unique' });
appendOnly(filingEventSchema);

export const TaxDocument = mongoose.model('TaxDocument', documentSchema);
export const InvoiceCounter = mongoose.model('InvoiceCounter', counterSchema);
export const GstFiling = mongoose.model('GstFiling', filingSchema);
export const GstFilingEvent = mongoose.model('GstFilingEvent', filingEventSchema);

const classificationSchema = new mongoose.Schema({
  document: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxDocument', required: true },
  lineIndex: { type: Number, required: true },
  eventKey: { type: String, required: true },
  createdAt: { type: Date, required: true },
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  checksum: { type: String, required: true },
}, { versionKey: false });
classificationSchema.index({ eventKey: 1 }, { unique: true, name: 'tax_classification_event_unique' });
classificationSchema.index({ document: 1, createdAt: -1 }, { name: 'tax_classification_document', unique: false });
appendOnly(classificationSchema);
export const TaxClassification = mongoose.model('TaxClassification', classificationSchema);
