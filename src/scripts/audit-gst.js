import 'dotenv/config';
import mongoose from 'mongoose';

// Read raw persisted documents; defaults must not conceal missing classifications.
try {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 8000 });
  const products = mongoose.connection.db.collection('products');
  const missing = { $or: [{ hsnCode: { $exists: false } }, { hsnCode: '' }, { hsnCode: null }] };
  const [total, missingHsn, missingRate, legacyOrders, rates] = await Promise.all([
    products.countDocuments({}), products.countDocuments(missing),
    products.countDocuments({ taxRate: { $exists: false } }),
    mongoose.connection.db.collection('orders').countDocuments({ pricingVersion: { $nin: [2, 3, 4] } }),
    products.aggregate([{ $group: { _id: '$taxRate', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
  ]);
  console.log(JSON.stringify({ totalProducts: total, missingHsn, missingRate, legacyOrders, rates }, null, 2));
  console.log('Read-only audit. Populate verified classifications through the product editor; historical orders retain their original totals.');
} catch (error) {
  console.error(`GST audit failed (${error.name}). Check database configuration and connectivity.`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
