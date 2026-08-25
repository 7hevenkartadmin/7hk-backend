import test from 'node:test';
import assert from 'node:assert/strict';
import { criticalAuditMongoFilter, criticalAuditType } from '../src/modules/audit/criticalAudit.js';
import { auditLogsQuerySchema } from '../src/modules/admin/admin.validation.js';

test('classifies product price changes but ignores stock-only updates', () => {
  const before = { variants: [{ sku: 'MILK-1L', mrp: 70, price: 65, stock: 10 }] };
  assert.equal(criticalAuditType({ action: 'product.update', before, after: { variants: [{ ...before.variants[0], price: 68 }] } }), 'product_price');
  assert.equal(criticalAuditType({ action: 'product.update', before, after: { variants: [{ ...before.variants[0], stock: 4 }] } }), null);
});

test('classifies coupon creation and delivery charge changes', () => {
  assert.equal(criticalAuditType({ action: 'coupon.create', after: { code: 'SAVE10' } }), 'coupon_creation');
  assert.equal(criticalAuditType({
    action: 'settings.update',
    before: { deliveryZones: [{ code: 'A', charge: 20 }] },
    after: { deliveryZones: [{ code: 'A', charge: 30 }] },
  }), 'delivery_charge');
});

test('ignores unrelated store setting changes', () => {
  assert.equal(criticalAuditType({
    action: 'settings.update',
    before: { deliveryZones: [{ code: 'A', charge: 20 }], homepageBanners: [] },
    after: { deliveryZones: [{ code: 'A', charge: 20 }], homepageBanners: [{ title: 'Sale' }] },
  }), null);
});

test('critical audit filters include materialized and legacy events without limiting history', () => {
  const all = criticalAuditMongoFilter('all');
  assert.equal(all.$or[0].criticalType.$in.length, 3);
  assert.equal(all.$or.some((filter) => filter.action === 'coupon.create'), true);
  const prices = criticalAuditMongoFilter('product_price');
  assert.equal(prices.$or[0].criticalType, 'product_price');
  assert.equal(prices.$or[1].action, 'product.update');
  assert.ok(prices.$or[1].$expr);
});

test('main audit list accepts only supported critical classifications', () => {
  assert.equal(auditLogsQuerySchema.safeParse({ criticalFilter: 'all' }).success, true);
  assert.equal(auditLogsQuerySchema.safeParse({ criticalFilter: 'product_price' }).success, true);
  assert.equal(auditLogsQuerySchema.safeParse({ criticalFilter: 'unsafe-type' }).success, false);
});
