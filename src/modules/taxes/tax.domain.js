import { createHash } from 'node:crypto';
import { AppError } from '../../shared/utils/AppError.js';
import { parseStoreDate, storeDateKey } from '../../shared/utils/storeDate.js';

export const paise = (value) => Math.round(Number(value || 0) * 100);
export const rupees = (value) => value / 100;

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const taxChecksum = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function taxDocumentVerified(doc) {
  const envelope = JSON.parse(JSON.stringify({
    kind: doc.kind, number: doc.number, issuerGstin: doc.issuerGstin, issuedAt: doc.issuedAt, period: doc.period,
    financialYear: doc.financialYear, series: doc.series, sequence: doc.sequence, order: String(doc.order),
    original: doc.original ? String(doc.original) : null, eventKey: doc.eventKey, source: doc.source,
  }));
  return taxChecksum(doc.content) === doc.checksum && taxChecksum(envelope) === taxChecksum(doc.content.document);
}
export function taxClassificationVerified(entry) {
  return taxChecksum(entry.content) === entry.checksum
    && String(entry.document) === entry.content.documentId
    && entry.lineIndex === entry.content.lineIndex
    && new Date(entry.createdAt).toISOString() === entry.content.createdAt;
}
export function filingEventVerified(entry) {
  const envelope = { filing: String(entry.filing), period: entry.period, returnType: entry.returnType, arn: entry.arn, filedAt: new Date(entry.filedAt).toISOString(), recordedBy: String(entry.recordedBy) };
  return taxChecksum(entry.content) === entry.checksum && taxChecksum(envelope) === taxChecksum(entry.content);
}
export function gstFilingVerified(filing) {
  return taxChecksum(filing.content) === filing.checksum
    && filing.period === filing.content.period
    && String(filing.preparedBy) === filing.content.reviewedBy
    && new Date(filing.createdAt).toISOString() === filing.content.asOf;
}
export const financialYearForDate = (date) => {
  const key = storeDateKey(new Date(date));
  const year = Number(key.slice(0, 4)) - (Number(key.slice(5, 7)) < 4 ? 1 : 0);
  return `${year}-${String(year + 1).slice(-2)}`;
};

export function invoiceSeries(date, kind = 'INVOICE', gstin = '') {
  const financialYear = financialYearForDate(date);
  const period = storeDateKey(new Date(date)).slice(0, 7);
  const prefix = kind === 'CREDIT_NOTE' ? 'C' : kind === 'COMMERCIAL_CREDIT_NOTE' ? 'F' : kind === 'BILL_OF_SUPPLY' ? 'B' : kind === 'INVOICE_CUM_BILL_OF_SUPPLY' ? 'M' : 'I';
  const series = `${prefix}/${financialYear.slice(2, 4)}${financialYear.slice(-2)}/${period.slice(-2)}`;
  return { financialYear, period, series, key: `${gstin}:${series}` };
}
export function sequentialInvoiceNumber(series, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999999) throw new AppError('This invoice series is exhausted.', 409, 'INVOICE_SERIES_EXHAUSTED');
  return `${series}/${String(sequence).padStart(6, '0')}`;
}

export function reportDateRange({ period, financialYear, from, to } = {}, now = new Date()) {
  if (period) {
    const start = parseStoreDate(`${period}-01`);
    if (!start) throw new AppError('Choose a valid GST month.', 422, 'TAX_PERIOD_INVALID');
    const year = Number(period.slice(0, 4));
    const month = Number(period.slice(5, 7));
    const next = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
    return { from: `${period}-01`, to: storeDateKey(new Date(parseStoreDate(next).start.getTime() - 1)), start: start.start, end: parseStoreDate(next).start };
  }
  if (financialYear) {
    const year = Number(financialYear.slice(0, 4));
    if (financialYear !== `${year}-${String(year + 1).slice(-2)}`) throw new AppError('Choose a valid financial year.', 422, 'TAX_PERIOD_INVALID');
    return { from: `${year}-04-01`, to: `${year + 1}-03-31`, start: parseStoreDate(`${year}-04-01`).start, end: parseStoreDate(`${year + 1}-04-01`).start };
  }
  if (!from && !to) return reportDateRange({ period: storeDateKey(now).slice(0, 7) }, now);
  const first = parseStoreDate(from);
  const last = parseStoreDate(to || from);
  if (!first || !last || first.start >= last.end || last.end - first.start > 366 * 86400000) throw new AppError('Choose an inclusive date range of at most one year.', 422, 'TAX_PERIOD_INVALID');
  return { from, to: to || from, start: first.start, end: last.end };
}

export function creditNoteLines(original, selections, previous = []) {
  const originalLines = original.content.lines;
  const seen = new Set();
  return selections.map(({ lineIndex, amount, quantity = 0 }) => {
    const line = originalLines[lineIndex];
    if (!line || seen.has(lineIndex)) throw new AppError('Select each original invoice line once.', 422, 'CREDIT_NOTE_LINE_INVALID');
    seen.add(lineIndex);
    const used = previous.flatMap((document) => document.content.lines).filter((entry) => entry.originalLineIndex === lineIndex);
    const remaining = (field) => paise(line[field]) - used.reduce((sum, entry) => sum + paise(entry[field]), 0);
    const gross = paise(amount);
    if (gross <= 0 || gross > remaining('lineTotal')) throw new AppError('Credit exceeds the remaining invoice line amount.', 409, 'CREDIT_NOTE_EXCEEDS_INVOICE');
    const full = gross === remaining('lineTotal');
    const tax = full ? remaining('taxAmount') : Math.min(remaining('taxAmount'), Math.round(paise(line.taxAmount) * gross / paise(line.lineTotal)));
    const cgst = full ? remaining('cgstAmount') : Math.min(tax, remaining('cgstAmount'), Math.max(tax - remaining('sgstAmount'), Math.round(paise(line.cgstAmount) * gross / paise(line.lineTotal))));
    const usedQuantity = used.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    if (quantity < 0 || quantity > Number(line.quantity || 0) - usedQuantity) throw new AppError('Credit quantity exceeds the remaining invoiced quantity.', 409, 'CREDIT_NOTE_QUANTITY_INVALID');
    return { ...line, originalLineIndex: lineIndex, quantity, lineTotal: rupees(gross), taxableValue: rupees(gross - tax), taxAmount: rupees(tax), cgstAmount: rupees(cgst), sgstAmount: rupees(tax - cgst), discount: 0, allocatedCouponDiscount: 0 };
  });
}

export function summarizeTaxDocuments(documents, range, classifications = []) {
  const amountFields = ['taxableValue', 'tax', 'cgst', 'sgst', 'productTax', 'deliveryTax', 'gross'];
  const zero = () => Object.fromEntries(amountFields.map((key) => [key, 0]));
  const summary = { ...zero(), invoices: 0, creditNotes: 0, legacy: 0, commercialCredits: 0 };
  const daily = new Map(); const monthly = new Map(); const hsn = new Map(); const b2cs = new Map(); const series = new Map();
  const issues = [];
  const classificationMap = new Map();
  for (const entry of classifications) {
    if (!taxClassificationVerified(entry)) throw new AppError('Classification evidence integrity verification failed.', 409, 'TAX_INTEGRITY_FAILED');
    const key = `${entry.document}:${entry.lineIndex}`;
    if (!classificationMap.has(key)) classificationMap.set(key, entry.content);
  }
  for (const doc of documents) {
    const c = doc.content;
    if (!taxDocumentVerified(doc)) throw new AppError(`Integrity verification failed for ${doc.number}.`, 409, 'TAX_INTEGRITY_FAILED');
    if (paise(c.totals.taxableValue) + paise(c.totals.tax) !== paise(c.totals.grandTotal)
      || c.lines.reduce((total, line) => total + paise(line.taxAmount), 0) !== paise(c.totals.tax)
      || c.lines.reduce((total, line) => total + paise(line.lineTotal), 0) !== paise(c.totals.grandTotal)) issues.push({ number: doc.number, code: 'TOTAL_RECONCILIATION', message: 'Recorded invoice lines, taxable value or GST do not reconcile to the saved total. Accountant review is required; the original amounts have been preserved.' });
    const credit = doc.kind === 'CREDIT_NOTE';
    summary[credit ? 'creditNotes' : 'invoices']++;
    if (doc.source === 'legacy_import') { summary.legacy++; issues.push({ number: doc.number, code: 'LEGACY_DOCUMENT', message: 'Imported from the saved order; original supplier and classification evidence needs review.' }); }
    if (!/^[A-Za-z0-9/-]{1,16}$/.test(doc.number)) issues.push({ number: doc.number, code: 'INVOICE_NUMBER_FORMAT', message: 'Historical number exceeds the current Rule 46 format; it has not been renumbered.' });
    if (credit && !c.gstAdjustment) summary.commercialCredits++;
    const seriesKey = `${c.documentClass || doc.kind}:${doc.series || 'Legacy'}`;
    const group = series.get(seriesKey) || { kind: c.documentClass || doc.kind, series: doc.series || 'Legacy', first: doc.number, last: doc.number, issued: 0, cancelled: 0, legacy: doc.source === 'legacy_import' };
    group.issued++; group.first = [group.first, doc.number].sort()[0]; group.last = [group.last, doc.number].sort().at(-1); series.set(seriesKey, group);
    const commercial = credit && !c.gstAdjustment;
    const sign = commercial ? 0 : credit ? -1 : 1;
    const date = storeDateKey(new Date(doc.issuedAt));
    const sums = { taxableValue: paise(c.totals.taxableValue), tax: paise(c.totals.tax), cgst: paise(c.totals.cgst), sgst: paise(c.totals.sgst), productTax: c.lines.filter((line) => !line.isDelivery).reduce((sum, line) => sum + paise(line.taxAmount), 0), deliveryTax: c.lines.filter((line) => line.isDelivery).reduce((sum, line) => sum + paise(line.taxAmount), 0), gross: paise(c.totals.grandTotal) };
    for (const key of amountFields) summary[key] += sign * sums[key];
    for (const [map, key] of [[daily, date], [monthly, date.slice(0, 7)]]) {
      const entry = map.get(key) || { date: key, ...zero(), invoices: 0, creditNotes: 0 };
      entry[credit ? 'creditNotes' : 'invoices']++;
      for (const field of amountFields) entry[field] += sign * sums[field];
      map.set(key, entry);
    }
    if (commercial) continue;
    for (const [lineIndex, line] of c.lines.entries()) {
      const stateCode = c.placeOfSupplyCode;
      const rateKey = `${stateCode}:${line.taxRate}`;
      const rate = b2cs.get(rateKey) || { stateCode, taxRate: line.taxRate, taxableValue: 0, cgst: 0, sgst: 0, tax: 0, gross: 0 };
      for (const [field, source] of [['taxableValue', 'taxableValue'], ['cgst', 'cgstAmount'], ['sgst', 'sgstAmount'], ['tax', 'taxAmount'], ['gross', 'lineTotal']]) rate[field] += sign * paise(line[source]);
      b2cs.set(rateKey, rate);
      const classification = classificationMap.get(`${doc._id}:${lineIndex}`) || (doc.original ? classificationMap.get(`${doc.original}:${line.originalLineIndex}`) : null);
      const code = String(classification?.hsnCode || line.hsnCode || '').replace(/^-$|\s/g, '');
      if (!/^(?:\d{4}|\d{6}|\d{8})$/.test(code)) issues.push({ number: doc.number, code: 'HSN_MISSING', message: `${line.description}: HSN is missing; review before filing.` });
      const uqc = classification?.uqc || (line.isDelivery ? 'OTH' : 'NOS');
      const hsnKey = `${code}:${line.taxRate}:${uqc}`;
      const item = hsn.get(hsnKey) || { hsnCode: code, description: line.isDelivery ? 'Ancillary delivery' : line.description, taxRate: line.taxRate, uqc, quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, tax: 0, gross: 0 };
      item.quantity += sign * Number(line.quantity || 0);
      for (const [field, source] of [['taxableValue', 'taxableValue'], ['cgst', 'cgstAmount'], ['sgst', 'sgstAmount'], ['tax', 'taxAmount'], ['gross', 'lineTotal']]) item[field] += sign * paise(line[source]);
      hsn.set(hsnKey, item);
    }
  }
  const monetary = (entry) => Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, amountFields.includes(key) ? rupees(value) : value]));
  return { range: { from: range.from, to: range.to }, summary: monetary(summary), daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map(monetary), monthly: [...monthly.values()].sort((a, b) => a.date.localeCompare(b.date)).map(monetary), hsn: [...hsn.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode)).map(monetary), b2cs: [...b2cs.values()].map(monetary), documentsIssued: [...series.values()], issues };
}

export function csv(rows, columns) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+@\t\r]|^-\D/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [columns.map(([title]) => cell(title)).join(','), ...rows.map((row) => columns.map(([, key]) => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}
