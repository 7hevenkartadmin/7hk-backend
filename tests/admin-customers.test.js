import test from 'node:test';
import assert from 'node:assert/strict';
import { adminCustomersQuerySchema } from '../src/modules/admin/admin.validation.js';
import { listAdminCustomers } from '../src/modules/admin/admin.service.js';
import { User } from '../src/modules/users/user.model.js';

test('customer pagination validates pages and fixes request size at 20', () => {
  assert.deepEqual(adminCustomersQuerySchema.parse({}), { page: 1, limit: 20 });
  for (const query of [{ page: 0 }, { page: 1.5 }, { limit: 200 }, { limit: 10 }, { status: 'owner' }, { search: 'x'.repeat(81) }]) {
    assert.equal(adminCustomersQuerySchema.safeParse(query).success, false);
  }
});

test('customer pages cover older records; search and status apply before pagination', async (t) => {
  const rows = Array.from({ length: 245 }, (_, index) => ({
    _id: String(index).padStart(3, '0'), createdAt: new Date(2026, 0, 1),
    name: index === 0 ? 'Older Customer [test]' : `Customer ${index}`,
    email: `customer${index}@example.com`, phone: `90000${String(index).padStart(5, '0')}`,
    role: index === 244 ? 'admin' : 'customer', status: index % 2 ? 'blocked' : 'active',
  }));
  const matches = (row, filter) => row.role === filter.role
    && (!filter.status || row.status === filter.status)
    && (!filter.$or || filter.$or.some((clause) => Object.entries(clause).some(([field, regex]) => regex.test(row[field]))));
  t.mock.method(User, 'find', (filter) => {
    let selected = rows.filter((row) => matches(row, filter));
    return {
      select(fields) { assert.equal(fields.includes('refreshTokenHash'), false); return this; },
      sort(sort) {
        assert.deepEqual(sort, { createdAt: -1, _id: -1 });
        selected.sort((a, b) => b._id.localeCompare(a._id));
        return this;
      },
      skip(count) { selected = selected.slice(count); return this; },
      limit(count) { selected = selected.slice(0, count); return this; },
      async lean() { return selected; },
    };
  });
  t.mock.method(User, 'countDocuments', async (filter) => rows.filter((row) => matches(row, filter)).length);

  const first = await listAdminCustomers({ page: 1 });
  const second = await listAdminCustomers({ page: 2 });
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 20);
  assert.equal(second.items.some((item) => first.items.some((previous) => previous._id === item._id)), false);
  assert.deepEqual(first.meta, { total: 244, page: 1, limit: 20, pages: 13 });
  const last = await listAdminCustomers({ page: 13 });
  assert.equal(last.items.length, 4);
  assert.equal(last.items.at(-1)._id, '000');

  const searched = await listAdminCustomers({ page: 1, search: '[TEST]', status: 'active' });
  assert.equal(searched.meta.total, 1);
  assert.equal(searched.items[0]._id, '000');
  const blocked = await listAdminCustomers({ page: 1, search: '[test]', status: 'blocked' });
  assert.equal(blocked.items.length, 0);
  assert.equal(blocked.meta.total, 0);
  assert.equal(blocked.meta.pages, 1);
  const outside = await listAdminCustomers({ page: 20 });
  assert.equal(outside.items.length, 0);
  assert.equal(outside.meta.total, 244);
});
