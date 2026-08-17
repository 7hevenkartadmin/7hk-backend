import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Redis from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import { env } from '../src/config/env.js';
import {
  createOtpNotificationWorker,
  processOtpNotificationJob,
} from '../src/modules/auth/otp-notification.worker.js';
import { unavailableIntegrationFixture } from './integration-fixture-policy.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000037';

function job(overrides = {}) {
  return {
    name: 'send-otp',
    data: {
      purpose: 'LOGIN',
      userId: 'hashed-identity',
      otpId: 'otp-id',
      requestId: REQUEST_ID,
    },
    opts: { attempts: 3 },
    attemptsMade: 0,
    ...overrides,
  };
}

// **Validates: Requirements 1.8, 2.8, 3.6, 3.12**
test('accepted provider result persists correlation with the originating request ID', async () => {
  const accepted = [];
  const result = await processOtpNotificationJob(job(), {
    provider: {
      async sendLoginOtp() {
        return { provider: 'meta-whatsapp-cloud', providerMessageId: 'message-id', status: 'ACCEPTED' };
      },
    },
    otpService: {
      async recordDeliveryAccepted(value) { accepted.push(value); },
    },
  });

  assert.deepEqual(result, { provider: 'meta-whatsapp-cloud', status: 'ACCEPTED' });
  assert.deepEqual(accepted, [{
    identity: 'hashed-identity',
    otpId: 'otp-id',
    providerMessageId: 'message-id',
    requestId: REQUEST_ID,
  }]);
});

test('permanent rejection records one sanitized-code diagnostic path and is unrecoverable', async () => {
  const failures = [];
  const providerError = Object.assign(new Error('provider rejected'), {
    code: 'META_132001',
    retryable: false,
  });

  await assert.rejects(processOtpNotificationJob(job(), {
    provider: { async sendLoginOtp() { throw providerError; } },
    otpService: { async recordDeliveryFailed(value) { failures.push(value); } },
  }), (error) => error.name === 'UnrecoverableError' && error.message === 'META_132001');

  assert.deepEqual(failures, [{
    identity: 'hashed-identity',
    otpId: 'otp-id',
    requestId: REQUEST_ID,
    providerCode: 'META_132001',
    permanent: true,
  }]);
});

test('provider acceptance followed by persistence failure cannot trigger a duplicate send retry', async () => {
  let providerCalls = 0;
  await assert.rejects(processOtpNotificationJob(job(), {
    provider: {
      async sendLoginOtp() {
        providerCalls += 1;
        return { provider: 'meta-whatsapp-cloud', providerMessageId: 'message-id', status: 'ACCEPTED' };
      },
    },
    otpService: {
      async recordDeliveryAccepted() { throw new Error('state unavailable'); },
    },
  }), (error) => error.name === 'UnrecoverableError'
    && error.message === 'OTP_DELIVERY_STATE_UPDATE_FAILED');
  assert.equal(providerCalls, 1);
});

test('retryable rejection remains retryable before the configured final attempt', async () => {
  const providerError = Object.assign(new Error('temporary provider failure'), {
    code: 'META_TIMEOUT',
    retryable: true,
  });
  let failureRecords = 0;

  await assert.rejects(processOtpNotificationJob(job(), {
    provider: { async sendLoginOtp() { throw providerError; } },
    otpService: { async recordDeliveryFailed() { failureRecords += 1; } },
  }), (error) => error === providerError);
  assert.equal(failureRecords, 0);
});


test('worker sanitizes malformed provider codes and never records provider error text', async () => {
  const canaries = [
    'otp-canary',
    'phone-canary',
    'credential-canary',
    'token-canary',
    'cookie-canary',
    'message-canary',
    'raw-payload-canary',
    'provider-error-canary',
  ];
  const failures = [];
  const providerError = Object.assign(new Error(canaries.at(-1)), {
    code: canaries.join('-'),
    retryable: false,
  });

  await assert.rejects(processOtpNotificationJob(job(), {
    provider: { async sendLoginOtp() { throw providerError; } },
    otpService: { async recordDeliveryFailed(value) { failures.push(value); } },
  }), (error) => error.name === 'UnrecoverableError'
    && error.message === 'UNKNOWN_PROVIDER_CODE');

  const serialized = JSON.stringify(failures);
  canaries.forEach((canary) => assert.equal(serialized.includes(canary), false));
  assert.equal(failures[0].providerCode, 'UNKNOWN_PROVIDER_CODE');
});

function redisConnectionOptions(redisUrl) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number(parsed.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
    ...(parsed.protocol === 'rediss:' ? { tls: { servername: parsed.hostname } } : {}),
  };
}

// **Validates: Requirements 2.8, 3.6, 3.12**
test('BullMQ treats accepted-but-unpersisted delivery as unrecoverable without resending', async (t) => {
  const probe = new Redis(env.REDIS_URL, {
    connectTimeout: 1000,
    retryStrategy: () => null,
    maxRetriesPerRequest: null,
  });
  try {
    await probe.ping();
  } catch (error) {
    probe.disconnect();
    unavailableIntegrationFixture(t, 'Redis BullMQ OTP worker', error);
    return;
  }
  probe.disconnect();

  const queueName = `otp-diagnostic-test-${crypto.randomUUID()}`;
  const connection = redisConnectionOptions(env.REDIS_URL);
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });
  let providerCalls = 0;
  const worker = createOtpNotificationWorker({
    queueName,
    connection,
    provider: {
      async sendLoginOtp() {
        providerCalls += 1;
        return {
          provider: 'meta-whatsapp-cloud',
          providerMessageId: `wamid.${crypto.randomUUID()}`,
          status: 'ACCEPTED',
        };
      },
    },
    otpService: {
      async recordDeliveryAccepted() { throw new Error('state unavailable'); },
    },
  });

  t.after(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await Promise.all([queueEvents.close(), queue.close()]);
  });

  await Promise.all([worker.waitUntilReady(), queueEvents.waitUntilReady()]);
  const queuedJob = await queue.add('send-otp', job().data, {
    attempts: 3,
    backoff: { type: 'fixed', delay: 10 },
    removeOnFail: false,
  });

  await assert.rejects(
    queuedJob.waitUntilFinished(queueEvents, 5000),
    (error) => error.message.includes('OTP_DELIVERY_STATE_UPDATE_FAILED'),
  );
  assert.equal(providerCalls, 1);
  assert.equal((await queuedJob.getState()), 'failed');
});