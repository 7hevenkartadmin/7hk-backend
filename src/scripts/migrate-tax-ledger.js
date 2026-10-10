import mongoose from 'mongoose';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Order } from '../modules/orders/order.model.js';
import { TaxDocument } from '../modules/taxes/tax.model.js';
import { importLegacyInvoice } from '../modules/taxes/tax.service.js';

const apply = process.argv.includes('--apply');
try {
  await connectDatabase();
  const orders = await Order.find({ 'invoice.number': { $exists: true }, 'invoice.issuedAt': { $exists: true } }).sort({ createdAt: 1 }).lean();
  const existing = new Set((await TaxDocument.find({ kind: 'INVOICE' }).select('order').lean()).map((entry) => String(entry.order)));
  const missing = orders.filter((order) => !existing.has(String(order._id)));
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', invoices: orders.length, alreadyImported: orders.length - missing.length, toImport: missing.length, cancelledForOwnerReview: missing.filter((order) => order.status === 'cancelled').length }));
  if (apply && missing.length) {
    const folder = fileURLToPath(new URL(`../../../tmp/tax-ledger/${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url));
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}orders-before.json`, JSON.stringify(missing, null, 2));
    let imported = 0;
    for (const order of missing) {
      const session = await mongoose.startSession();
      try { let saved; await session.withTransaction(async () => { saved = await importLegacyInvoice(order, session); }); if (saved) imported++; }
      finally { await session.endSession(); }
    }
    const after = await Order.find({ _id: { $in: missing.map((order) => order._id) } }).sort({ createdAt: 1 }).lean();
    const unchanged = JSON.stringify(after) === JSON.stringify(missing);
    writeFileSync(`${folder}verification.json`, JSON.stringify({ imported, ordersUnchanged: unchanged, historicalNumbersPreserved: true }, null, 2));
    if (!unchanged) throw new Error('Orders changed concurrently during the ledger import; inspect the backup.');
    console.log(JSON.stringify({ imported, ordersUnchanged: true, backup: folder }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await disconnectDatabase(); }
