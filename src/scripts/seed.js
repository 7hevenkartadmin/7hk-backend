import slugify from 'slugify';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { User } from '../modules/users/user.model.js';
import { Category } from '../modules/catalog/category.model.js';
import { Product } from '../modules/catalog/product.model.js';
import { Coupon } from '../modules/coupons/coupon.model.js';
import { CouponRedemption } from '../modules/coupons/couponRedemption.model.js';
import { DeliverySlot } from '../modules/delivery/deliverySlot.model.js';
import { Order } from '../modules/orders/order.model.js';
import { Payment } from '../modules/payments/payment.model.js';
import { PaymentIntent } from '../modules/payments/paymentIntent.model.js';
import { AuditLog } from '../modules/audit/audit.model.js';
import { products as frontendProducts } from '../../../src/data/products.js';
import { categories as frontendCategories } from '../../../src/data/categories.js';

function productBarcode(product, index) {
  return {
    value: `8907${String(index + 1).padStart(9, '0')}`,
    format: 'EAN-13',
    source: 'frontend-seed',
  };
}

function productPayload(product, index) {
  return {
    name: product.name,
    slug: slugify(product.name, { lower: true, strict: true }),
    description: product.description || '',
    category: product.category,
    brand: product.name.split(' ')[0] || '',
    image: product.image || '',
    gallery: [],
    mrp: product.mrp,
    price: product.price,
    discount: product.discount || Math.max(0, Math.round(((product.mrp - product.price) / product.mrp) * 100)),
    unit: product.unit,
    rating: product.rating || 0,
    ratingCount: product.ratingCount || 0,
    stock: product.stock || 0,
    sku: product.sku,
    barcode: productBarcode(product, index),
    isFeatured: Boolean(product.isFeatured),
    isActive: true,
    popularity: product.popularity || 0,
    taxRate: 0,
  };
}

function categoryPayload(category, index) {
  return {
    name: category.name,
    slug: category.id,
    icon: category.icon || 'ShoppingBasket',
    image: '',
    isActive: category.id !== 'all',
    sortOrder: index,
  };
}

function nextSlot(dayOffset, startsAt, endsAt) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return { date, startsAt, endsAt, capacity: 50, serviceArea: 'Patna' };
}

await connectDatabase();

await Promise.all([
  Payment.deleteMany({}),
  PaymentIntent.deleteMany({}),
  AuditLog.deleteMany({}),
  Order.deleteMany({}),
  Category.deleteMany({}),
  Product.deleteMany({}),
  CouponRedemption.deleteMany({}),
  Coupon.deleteMany({}),
  DeliverySlot.deleteMany({}),
]);

const categoryDocs = await Category.insertMany(frontendCategories.filter((category) => category.id !== 'all').map(categoryPayload));
const productDocs = await Product.insertMany(frontendProducts.map(productPayload));

await Coupon.create({
  code: 'FRESH50',
  description: 'Rs 50 off on grocery basket',
  type: 'flat',
  value: 50,
  minOrderValue: 299,
  startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  usageLimit: 1000,
});

await DeliverySlot.insertMany([
  nextSlot(0, '14:00', '16:00'),
  nextSlot(0, '16:00', '18:00'),
  nextSlot(0, '18:00', '20:00'),
  nextSlot(1, '08:00', '10:00'),
  nextSlot(1, '10:00', '12:00'),
]);

if (process.env.NODE_ENV !== 'production') {
  const adminPasswordHash = await User.hashPassword('admin12345');
  await User.findOneAndUpdate(
    { phone: '+919999999999' },
    {
      name: '7Heven Admin',
      email: 'admin@7heven.com',
      phone: '+919999999999',
      role: 'admin',
      status: 'active',
      staffSeat: 'PRIMARY_ADMIN',
      assignmentExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
      passwordHash: adminPasswordHash,
    },
    { upsert: true, new: true },
  );
  console.log('Admin user created for development');
} else {
  console.log('Skipping admin user creation in production environment');
}

await disconnectDatabase();
console.log(`Seed complete: ${categoryDocs.length} categories, ${productDocs.length} products, 0 orders.`);
if (process.env.NODE_ENV !== 'production') console.log('Development admin user ensured: admin@7heven.com');
