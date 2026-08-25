import mongoose from 'mongoose';
import { env } from './env.js';

const REQUIRED_PRODUCTION_INDEXES = [
  ['users', { phone: 1 }, {
    name: 'user_phone_unique_when_present',
    partialFilterExpression: { phone: { $type: 'string' } },
  }],
  ['users', { staffSeat: 1 }, {
    name: 'user_staff_seat_unique',
    sparse: true,
  }],
  ['adminactiontokens', { tokenHash: 1 }, { name: 'admin_action_token_hash_unique' }],
  ['adminactiontokens', { activeTokenKey: 1 }, {
    name: 'admin_action_token_active_unique',
    sparse: true,
  }],
  ['adminactiontokens', { expiresAt: 1 }, {
    name: 'admin_action_token_expiry',
    unique: false,
    expireAfterSeconds: 0,
  }],
  ['paymentintents', { user: 1, idempotencyKey: 1 }, {
    name: 'payment_intent_user_idempotency_unique',
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  }],
  ['paymentintents', { activeDedupeKey: 1 }, {
    name: 'payment_intent_active_dedupe_unique',
    partialFilterExpression: { activeDedupeKey: { $type: 'string' } },
  }],
  ['paymentintents', { providerPaymentId: 1 }, {
    name: 'payment_intent_provider_payment_unique',
    partialFilterExpression: { providerPaymentId: { $type: 'string' } },
  }],
  ['paymentintents', { providerOrderId: 1 }, {
    name: 'payment_intent_provider_order_unique',
    partialFilterExpression: { providerOrderId: { $type: 'string' } },
  }],
  ['paymentintents', { 'reservation.state': 1, 'reservation.expiresAt': 1 }, {
    name: 'payment_intent_reservation_expiry',
    unique: false,
  }],
  ['paymentintents', { user: 1, status: 1, 'reservation.state': 1 }, {
    name: 'payment_intent_user_active_sessions',
    unique: false,
  }],
  ['payments', { providerOrderId: 1 }, {
    name: 'payment_provider_order_unique',
    partialFilterExpression: { providerOrderId: { $type: 'string' } },
  }],
  ['payments', { providerPaymentId: 1 }, {
    name: 'payment_provider_payment_unique',
    partialFilterExpression: { providerPaymentId: { $type: 'string' } },
  }],
  ['orders', { paymentIntent: 1 }, {
    name: 'order_payment_intent_unique',
    partialFilterExpression: { paymentIntent: { $type: 'objectId' } },
  }],
  ['paymentwebhookevents', { eventId: 1 }, { name: 'razorpay_webhook_event_unique' }],
  ['inventorymovements', { idempotencyKey: 1 }, { name: 'inventory_movement_idempotency_unique' }],
  ['orders', { orderNumber: 1 }, { name: 'order_number_unique' }],
  ['products', { slug: 1 }, { name: 'product_slug_unique' }],
  ['products', { sku: 1 }, { name: 'product_sku_unique' }],
  ['products', { 'variants.sku': 1 }, { name: 'product_variant_sku_unique', sparse: true }],
  ['coupons', { code: 1 }, { name: 'coupon_code_unique' }],
  ['couponredemptions', { coupon: 1, user: 1 }, {
    name: 'coupon_redemption_active_user_unique',
    partialFilterExpression: { active: true },
  }],
  ['couponredemptions', { paymentIntent: 1 }, {
    name: 'coupon_redemption_payment_intent_unique',
    partialFilterExpression: { paymentIntent: { $type: 'objectId' } },
  }],
  ['couponredemptions', { order: 1 }, {
    name: 'coupon_redemption_order_unique',
    partialFilterExpression: { order: { $type: 'objectId' } },
  }],
  ['deliveryslots', { date: 1, startsAt: 1, serviceArea: 1 }, { name: 'delivery_slot_unique' }],
  ['logincompletions', { proofDigest: 1 }, { name: 'login_completion_proof_digest_unique' }],
  ['restrictedproductconsents', { expiresAt: 1 }, {
    name: 'restricted_product_consent_expiry',
    unique: false,
    expireAfterSeconds: 0,
  }],
  ['restrictedproductconsents', { user: 1, addressId: 1, policyVersion: 1, expiresAt: -1 }, {
    name: 'restricted_product_consent_lookup',
    unique: false,
  }],
  ['supporttickets', { providerRefundId: 1 }, {
    name: 'support_ticket_provider_refund',
    partialFilterExpression: { providerRefundId: { $type: 'string' } },
  }],
  ['supporttickets', { activeOrderKey: 1 }, {
    name: 'support_ticket_active_order_unique',
    partialFilterExpression: { activeOrderKey: { $type: 'string' } },
  }],
  ['supporttickets', { status: 1, createdAt: -1 }, {
    name: 'support_ticket_status_created',
    unique: false,
  }],
];

const USER_PHONE_INDEX_NAME = 'user_phone_unique_when_present';
const LEGACY_USER_PHONE_INDEX_NAME = 'phone_1';
const USER_PHONE_INDEX_KEY = { phone: 1 };
const USER_PHONE_PARTIAL_FILTER = { phone: { $type: 'string' } };

function hasSameKey(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function listIndexes(collection) {
  try {
    return await collection.indexes();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
}

export async function ensureUserPhoneIndex(database) {
  const collection = database.collection('users');
  const indexes = await listIndexes(collection);
  const target = indexes.find((index) => index.name === USER_PHONE_INDEX_NAME);

  if (target) {
    if (!hasSameKey(target.key, USER_PHONE_INDEX_KEY)
      || target.unique !== true
      || !hasSameKey(target.partialFilterExpression, USER_PHONE_PARTIAL_FILTER)) {
      throw new Error(`User phone index options mismatch: ${USER_PHONE_INDEX_NAME}`);
    }
  } else {
    // Build the replacement while the legacy unique index still protects all
    // existing customer phone values. If creation fails, the legacy index is
    // deliberately left untouched.
    await collection.createIndex(USER_PHONE_INDEX_KEY, {
      name: USER_PHONE_INDEX_NAME,
      unique: true,
      partialFilterExpression: USER_PHONE_PARTIAL_FILTER,
    });
  }

  if (indexes.some((index) => index.name === LEGACY_USER_PHONE_INDEX_NAME)) {
    await collection.dropIndex(LEGACY_USER_PHONE_INDEX_NAME);
  }
}

async function ensureProductionIndexes(database) {
  for (const [collectionName, key, options] of REQUIRED_PRODUCTION_INDEXES) {
    const collection = database.collection(collectionName);
    const existing = (await listIndexes(collection)).find((index) => hasSameKey(index.key, key));

    const shouldBeUnique = options.unique !== false;
    if (existing) {
      if (Boolean(existing.unique) !== shouldBeUnique) {
        throw new Error(`Required index uniqueness mismatch: ${collectionName}.${existing.name}`);
      }
      continue;
    }

    const createOptions = { ...options, unique: shouldBeUnique };
    await collection.createIndex(key, createOptions);
  }
}

export async function assertDatabaseTransactionSupport(database = mongoose.connection.db, {
  startSession = () => mongoose.startSession(),
} = {}) {
  let session;
  try {
    session = await startSession();
    await session.withTransaction(async () => {
      await database.collection('logincompletions').findOne(
        { _id: null },
        { session, projection: { _id: 1 } },
      );
    });
  } catch (error) {
    throw new Error('MongoDB transaction support is required for OTP login completion', {
      cause: error,
    });
  } finally {
    if (session) await session.endSession();
  }
}

export async function connectDatabase() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGODB_URI, {
    autoIndex: false,
    serverSelectionTimeoutMS: 8000,
  });

  await ensureUserPhoneIndex(mongoose.connection.db);
  // Create only the integrity indexes the application relies on, matching by
  // key definition rather than index name. This preserves compatible legacy
  // names such as eventId_1 and avoids broad development index rebuilds.
  await ensureProductionIndexes(mongoose.connection.db);

  if (env.NODE_ENV === 'production') {
    await assertDatabaseTransactionSupport(mongoose.connection.db);
  }
  console.log('Connected to MongoDB');
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
