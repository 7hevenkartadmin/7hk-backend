import mongoose from 'mongoose';
import { env } from './env.js';

const REQUIRED_PRODUCTION_INDEXES = [
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
  ['logincompletions', { proofDigest: 1 }, { name: 'login_completion_proof_digest_unique' }],
];

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

async function ensureProductionIndexes(database) {
  for (const [collectionName, key, options] of REQUIRED_PRODUCTION_INDEXES) {
    const collection = database.collection(collectionName);
    const existing = (await listIndexes(collection)).find((index) => hasSameKey(index.key, key));

    // An older deployment may have created the same index under Mongo's default
    // name. Reusing it avoids IndexOptionsConflict on every application restart.
    if (existing) {
      if (!existing.unique) {
        throw new Error(`Required unique index is non-unique: ${collectionName}.${existing.name}`);
      }
      continue;
    }

    await collection.createIndex(key, { ...options, unique: true });
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
    autoIndex: env.NODE_ENV !== 'production',
    serverSelectionTimeoutMS: 8000,
  });

  // Development models already build their declared indexes. Production keeps
  // autoIndex disabled and creates only integrity indexes relied on at runtime.
  if (env.NODE_ENV === 'production') {
    await ensureProductionIndexes(mongoose.connection.db);
    await assertDatabaseTransactionSupport(mongoose.connection.db);
  }
  console.log('Connected to MongoDB');
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
