import { EventEmitter } from 'events';

export const INVENTORY_EVENT = 'inventory.changed';

export const inventoryEvents = new EventEmitter();
inventoryEvents.setMaxListeners(0);

export function publishInventoryChange(payload) {
  inventoryEvents.emit(INVENTORY_EVENT, {
    ...payload,
    type: INVENTORY_EVENT,
    emittedAt: new Date().toISOString(),
  });
}
