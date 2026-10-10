import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { TaxDocument, InvoiceCounter, GstFiling, GstFilingEvent, TaxClassification } from '../src/modules/taxes/tax.model.js';
import { Order } from '../src/modules/orders/order.model.js';
import { calculateCartTotals } from '../src/modules/orders/pricing.service.js';
import { issueOrderInvoice, importLegacyInvoice, issueCreditNote, primeTaxSeries, prepareGstFiling, filingDocuments, getGstFiling, recordTaxClassification, recordPortalFiling } from '../src/modules/taxes/tax.service.js';
import { invoiceSeries, taxDocumentVerified, filingEventVerified } from '../src/modules/taxes/tax.domain.js';
import { storeDateKey } from '../src/shared/utils/storeDate.js';
import { storeBusiness } from '../src/config/store.js';

const uri = process.env.TEST_TAX_MONGODB_URI;
test('real Mongo transactions keep sequences unique, roll back allocations, prevent double credits and preserve filing snapshots', { skip: !uri, timeout: 120000 }, async () => {
  const databaseName = `gst_verify_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  try {
    await mongoose.connect(uri, { dbName: databaseName, autoIndex: false, serverSelectionTimeoutMS: 15000 });
    await Promise.all([TaxDocument, GstFiling, GstFilingEvent, TaxClassification].map((model) => model.createIndexes()));
    await InvoiceCounter.createCollection();
    await Order.createCollection();
    await primeTaxSeries();
    const transaction = async (work) => {
      const session = await mongoose.startSession();
      try { let result; await session.withTransaction(async () => { result = await work(session); }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }); return result; }
      finally { await session.endSession(); }
    };
    const makeOrder = () => {
      const items = [{ product: new mongoose.Types.ObjectId(), name: 'Noodles', sku: 'SYNTHETIC', unit: '280 g', hsnCode: '1902', price: 55, mrp: 58, quantity: 1, taxRate: 12 }];
      return { _id: new mongoose.Types.ObjectId(), orderNumber: `VERIFY-${randomUUID().slice(0, 8)}`, createdAt: new Date(), items, ...calculateCartTotals({ items, deliveryFee: 20 }), paymentMethod: 'cod', paymentStatus: 'pending', customerSnapshot: { name: 'Synthetic test customer' }, address: { state: 'Bihar' } };
    };
    const invoices = await Promise.all(Array.from({ length: 12 }, () => transaction((session) => issueOrderInvoice(makeOrder(), session))));
    assert.equal(new Set(invoices.map((entry) => entry.number)).size, 12);
    assert.deepEqual(invoices.map((entry) => Number(entry.number.split('/').at(-1))).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));
    const counterKey = invoiceSeries(new Date(), 'INVOICE', storeBusiness.gstin).key;
    await assert.rejects(transaction(async (session) => { await issueOrderInvoice(makeOrder(), session); throw new Error('Synthetic transaction abort'); }), /Synthetic transaction abort/);
    assert.equal((await InvoiceCounter.findById(counterKey)).sequence, 12);
    assert.equal(await TaxDocument.countDocuments({ kind: 'INVOICE' }), 12);

    const monthKey = storeDateKey().slice(0, 7);
    const previousMonth = new Date(`${monthKey}-15T12:00:00+05:30`);
    previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
    const legacy = makeOrder(); legacy.invoice = { number: 'LEGACY-GST-0001', issuedAt: previousMonth };
    const original = await transaction((session) => importLegacyInvoice(legacy, session));
    const owner = { _id: new mongoose.Types.ObjectId() };
    await recordTaxClassification(original, { lineIndex: original.content.lines.length - 1, hsnCode: '1902', uqc: 'OTH', reason: 'Synthetic supplier classification verification', idempotencyKey: randomUUID() }, owner);
    const filing = await prepareGstFiling({ period: storeDateKey(previousMonth).slice(0, 7), reviewed: true, hsnDigits: 4, reviewNotes: 'Synthetic accountant review of all original records.' }, owner);
    const sealed = JSON.stringify(filing.content.report);
    const payload = { reason: 'Synthetic partial return credit', gstAdjustment: true, idempotencyKey: randomUUID(), lines: [{ lineIndex: 0, amount: 40, quantity: 0 }] };
    const results = await Promise.allSettled([transaction((session) => issueCreditNote(original, payload, owner, session)), transaction((session) => issueCreditNote(original, { ...payload, idempotencyKey: randomUUID() }, owner, session))]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CREDIT_NOTE_EXCEEDS_INVOICE');
    const credit = results.find((result) => result.status === 'fulfilled').value;
    const repeated = await transaction((session) => issueCreditNote(original, { ...payload, idempotencyKey: credit.eventKey.split(':').at(-1) }, owner, session));
    assert.equal(String(repeated._id), String(credit._id));
    assert.equal(taxDocumentVerified(credit.toObject()), true);
    const frozen = await getGstFiling(filing._id);
    assert.equal(JSON.stringify(frozen.content.report), sealed);
    assert.equal((await filingDocuments(frozen)).length, 1);
    await assert.rejects(TaxDocument.updateOne({ _id: original._id }, { $set: { number: 'CHANGED' } }), { code: 'TAX_RECORD_IMMUTABLE' });
    const event = await recordPortalFiling(filing._id, { returnType: 'GSTR1', arn: 'AA0000000000001', filedAt: new Date().toISOString() }, owner);
    assert.equal(filingEventVerified(event.toObject()), true);
    await assert.rejects(recordPortalFiling(filing._id, { returnType: 'GSTR1', arn: 'AA0000000000002', filedAt: new Date().toISOString() }, owner), { code: 'GST_RETURN_ALREADY_RECORDED' });
  } finally {
    if (mongoose.connection.readyState === 1) {
      // This database is created only by this test. Never target the shop database.
      assert.equal(mongoose.connection.name, databaseName);
      assert.match(databaseName, /^gst_verify_[a-f0-9]{24}$/);
      try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
    }
    await mongoose.disconnect();
  }
});
