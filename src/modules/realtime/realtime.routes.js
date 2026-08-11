import { Router } from 'express';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { INVENTORY_EVENT, inventoryEvents } from '../../shared/realtime/inventory.events.js';
import { ORDER_EVENT, orderEvents } from '../../shared/realtime/order.events.js';
import { openSseStream, sendSseEvent } from '../../shared/realtime/sse.js';

export const realtimeRoutes = Router();

function streamAdminEvents(req, res, scope = 'admin') {
  openSseStream(req, res);
  sendSseEvent(res, 'connected', { scope, connectedAt: new Date().toISOString() });

  const heartbeat = setInterval(() => {
    sendSseEvent(res, 'heartbeat', { at: new Date().toISOString() });
  }, 25000);

  const onInventoryChange = (payload) => {
    sendSseEvent(res, INVENTORY_EVENT, payload);
  };

  const onOrderChange = (payload) => {
    sendSseEvent(res, ORDER_EVENT, payload);
  };

  inventoryEvents.on(INVENTORY_EVENT, onInventoryChange);
  orderEvents.on(ORDER_EVENT, onOrderChange);

  req.on('close', () => {
    clearInterval(heartbeat);
    inventoryEvents.off(INVENTORY_EVENT, onInventoryChange);
    orderEvents.off(ORDER_EVENT, onOrderChange);
    res.end();
  });
}

function streamCustomerOrderEvents(req, res) {
  const customerId = String(req.user._id);
  openSseStream(req, res);
  sendSseEvent(res, 'connected', { scope: 'customer.orders', connectedAt: new Date().toISOString() });

  const heartbeat = setInterval(() => {
    sendSseEvent(res, 'heartbeat', { at: new Date().toISOString() });
  }, 25000);

  const onOrderChange = (payload) => {
    if (String(payload.customerId || '') !== customerId) return;
    sendSseEvent(res, ORDER_EVENT, payload);
  };

  orderEvents.on(ORDER_EVENT, onOrderChange);

  req.on('close', () => {
    clearInterval(heartbeat);
    orderEvents.off(ORDER_EVENT, onOrderChange);
    res.end();
  });
}

realtimeRoutes.get('/admin', requireAuth, authorize('admin', 'manager'), (req, res) => {
  streamAdminEvents(req, res);
});

realtimeRoutes.get('/inventory', requireAuth, authorize('admin', 'manager'), (req, res) => {
  streamAdminEvents(req, res, 'inventory');
});

realtimeRoutes.get('/orders', requireAuth, (req, res) => {
  streamCustomerOrderEvents(req, res);
});
