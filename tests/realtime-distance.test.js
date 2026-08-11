import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceInKm } from '../src/shared/utils/distance.js';
import { openSseStream, sendSseEvent } from '../src/shared/realtime/sse.js';
import { INVENTORY_EVENT, inventoryEvents, publishInventoryChange } from '../src/shared/realtime/inventory.events.js';
import { ORDER_EVENT, orderEvents, publishOrderChange } from '../src/shared/realtime/order.events.js';

function mockSseReq() {
  return {
    socket: {
      timeout: null,
      keepAlive: null,
      setTimeout(value) {
        this.timeout = value;
      },
      setKeepAlive(value) {
        this.keepAlive = value;
      },
    },
  };
}

function mockSseRes() {
  return {
    statusCode: null,
    headers: null,
    chunks: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(headers) {
      this.headers = headers;
      return this;
    },
    flushHeaders() {
      this.flushed = true;
    },
    write(chunk) {
      this.chunks.push(chunk);
    },
  };
}

test('distance utility returns zero for same coordinates and expected nearby distance', () => {
  const store = { latitude: 26.713052497465416, longitude: 85.68640273918543 };
  assert.equal(distanceInKm(store, store), 0);

  const oneKmNorthApprox = { latitude: store.latitude + 0.009, longitude: store.longitude };
  const distance = distanceInKm(store, oneKmNorthApprox);
  assert.ok(distance > 0.9 && distance < 1.1);
});

test('openSseStream configures no-buffer event-stream response', () => {
  const req = mockSseReq();
  const res = mockSseRes();

  openSseStream(req, res);

  assert.equal(req.socket.timeout, 0);
  assert.equal(req.socket.keepAlive, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  assert.deepEqual(res.chunks, [': connected\n\n']);
});

test('sendSseEvent serializes named event and JSON data', () => {
  const res = mockSseRes();
  sendSseEvent(res, 'order.changed', { orderId: 'order-1', status: 'packed' });

  assert.equal(res.chunks.join(''), 'event: order.changed\ndata: {"orderId":"order-1","status":"packed"}\n\n');
});

test('inventory and order publishers decorate payloads with type and emitted timestamp', async () => {
  const inventoryPayload = await new Promise((resolve) => {
    inventoryEvents.once(INVENTORY_EVENT, resolve);
    publishInventoryChange({ action: 'product.updated', productId: 'p1', stock: 4 });
  });

  assert.equal(inventoryPayload.type, INVENTORY_EVENT);
  assert.equal(inventoryPayload.action, 'product.updated');
  assert.equal(inventoryPayload.stock, 4);
  assert.ok(Date.parse(inventoryPayload.emittedAt));

  const orderPayload = await new Promise((resolve) => {
    orderEvents.once(ORDER_EVENT, resolve);
    publishOrderChange({ action: 'order.status.updated', orderId: 'o1', customerId: 'c1', status: 'packed' });
  });

  assert.equal(orderPayload.type, ORDER_EVENT);
  assert.equal(orderPayload.customerId, 'c1');
  assert.equal(orderPayload.status, 'packed');
  assert.ok(Date.parse(orderPayload.emittedAt));
});
