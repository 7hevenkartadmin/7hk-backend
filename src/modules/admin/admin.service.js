import { env } from '../../config/env.js';
import { getPagination, paged } from '../../shared/utils/pagination.js';
import { parseStoreDate, storeDateKey, todayStoreRange } from '../../shared/utils/storeDate.js';
import { Product } from '../catalog/product.model.js';
import { Order } from '../orders/order.model.js';
import { PaymentIntent } from '../payments/paymentIntent.model.js';
import { User } from '../users/user.model.js';

export const REVENUE_FILTER = {
  status: { $ne: 'cancelled' },
  paymentStatus: { $in: ['paid', 'partially_refunded'] },
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

export function buildInventoryDashboardPipeline(threshold = env.LOW_STOCK_THRESHOLD, lowStockLimit = 20) {
  return [
    { $match: { isActive: true } },
    { $unwind: '$variants' },
    { $match: { 'variants.isActive': true } },
    {
      $addFields: {
        skuAvailable: {
          $max: [0, { $subtract: [{ $ifNull: ['$variants.stock', 0] }, { $ifNull: ['$variants.reservedStock', 0] }] }],
        },
      },
    },
    {
      $facet: {
        counts: [{
          $group: {
            _id: null,
            activeVariants: { $sum: 1 },
            outOfStock: { $sum: { $cond: [{ $eq: ['$skuAvailable', 0] }, 1, 0] } },
            lowStock: { $sum: { $cond: [{ $and: [{ $gt: ['$skuAvailable', 0] }, { $lte: ['$skuAvailable', threshold] }] }, 1, 0] } },
            healthy: { $sum: { $cond: [{ $gt: ['$skuAvailable', threshold] }, 1, 0] } },
          },
        }],
        outOfStockItems: [
          { $match: { skuAvailable: 0 } },
          { $sort: { name: 1, 'variants.title': 1 } },
          { $project: {
            _id: 0,
            productId: '$_id',
            variantId: '$variants._id',
            name: 1,
            variantTitle: '$variants.title',
            sku: '$variants.sku',
            unit: '$variants.unit',
            availableStock: '$skuAvailable',
            status: { $literal: 'out_of_stock' },
          } },
        ],
        lowStockItems: [
          { $match: { skuAvailable: { $gt: 0, $lt: threshold } } },
          { $sort: { skuAvailable: 1, name: 1, 'variants.title': 1 } },
          { $limit: lowStockLimit },
          { $project: {
            _id: 0,
            productId: '$_id',
            variantId: '$variants._id',
            name: 1,
            variantTitle: '$variants.title',
            sku: '$variants.sku',
            unit: '$variants.unit',
            availableStock: '$skuAvailable',
            status: { $literal: 'low_stock' },
          } },
        ],
      },
    },
  ];
}

export async function getDashboardStats(period = 'weekly') {
  const today = todayStoreRange();
  const activeFilter = { isActive: true };
  const revenueStart = revenuePeriodStart(period);
  const periodRevenueFilter = { ...REVENUE_FILTER, createdAt: { $gte: revenueStart } };
  const [
    totalOrders, todayOrders, pendingOrders, deliveredOrders, cancelledOrders,
    totalRevenueRows, todayRevenueRows, totalProducts, activeProducts, totalCustomers,
    inventoryRows, recentOrders, revenueRows, periodSummaryRows,
    categoryRows, topProductRows, hourlyRows,
    refundPendingCount, refundFailedCount, recentPaymentExceptions,
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
    User.countDocuments({ role: 'customer' }),
    Product.aggregate(buildInventoryDashboardPipeline()),
    Order.find().sort({ createdAt: -1 }).limit(5).lean(),
    Order.aggregate([
      { $match: periodRevenueFilter },
      { $group: { _id: { $dateToString: { format: revenueDateFormat(period), date: '$createdAt', timezone: 'Asia/Kolkata' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([{ $match: periodRevenueFilter }, { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 }, customers: { $addToSet: '$customer' } } }]),
    Order.aggregate([{ $match: periodRevenueFilter }, { $unwind: '$items' }, { $group: { _id: { $ifNull: ['$items.category', 'Other'] }, value: { $sum: '$items.quantity' } } }, { $sort: { value: -1 } }, { $limit: 6 }]),
    Order.aggregate([{ $match: periodRevenueFilter }, { $unwind: '$items' }, { $group: { _id: '$items.name', sales: { $sum: '$items.quantity' } } }, { $sort: { sales: -1 } }, { $limit: 8 }]),
    Order.aggregate([{ $match: periodRevenueFilter }, { $group: { _id: { $dateToString: { format: '%H', date: '$createdAt', timezone: 'Asia/Kolkata' } }, orders: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    PaymentIntent.countDocuments({ status: 'refund_pending' }),
    PaymentIntent.countDocuments({ status: 'refund_failed' }),
    PaymentIntent.find({ status: { $in: ['refund_pending', 'refund_failed'] } })
      .select('_id user status amount currency failureCode refundReason refundStatus refundAttemptCount nextRefundAttemptAt updatedAt')
      .populate('user', 'name phone email')
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean(),
  ]);

  const inventory = inventoryRows[0] || {};
  const variantCounts = inventory.counts?.[0] || { activeVariants: 0, outOfStock: 0, lowStock: 0, healthy: 0 };
  const outOfStockItems = inventory.outOfStockItems || [];
  const lowStockItems = inventory.lowStockItems || [];

  return {
    orders: { total: totalOrders, today: todayOrders, pending: pendingOrders, delivered: deliveredOrders, cancelled: cancelledOrders },
    revenue: {
      total: totalRevenueRows[0]?.value || 0,
      today: todayRevenueRows[0]?.value || 0,
      rule: 'Includes paid and partially refunded non-cancelled orders',
      series: revenueRows.map((row) => ({ day: row._id, label: row._id, revenue: row.revenue, orders: row.orders })),
    },
    products: {
      total: totalProducts,
      active: activeProducts,
      activeVariants: variantCounts.activeVariants,
      outOfStock: variantCounts.outOfStock,
      lowStock: variantCounts.lowStock,
      healthy: variantCounts.healthy,
      threshold: env.LOW_STOCK_THRESHOLD,
    },
    customers: { total: totalCustomers },
    recentOrders,
    outOfStockItems,
    lowStockItems,
    paymentOperations: {
      attention: refundPendingCount + refundFailedCount,
      refundPending: refundPendingCount,
      refundFailed: refundFailedCount,
      recentExceptions: recentPaymentExceptions,
    },
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
