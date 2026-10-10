import { csv } from './tax.domain.js';

const moneyColumns = [['Taxable value', 'taxableValue'], ['CGST', 'cgst'], ['SGST', 'sgst'], ['Total GST', 'tax'], ['Invoice value', 'gross']];
export function exportTaxWorkpaper(type, report, documents = []) {
  if (type === 'json') return { mime: 'application/json', extension: 'json', body: JSON.stringify({ format: '7heven-gst-workpaper-v1', report, documents: documents.map((doc) => ({ id: String(doc._id), checksum: doc.checksum, content: doc.content })) }, null, 2) };
  let rows; let columns;
  if (type === 'register') {
    rows = documents.map((doc) => ({ number: doc.number, kind: doc.kind, issuedAt: new Date(doc.issuedAt).toISOString(), period: doc.period, financialYear: doc.financialYear, orderNumber: doc.content.order.orderNumber, original: doc.content.invoice.originalNumber || '', supplyType: doc.content.supplyType, placeOfSupply: doc.content.placeOfSupplyCode, taxableValue: doc.content.totals.taxableValue, cgst: doc.content.totals.cgst, sgst: doc.content.totals.sgst, tax: doc.content.totals.tax, gross: doc.content.totals.grandTotal, adjustment: doc.kind === 'CREDIT_NOTE' ? doc.content.gstAdjustment ? 'GST credit' : 'Commercial only' : '', source: doc.source, checksum: doc.checksum }));
    columns = [['Document number', 'number'], ['Type', 'kind'], ['Issue timestamp UTC', 'issuedAt'], ['GST month IST', 'period'], ['Financial year', 'financialYear'], ['Order number', 'orderNumber'], ['Original invoice', 'original'], ['Supply type', 'supplyType'], ['Place of supply code', 'placeOfSupply'], ...moneyColumns, ['Adjustment treatment', 'adjustment'], ['Record source', 'source'], ['SHA-256', 'checksum']];
  } else if (type === 'hsn') { rows = report.hsn; columns = [['HSN', 'hsnCode'], ['Description', 'description'], ['GST rate', 'taxRate'], ['UQC', 'uqc'], ['Quantity', 'quantity'], ...moneyColumns]; }
  else if (type === 'b2cs') { rows = report.b2cs.filter((entry) => entry.taxRate > 0); columns = [['Place of supply code', 'stateCode'], ['GST rate', 'taxRate'], ...moneyColumns]; }
  else if (type === 'nil') { rows = report.b2cs.filter((entry) => entry.taxRate === 0); columns = [['Place of supply code', 'stateCode'], ['GST rate - classify nil/exempt/non-GST', 'taxRate'], ...moneyColumns]; }
  else if (type === 'documents') { rows = report.documentsIssued.filter((entry) => entry.kind !== 'COMMERCIAL_CREDIT_NOTE'); columns = [['Document type', 'kind'], ['Series', 'series'], ['From number', 'first'], ['To number', 'last'], ['Total issued', 'issued'], ['Cancelled documents', 'cancelled'], ['Legacy series - review', 'legacy']]; }
  else if (type === 'daily' || type === 'monthly') { rows = report[type]; columns = [['Period IST', 'date'], ['Invoices', 'invoices'], ['Credit notes', 'creditNotes'], ...moneyColumns, ['Product GST', 'productTax'], ['Delivery GST', 'deliveryTax']]; }
  else return null;
  return { mime: 'text/csv; charset=utf-8', extension: 'csv', body: csv(rows, columns) };
}
