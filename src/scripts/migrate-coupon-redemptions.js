import 'dotenv/config';
import mongoose from 'mongoose';
import { Coupon } from '../modules/coupons/coupon.model.js';
import { CouponRedemption } from '../modules/coupons/couponRedemption.model.js';
import { Order } from '../modules/orders/order.model.js';
import { PaymentIntent } from '../modules/payments/paymentIntent.model.js';

const mongodbUri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!mongodbUri) throw new Error('Missing MONGODB_URI or MONGO_URI');

async function main() {
  await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 8000 });

  const inFlightCouponCheckouts = await PaymentIntent.countDocuments({
    'reservation.coupon': { $type: 'objectId' },
    'reservation.state': { $in: ['held', 'consuming'] },
  });
  if (inFlightCouponCheckouts > 0) {
    throw new Error(
      `Cannot migrate while ${inFlightCouponCheckouts} coupon checkout reservation(s) are active. `
      + 'Pause checkout, let reservations expire or finish, then rerun the migration.',
    );
  }

  await CouponRedemption.createIndexes();
  const coupons = await Coupon.find({}, { code: 1, usedCount: 1 }).lean();
  const couponByCode = new Map(coupons.map((coupon) => [coupon.code, coupon]));
  const historicalUses = new Map();
  let migratedOrders = 0;
  let skippedUnknownCoupons = 0;

  const cursor = Order.find(
    { couponCode: { $type: 'string', $ne: '' }, customer: { $type: 'objectId' } },
    { couponCode: 1, customer: 1, createdAt: 1 },
  ).sort({ createdAt: 1, _id: 1 }).cursor();

  for await (const order of cursor) {
    const code = String(order.couponCode || '').trim().toUpperCase();
    const coupon = couponByCode.get(code);
    if (!coupon) {
      skippedUnknownCoupons += 1;
      continue;
    }
    const now = order.createdAt || new Date();
    const redemption = await CouponRedemption.findOneAndUpdate(
      { coupon: coupon._id, user: order.customer, active: true },
      {
        $setOnInsert: {
          codeSnapshot: code,
          status: 'consumed',
          active: true,
          order: order._id,
          reservedAt: now,
          consumedAt: now,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await Order.updateOne({ _id: order._id }, { $set: { couponRedemption: redemption._id } });
    historicalUses.set(String(coupon._id), (historicalUses.get(String(coupon._id)) || 0) + 1);
    migratedOrders += 1;
  }

  for (const coupon of coupons) {
    const historicalCount = historicalUses.get(String(coupon._id)) || 0;
    if (historicalCount > Number(coupon.usedCount || 0)) {
      await Coupon.updateOne({ _id: coupon._id }, { $set: { usedCount: historicalCount } });
    }
  }

  console.log(JSON.stringify({
    migratedOrders,
    uniqueCustomerRedemptions: await CouponRedemption.countDocuments({ status: 'consumed', active: true }),
    skippedUnknownCoupons,
  }, null, 2));
}

try {
  await main();
} finally {
  await mongoose.disconnect();
}
