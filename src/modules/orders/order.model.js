import mongoose from 'mongoose';

export const ORDER_STATUSES = ['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled'];

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, required: true },
  sku: { type: String, required: true },
  unit: { type: String, required: true },
  category: { type: String, default: '' },
  image: { type: String, default: '' },
  quantity: { type: Number, min: 1, required: true },
  price: { type: Number, min: 0, required: true },
  mrp: { type: Number, min: 0, required: true },
  taxRate: { type: Number, min: 0, default: 0 },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, unique: true, index: true, required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  customerSnapshot: {
    name: String,
    phone: String,
    email: String,
  },
  items: [orderItemSchema],
  address: {
    label: String,
    recipientName: String,
    phone: String,
    line1: String,
    line2: String,
    landmark: String,
    city: String,
    state: String,
    pincode: String,
    latitude: Number,
    longitude: Number,
    distanceFromStoreKm: Number,
  },
  slot: {
    slotId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliverySlot' },
    date: Date,
    startsAt: String,
    endsAt: String,
  },
  couponCode: String,
  subtotal: { type: Number, min: 0, required: true },
  discount: { type: Number, min: 0, default: 0 },
  deliveryFee: { type: Number, min: 0, default: 0 },
  tax: { type: Number, min: 0, default: 0 },
  total: { type: Number, min: 0, required: true },
  paymentMethod: { type: String, enum: ['razorpay', 'cod'], required: true },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'partially_refunded', 'refunded'], default: 'pending' },
  paymentIntent: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentIntent' },
  status: { type: String, enum: ORDER_STATUSES, default: 'placed', index: true },
  statusTimeline: [{
    status: { type: String, enum: ORDER_STATUSES },
    note: String,
    at: { type: Date, default: Date.now },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  }],
  invoice: {
    number: String,
    issuedAt: Date,
    url: String,
  },
  deliveryAgent: {
    name: String,
    phone: String,
  },
  inventoryRestoredAt: Date,
}, { timestamps: true });

orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ paymentStatus: 1, createdAt: -1 });
orderSchema.index(
  { paymentIntent: 1 },
  { name: 'order_payment_intent_unique', unique: true, partialFilterExpression: { paymentIntent: { $type: 'objectId' } } },
);
orderSchema.index({ 'customerSnapshot.name': 1 });
orderSchema.index({ 'customerSnapshot.phone': 1 });
orderSchema.index({ 'address.phone': 1 });

export const Order = mongoose.model('Order', orderSchema);
