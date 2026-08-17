import { env } from '../../config/env.js';
import { getPagination, paged } from '../../shared/utils/pagination.js';
import { parseStoreDate, storeDateKey, todayStoreRange } from '../../shared/utils/storeDate.js';
import { Product } from '../catalog/product.model.js';
import { Order } from '../orders/order.model.js';

export const REVENUE_FILTER = {
  status: { $ne: 'cancelled' },
  paymentStatus: { $nin: ['failed', 'refunded'] },
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildAdminOrderFilter(query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;

  if (query.date) {
    const range = parseStoreDate(query.date);
    filter.createdAt = { $gte: range.start, $lt: range.end };
  } else if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = parseStoreDate(query.from).start;
    if (query.to) filter.createdAt.$lt = parseStoreDate(query.to).end;
  }

  if (query.search) {
    const pattern = new RegExp(`^${escapeRegex(query.search)}`, 'i');
    filter.$or = [
      { orderNumber: pattern },
      { 'customerSnapshot.name': pattern },
      { 'customerSnapshot.phone': pattern },
      { 'address.phone': pattern },
    ];
  }
  return filter;
}

export async function listAdminOrders(query) {
  const { page, limit, skip } = getPagination(query);
  const filter = buildAdminOrderFilter(query);
  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  return paged(items, total, page, limit);
}

function revenuePeriodStart(period) {
  const today = todayStoreRange().start;
  const [year, month] = storeDateKey().split('-').map(Number);
  if (period === 'yearly') return parseStoreDate(`${year - 4}-01-01`).start;
  if (period === 'monthly') {
    const normalized = new Date(Date.UTC(year, month - 12, 1));
    const key = `${normalized.getUTCFullYear()}-${String(normalized.getUTCMonth() + 1).padStart(2, '0')}-01`;
    return parseStoreDate(key).start;
  }
  return new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
}

function revenueDateFormat(period) {
  if (period === 'yearly') return '%Y';
  if (period === 'monthly') return '%Y-%m';
  return '%Y-%m-%d';
}

export async function getDashboardStats(period = 'weekly') {
  const today = todayStoreRange();
  const activeFilter = { isActive: true };
  const lowStockFilter = { ...activeFilter, availableStock: { $gt: 0, $lt: env.LOW_STOCK_THRESHOLD } };
  const revenueStart = revenuePeriodStart(period);
  const periodRevenueFilter = { ...REVENUE_FILTER, createdAt: { $gte: revenueStart } };
  const [
    totalOrders, todayOrders, pendingOrders, deliveredOrders, cancelledOrders,
    totalRevenueRows, todayRevenueRows, totalProducts, activeProducts,
    outOfStockProducts, lowStockProducts, recentOrders, lowStockItems, revenueRows,
    periodSummaryRows, categoryRows, topProductRows, hourlyRows,
  ] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments({ createdAt: { $gte: today.start, $lt: today.end } }),
    Order.countDocuments({ status: { $in: ['placed', 'confirmed', 'packed', 'out_for_delivery'] } }),
    Order.countDocuments({ status: 'delivered' }),
    Order.countDocuments({ status: 'cancelled' }),
    Order.aggregate([{ $match: REVENUE_FILTER }, { $group: { _id: null, value: { $sum: '$total' } } }]),
    Order.aggregate([{ $match: { ...REVENUE_FILTER, createdAt: { $gte: today.start, $lt: today.end } } }, { $group: { _id: null, value: { $sum: '$total' } } }]),
    Product.countDocuments(),
    Product.countDocuments(activeFilter),
    Product.countDocuments({ ...activeFilter, availableStock: 0 }),
    Product.countDocuments(lowStockFilter),
    Order.find().sort({ createdAt: -1 }).limit(5).lean(),
    Product.aggregate([
      { $match: activeFilter },
      { $unwind: '$variants' },
      { $match: { 'variants.isActive': true } },
      { $addFields: { skuAvailable: { $max: [0, { $subtract: ['$variants.stock', { $ifNull: ['$variants.reservedStock', 0] }] }] } } },
      { $match: { skuAvailable: { $lt: env.LOW_STOCK_THRESHOLD } } },
      { $sort: { skuAvailable: 1, name: 1 } },
      { $limit: 8 },
      { $project: { name: 1, image: 1, stock: '$skuAvailable', unit: '$variants.unit', sku: '$variants.sku', variantId: '$variants._id' } },
    ]),
    Order.aggregate([
      { $match: periodRevenueFilter },
      { $group: { _id: { $dateToString: { format: revenueDateFormat(period), date: '$createdAt', timezone: 'Asia/Kolkata' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([{ $match: periodRevenueFilter }, { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 }, customers: { $addToSet: '$customer' } } }]),
    Order.aggregate([{ $match: periodRevenueFilter }, { $unwind: '$items' }, { $group: { _id: { $ifNull: ['$items.category', 'Other'] }, value: { $sum: '$items.quantity' } } }, { $sort: { value: -1 } }, { $limit: 6 }]),
    Order.aggregate([{ $match: periodRevenueFilter }, { $unwind: '$items' }, { $group: { _id: '$items.name', sales: { $sum: '$items.quantity' } } }, { $sort: { sales: -1 } }, { $limit: 8 }]),
    Order.aggregate([{ $match: periodRevenueFilter }, { $group: { _id: { $dateToString: { format: '%H', date: '$createdAt', timezone: 'Asia/Kolkata' } }, orders: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
  ]);

  return {
    orders: { total: totalOrders, today: todayOrders, pending: pendingOrders, delivered: deliveredOrders, cancelled: cancelledOrders },
    revenue: { total: totalRevenueRows[0]?.value || 0, today: todayRevenueRows[0]?.value || 0, rule: 'Excludes cancelled orders and failed/refunded payments', series: revenueRows.map((row) => ({ day: row._id, label: row._id, revenue: row.revenue, orders: row.orders })) },
    products: { total: totalProducts, active: activeProducts, outOfStock: outOfStockProducts, lowStock: lowStockProducts, threshold: env.LOW_STOCK_THRESHOLD },
    recentOrders,
    lowStockItems,
    analytics: {
      orders: periodSummaryRows[0]?.orders || 0,
      revenue: periodSummaryRows[0]?.revenue || 0,
      customers: periodSummaryRows[0]?.customers?.length || 0,
      averageOrderValue: periodSummaryRows[0]?.orders ? Math.round(periodSummaryRows[0].revenue / periodSummaryRows[0].orders) : 0,
      categories: categoryRows.map((row) => ({ name: row._id || 'Other', value: row.value })),
      topProducts: topProductRows.map((row) => ({ name: row._id || 'Product', sales: row.sales })),
      hourly: Object.fromEntries(hourlyRows.map((row) => [Number(row._id), row.orders])),
    },
  };
}
