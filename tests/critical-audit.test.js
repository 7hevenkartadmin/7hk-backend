import test from 'node:test';
import assert from 'node:assert/strict';
import { criticalAuditType } from '../src/modules/audit/criticalAudit.js';

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
