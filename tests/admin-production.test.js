import test from 'node:test';
import assert from 'node:assert/strict';
import { adminOrdersQuerySchema } from '../src/modules/admin/admin.validation.js';
import { buildAdminOrderFilter, getDashboardStats, listAdminOrders } from '../src/modules/admin/admin.service.js';
import { Product } from '../src/modules/catalog/product.model.js';
import { listProducts } from '../src/modules/catalog/catalog.service.js';
import { Order } from '../src/modules/orders/order.model.js';
import { parseStoreDate } from '../src/shared/utils/storeDate.js';

function withStubs(stubs, callback) {
  const originals = stubs.map(({ object, method }) => ({ object, method, value: object[method] }));
  stubs.forEach(({ object, method, implementation }) => { object[method] = implementation; });
  return Promise.resolve().then(callback).finally(() => {
    originals.forEach(({ object, method, value }) => { object[method] = value; });
  });
}

test('admin order query validation applies production defaults and rejects unsafe filters', () => {
  const defaults = adminOrdersQuerySchema.parse({});
  assert.equal(defaults.page, 1);
  assert.equal(defaults.limit, 15);
  assert.equal(defaults.period, undefined);
  assert.equal(adminOrdersQuerySchema.safeParse({ limit: 101 }).success, false);
  assert.equal(adminOrdersQuerySchema.safeParse({ date: '2026-02-30' }).success, false);
  assert.equal(adminOrdersQuerySchema.safeParse({ from: '2026-08-14', to: '2026-08-01' }).success, false);
  assert.equal(adminOrdersQuerySchema.safeParse({ status: 'processing' }).success, false);
  assert.equal(adminOrdersQuerySchema.safeParse({ paymentStatus: 'paid' }).success, true);
});

test('store dates produce an exact Asia/Kolkata day range', () => {
  const range = parseStoreDate('2026-08-14');
  assert.equal(range.start.toISOString(), '2026-08-13T18:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-08-14T18:30:00.000Z');
});

test('combined admin order filters stay in one MongoDB query', () => {
  const filter = buildAdminOrderFilter({
    from: '2026-08-01',
    to: '2026-08-14',
    status: 'delivered',
    paymentStatus: 'paid',
    search: 'ORD-10',
  });
  assert.equal(filter.status, 'delivered');
  assert.equal(filter.paymentStatus, 'paid');
  assert.equal(filter.createdAt.$gte.toISOString(), '2026-07-31T18:30:00.000Z');
  assert.equal(filter.createdAt.$lt.toISOString(), '2026-08-14T18:30:00.000Z');
  assert.equal(filter.$or.length, 4);
  assert.equal(filter.$or[0].orderNumber.source, '^ORD-10');
});

test('admin orders apply server pagination before returning metadata', async () => {
  const calls = [];
  const query = {
    sort(value) { calls.push(['sort', value]); return this; },
    skip(value) { calls.push(['skip', value]); return this; },
    limit(value) { calls.push(['limit', value]); return this; },
    lean() { calls.push(['lean']); return Promise.resolve([{ orderNumber: 'ORD-16' }]); },
  };
  await withStubs([
    { object: Order, method: 'find', implementation: (filter) => { calls.push(['find', filter]); return query; } },
    { object: Order, method: 'countDocuments', implementation: async (filter) => { calls.push(['count', filter]); return 31; } },
  ], async () => {
    const result = await listAdminOrders({ page: 2, limit: 15, status: 'delivered' });
    assert.deepEqual(result.meta, { total: 31, page: 2, limit: 15, pages: 3 });
    assert.deepEqual(calls.find(([name]) => name === 'skip'), ['skip', 15]);
    assert.deepEqual(calls.find(([name]) => name === 'limit'), ['limit', 15]);
    assert.equal(calls.find(([name]) => name === 'find')[1].status, 'delivered');
  });
});

test('admin products apply server pagination and visibility/stock filters in MongoDB', async () => {
  const calls = [];
  const query = {
    populate() { return this; },
    sort(value) { calls.push(['sort', value]); return this; },
    skip(value) { calls.push(['skip', value]); return this; },
    limit(value) { calls.push(['limit', value]); return Promise.resolve([]); },
  };
  await withStubs([
    { object: Product, method: 'find', implementation: (filter) => { calls.push(['find', filter]); return query; } },
    { object: Product, method: 'countDocuments', implementation: async (filter) => { calls.push(['count', filter]); return 125; } },
  ], async () => {
    const result = await listProducts({ page: 2, limit: 20, sort: 'name_asc', active: 'inactive', stockStatus: 'out' }, { includeInactive: true });
    assert.deepEqual(result.meta, { total: 125, page: 2, limit: 20, pages: 7 });
    assert.deepEqual(calls.find(([name]) => name === 'skip'), ['skip', 20]);
    assert.deepEqual(calls.find(([name]) => name === 'limit'), ['limit', 20]);
    const filter = calls.find(([name]) => name === 'find')[1];
    assert.equal(filter.isActive, false);
    assert.equal(filter.stock, 0);
  });
});

test('dashboard statistics use database counts, aggregation, and exactly five recent orders', async () => {
  const orderCounts = [1248, 18, 7, 1180, 61];
  const productCounts = [423, 397, 12, 31];
  let orderCountIndex = 0;
  let productCountIndex = 0;
  let aggregateIndex = 0;
  let recentLimit = 0;
  const aggregates = [
    [{ value: 845620 }], [{ value: 12450 }],
    [{ _id: '2026-08-14', revenue: 12450, orders: 18 }],
    [{ revenue: 12450, orders: 18, customers: ['a', 'b'] }],
    [{ _id: 'Vegetables', value: 30 }], [{ _id: 'Tomato', sales: 20 }], [{ _id: '10', orders: 8 }],
  ];
  const recentQuery = {
    sort() { return this; },
    limit(value) { recentLimit = value; return this; },
    lean() { return Promise.resolve(Array.from({ length: 5 }, (_, index) => ({ orderNumber: `ORD-${index}` }))); },
  };
  const lowStockQuery = {
    sort() { return this; }, limit() { return this; }, select() { return this; }, lean() { return Promise.resolve([{ name: 'Tomato', stock: 2 }]); },
  };
  await withStubs([
    { object: Order, method: 'countDocuments', implementation: async () => orderCounts[orderCountIndex++] },
    { object: Product, method: 'countDocuments', implementation: async () => productCounts[productCountIndex++] },
    { object: Order, method: 'aggregate', implementation: async () => aggregates[aggregateIndex++] },
    { object: Order, method: 'find', implementation: () => recentQuery },
    { object: Product, method: 'find', implementation: () => lowStockQuery },
  ], async () => {
    const stats = await getDashboardStats('weekly');
    assert.deepEqual(stats.orders, { total: 1248, today: 18, pending: 7, delivered: 1180, cancelled: 61 });
    assert.deepEqual(stats.products, { total: 423, active: 397, outOfStock: 12, lowStock: 31, threshold: 20 });
    assert.equal(stats.revenue.total, 845620);
    assert.equal(stats.recentOrders.length, 5);
    assert.equal(recentLimit, 5);
    assert.equal(stats.analytics.averageOrderValue, 692);
  });
});
