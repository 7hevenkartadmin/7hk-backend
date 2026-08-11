import { EventEmitter } from 'events';

export const ORDER_EVENT = 'order.changed';

export const orderEvents = new EventEmitter();
orderEvents.setMaxListeners(0);

export function publishOrderChange(payload) {
  orderEvents.emit(ORDER_EVENT, {
    ...payload,
    type: ORDER_EVENT,
    emittedAt: new Date().toISOString(),
  });
}
