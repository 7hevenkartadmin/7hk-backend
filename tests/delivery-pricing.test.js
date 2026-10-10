import test from 'node:test';
import assert from 'node:assert/strict';
import { StoreSettings } from '../src/modules/settings/storeSettings.model.js';
import { defaultDeliveryZones } from '../src/modules/settings/settings.defaults.js';
import { deliveryFeeForCart, getStoreSettings, updateStoreSettings } from '../src/modules/settings/settings.service.js';
import { storeSettingsSchema } from '../src/modules/settings/settings.validation.js';
import { settingsForClient } from '../src/modules/settings/settings.routes.js';
import { calculateCartTotals } from '../src/modules/orders/pricing.service.js';
import { checkoutTotalsForItems } from '../src/modules/orders/order.service.js';

const settings = (threshold) => ({
  deliveryZones: defaultDeliveryZones, orderingSchedule: {}, freeDeliveryThreshold: threshold,
});

test('existing settings keep the previous Rs 499 default and expose it publicly', async (t) => {
  t.mock.method(StoreSettings, 'findOneAndUpdate', async () => settings(undefined));
  const loaded = await getStoreSettings();
  assert.equal(loaded.freeDeliveryThreshold, 499);
  assert.equal(settingsForClient(loaded, { headers: {} }).freeDeliveryThreshold, 499);
  assert.equal(new StoreSettings().freeDeliveryThreshold, 499);
});

test('threshold accepts zero and paise but rejects invalid amounts at API and DB boundaries', () => {
  for (const value of [0, 250, 250.01, 100000]) {
    assert.equal(storeSettingsSchema.safeParse({ freeDeliveryThreshold: value }).success, true);
    assert.equal(new StoreSettings({ freeDeliveryThreshold: value }).validateSync(), undefined);
  }
  for (const value of [-1, 100000.01, 250.001, NaN, Infinity, null, '250']) {
    assert.equal(storeSettingsSchema.safeParse({ freeDeliveryThreshold: value }).success, false);
  }
  assert.ok(new StoreSettings({ freeDeliveryThreshold: 250.001 }).validateSync());
  assert.equal(storeSettingsSchema.safeParse({}).success, false);
});

test('saving the threshold alone persists zero without replacing any other setting groups', async (t) => {
  t.mock.method(StoreSettings, 'findOneAndUpdate', async (filter, update, options) => {
    assert.deepEqual(filter, { key: 'storefront' });
    assert.deepEqual(update.$set, { freeDeliveryThreshold: 0 });
    assert.equal(options.runValidators, true);
    return settings(0);
  });
  const saved = await updateStoreSettings({ freeDeliveryThreshold: 0 });
  assert.equal(saved.freeDeliveryThreshold, 0);
  assert.deepEqual(saved.deliveryZones, defaultDeliveryZones);
});

test('threshold overrides every zone at the exact boundary while lower carts retain distance charges', async (t) => {
  t.mock.method(StoreSettings, 'findOneAndUpdate', async () => settings(250));
  for (const [distance, charge] of [[0, 20], [4, 20], [4.01, 35], [8, 35], [8.01, 50], [10, 50], [undefined, 30]]) {
    assert.equal(await deliveryFeeForCart(249.99, distance), charge);
    assert.equal(await deliveryFeeForCart(250, distance), 0);
    assert.equal(await deliveryFeeForCart(251, distance), 0);
  }
});

test('new carts pick up a changed threshold, including free delivery on every order at zero', async (t) => {
  let threshold = 250;
  t.mock.method(StoreSettings, 'findOneAndUpdate', async () => settings(threshold));
  assert.equal(await deliveryFeeForCart(300, 9), 0);
  threshold = 400;
  assert.equal(await deliveryFeeForCart(300, 9), 50);
  threshold = 0;
  assert.equal(await deliveryFeeForCart(1, 9), 0);
  assert.equal(await deliveryFeeForCart(0, 9), 0);
});

test('coupons do not remove free delivery and waived charges have zero included delivery GST', async (t) => {
  t.mock.method(StoreSettings, 'findOneAndUpdate', async () => settings(250));
  const items = [{ productId: 'a', price: 250, quantity: 1, taxRate: 18 }];
  const subtotal = calculateCartTotals({ items }).subtotal;
  const deliveryFee = await deliveryFeeForCart(subtotal, 9);
  const totals = calculateCartTotals({ items, couponDiscount: 100, deliveryFee });
  assert.equal(totals.total, 150);
  assert.equal(totals.deliveryFee, 0);
  assert.equal(totals.deliveryTax, 0);
  assert.equal(totals.deliveryTaxableValue, 0);
});

test('changed settings do not reprice an existing prepaid checkout snapshot', async (t) => {
  let threshold = 500;
  t.mock.method(StoreSettings, 'findOneAndUpdate', async () => settings(threshold));
  const items = [{ productId: 'a', price: 250, quantity: 1, taxRate: 18 }];
  const totals = calculateCartTotals({ items, deliveryFee: await deliveryFeeForCart(250, 9) });
  const snapshot = { items, totals };
  const original = JSON.stringify(snapshot);
  threshold = 100;
  assert.equal(await deliveryFeeForCart(250, 9), 0);
  const recorded = checkoutTotalsForItems([{ product: { _id: 'a' } }], snapshot);
  assert.equal(recorded.deliveryFee, 50);
  assert.equal(recorded.deliveryTax, 7.63);
  assert.equal(recorded.total, 300);
  assert.equal(JSON.stringify(snapshot), original);
});
