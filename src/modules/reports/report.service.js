import { env } from '../../config/env.js';
import { Product } from '../catalog/product.model.js';
import { Order } from '../orders/order.model.js';
import { User } from '../users/user.model.js';
import { parseStoreDate } from '../../shared/utils/storeDate.js';

export async function dashboardSummary() {
  const [orders, revenue, customers, lowStock] = await Promise.all([
    Order.countDocuments(),
    Order.aggregate([{ $match: { paymentStatus: { $in: ['paid', 'pending'] }, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    User.countDocuments({ role: 'customer' }),
    Product.aggregate([
      { $match: { isActive: true } },
      { $unwind: '$variants' },
      { $match: { 'variants.isActive': true } },
      { $addFields: { available: { $max: [0, { $subtract: [{ $ifNull: ['$variants.stock', 0] }, { $ifNull: ['$variants.reservedStock', 0] }] }] } } },
      { $match: { available: { $gt: 0, $lt: env.LOW_STOCK_THRESHOLD } } },
      { $count: 'value' },
    ]),
  ]);

  return {
    totalOrders: orders,
    revenue: revenue[0]?.total || 0,
    customers,
    lowStock: lowStock[0]?.value || 0,
  };
}

const periodFormats = {
  daily: '%Y-%m-%d',
  weekly: '%G-W%V',
  monthly: '%Y-%m',
  yearly: '%Y',
};

export async function salesReport({ from, to, startDate, endDate, period = 'daily' } = {}) {
  const match = {};
  const lower = from || startDate;
  const upper = to || endDate;
  if (lower || upper) {
    match.createdAt = {};
    if (lower) match.createdAt.$gte = parseStoreDate(lower).start;
    if (upper) match.createdAt.$lt = parseStoreDate(upper).end;
  }
  return Order.aggregate([
    { $match: { ...match, status: { $ne: 'cancelled' }, paymentStatus: { $nin: ['failed', 'refunded'] } } },
    {
      $group: {
        _id: { $dateToString: { format: periodFormats[period] || periodFormats.daily, date: '$createdAt', timezone: 'Asia/Kolkata' } },
        revenue: { $sum: '$total' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
}

export async function categoryReport() {
  return Order.aggregate([
    { $unwind: '$items' },
    { $group: { _id: '$items.category', sales: { $sum: '$items.quantity' }, revenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } } } },
    { $sort: { revenue: -1 } },
  ]);
}
