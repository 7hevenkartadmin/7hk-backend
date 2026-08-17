import mongoose from 'mongoose';

const inventoryMovementSchema = new mongoose.Schema({
  idempotencyKey: { type: String, required: true, unique: true },
  type: { type: String, enum: ['order_sold', 'order_cancelled'], required: true, index: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  variantId: mongoose.Schema.Types.ObjectId,
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  quantityDelta: { type: Number, required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reason: { type: String, required: true },
}, { timestamps: true });

inventoryMovementSchema.index({ order: 1, type: 1 });

export const InventoryMovement = mongoose.model('InventoryMovement', inventoryMovementSchema);
