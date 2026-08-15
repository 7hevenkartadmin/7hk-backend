import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Redis from 'ioredis';
import { env } from '../src/config/env.js';
import { OtpTokenService } from '../src/modules/auth/otp-token.service.js';
import { SecureOtpService } from '../src/modules/auth/secure-otp.service.js';

const testSecret = 'test-only-otp-hmac-secret-that-is-long-enough-1234567890';

function createPayload(phone) {
  return {
    userId: phone,
    recipient: phone,
    purpose: 'LOGIN',
    channel: 'WHATSAPP',
    requestId: crypto.randomUUID(),
  };
}

async function createRedisHarness(t) {
  const redisClient = new Redis(env.REDIS_URL, {
    connectTimeout: 1000,
    retryStrategy: () => null,
  });

  try {
    await redisClient.ping();
  } catch {
    redisClient.disconnect();
    t.skip('Redis is not available for the atomic OTP integration test');
    return null;
  }

  const jobs = [];
  const notificationQueue = {
    async enqueueOtp(payload) {
      jobs.push(payload);
      return { jobId: crypto.randomUUID(), status: 'QUEUED' };
    },
    async close() {},
  };
  const tokenService = new OtpTokenService(testSecret);
  const service = new SecureOtpService({
    redisClient,
    notificationQueue,
    tokenService,
    ttlSeconds: 30,
    maxAttempts: 5,
    requestLimit: 20,
    requestWindowSeconds: 30,
    resendCooldownSeconds: 30,
  });

  t.after(async () => {
    if (redisClient.status !== 'end') await service.close();
  });

  return { redisClient, jobs, service, tokenService };
}

async function markLatestJobDelivered(harness) {
  const job = harness.jobs.at(-1);
  const providerMessageId = `wamid.${crypto.randomUUID()}`;
  await harness.service.recordDeliveryAccepted({
    identity: job.userId,
    otpId: job.otpId,
    providerMessageId,
  });
  await harness.service.recordProviderStatus(providerMessageId, 'delivered');
}

test('OTP hashes are keyed, identity-bound, and deterministic', () => {
  const tokenService = new OtpTokenService(testSecret);
  const otp = '123456';
  const identity = tokenService.identity('+919876543210:LOGIN');

  assert.equal(tokenService.hash(otp, identity), tokenService.hash(otp, identity));
  assert.notEqual(tokenService.hash(otp, identity), tokenService.hash(otp, 'different-identity'));
  assert.notEqual(tokenService.hash(otp, identity), crypto.createHash('sha256').update(otp).digest('hex'));
  assert.doesNotMatch(identity, /9876543210/);
});

test('a correct OTP can be consumed exactly once under concurrent verification', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now()).slice(-10)}`);
  await harness.service.requestOtp(payload);
  await markLatestJobDelivered(harness);
  const otp = harness.jobs[0].otp;

  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => harness.service.verifyOtp({ ...payload, otp })),
  );

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 11);
  results
    .filter((result) => result.status === 'rejected')
    .forEach((result) => assert.equal(result.reason.code, 'OTP_INVALID'));
});

test('concurrent invalid guesses atomically exhaust the attempt budget', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 1).slice(-10)}`);
  await harness.service.requestOtp(payload);
  await markLatestJobDelivered(harness);
  const correctOtp = harness.jobs[0].otp;

  await Promise.allSettled(
    Array.from({ length: 12 }, () => harness.service.verifyOtp({ ...payload, otp: '000000' })),
  );

  await assert.rejects(
    harness.service.verifyOtp({ ...payload, otp: correctOtp }),
    (error) => error.code === 'OTP_INVALID',
  );
});

test('OTP verification does not wait for an asynchronous delivery webhook', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 2).slice(-10)}`);
  const request = await harness.service.requestOtp(payload);
  const otp = harness.jobs[0].otp;

  assert.deepEqual(request, { expiresIn: 30, resendAfterSeconds: 30 });
  await assert.doesNotReject(harness.service.verifyOtp({ ...payload, otp }));
});

test('request and resend share an atomic per-customer cooldown', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 3).slice(-10)}`);
  await harness.service.requestOtp(payload);
  await assert.rejects(
    harness.service.resendOtp(payload),
    (error) => error.code === 'OTP_RESEND_COOLDOWN'
      && error.details.retryAfterSeconds > 0,
  );
  assert.equal(harness.jobs.length, 1);
});

test('late WhatsApp callbacks cannot move a delivered OTP backwards', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 4).slice(-10)}`);
  await harness.service.requestOtp(payload);
  const job = harness.jobs[0];
  const providerMessageId = `wamid.${crypto.randomUUID()}`;

  await harness.service.recordDeliveryAccepted({
    identity: job.userId,
    otpId: job.otpId,
    providerMessageId,
  });
  await harness.service.recordProviderStatus(providerMessageId, 'delivered');
  await harness.service.recordProviderStatus(providerMessageId, 'sent');
  await harness.service.recordProviderStatus(providerMessageId, 'failed');

  const status = await harness.redisClient.hget(`otp:challenge:${job.userId}`, 'deliveryStatus');
  assert.equal(status, 'DELIVERED');
});
