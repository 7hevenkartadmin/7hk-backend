import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureUserPhoneIndex } from '../src/config/database.js';

function databaseFixture(initialIndexes, { createError } = {}) {
  const indexes = initialIndexes.map((index) => ({ ...index }));
  const events = [];
  const collection = {
    indexes: async () => indexes.map((index) => ({ ...index })),
    createIndex: async (key, options) => {
      events.push({ action: 'create', key, options });
      if (createError) throw createError;
      indexes.push({ key, ...options });
      return options.name;
    },
    dropIndex: async (name) => {
      events.push({ action: 'drop', name });
      const position = indexes.findIndex((index) => index.name === name);
      if (position >= 0) indexes.splice(position, 1);
    },
  };
  return { database: { collection: () => collection }, events };
}

test('phone index migration creates the partial replacement before dropping the legacy index', async () => {
  const fixture = databaseFixture([
    { name: '_id_', key: { _id: 1 }, unique: true },
    { name: 'phone_1', key: { phone: 1 }, unique: true },
  ]);

  await ensureUserPhoneIndex(fixture.database);

  assert.deepEqual(fixture.events.map((event) => event.action), ['create', 'drop']);
  assert.deepEqual(fixture.events[0].key, { phone: 1 });
  assert.equal(fixture.events[0].options.unique, true);
  assert.deepEqual(fixture.events[0].options.partialFilterExpression, { phone: { $type: 'string' } });
  assert.equal(fixture.events[1].name, 'phone_1');
});

test('phone index migration leaves the legacy protection intact if replacement creation fails', async () => {
  const fixture = databaseFixture(
    [{ name: 'phone_1', key: { phone: 1 }, unique: true }],
    { createError: new Error('index build failed') },
  );

  await assert.rejects(() => ensureUserPhoneIndex(fixture.database), /index build failed/u);
  assert.deepEqual(fixture.events.map((event) => event.action), ['create']);
});

test('phone index migration is idempotent after the partial index is installed', async () => {
  const fixture = databaseFixture([{
    name: 'user_phone_unique_when_present',
    key: { phone: 1 },
    unique: true,
    partialFilterExpression: { phone: { $type: 'string' } },
  }]);

  await ensureUserPhoneIndex(fixture.database);
  assert.deepEqual(fixture.events, []);
});
