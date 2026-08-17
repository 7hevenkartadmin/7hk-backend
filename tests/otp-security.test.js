import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Redis from 'ioredis';
import { env } from '../src/config/env.js';
import { OtpTokenService } from '../src/modules/auth/otp-token.service.js';
import { SecureOtpService } from '../src/modules/auth/secure-otp.service.js';
import { unavailableIntegrationFixture } from './integration-fixture-policy.js';

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
  } catch (error) {
    redisClient.disconnect();
    unavailableIntegrationFixture(t, 'Redis atomic OTP', error);
    return null;
  }

  const jobs = [];
  const diagnosticEvents = [];
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
    correlationTtlSeconds: 120,
    diagnosticSink(event) { diagnosticEvents.push(event); },
  });

  t.after(async () => {
    if (redisClient.status !== 'end') await service.close();
  });

  return { redisClient, jobs, diagnosticEvents, service, tokenService };
}

async function markLatestJobDelivered(harness) {
  const job = harness.jobs.at(-1);
  const providerMessageId = `wamid.${crypto.randomUUID()}`;
  await harness.service.recordDeliveryAccepted({
    identity: job.userId,
    otpId: job.otpId,
    providerMessageId,
    requestId: job.requestId,
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

test('concurrent correct submissions resolve to one bounded verified proof', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now()).slice(-10)}`);
  await harness.service.requestOtp(payload);
  await markLatestJobDelivered(harness);
  const job = harness.jobs[0];

  const results = await Promise.all(
    Array.from({ length: 12 }, () => harness.service.verifyOtp({ ...payload, otp: job.otp })),
  );

  assert.equal(new Set(results.map((result) => result.proofId)).size, 1);
  assert.ok(results.every((result) => result.status === 'OTP_VERIFIED'));

  const proof = await harness.redisClient.hgetall(`otp:verified:${job.userId}`);
  const proofTtl = await harness.redisClient.pttl(`otp:verified:${job.userId}`);
  assert.deepEqual(Object.keys(proof).sort(), ['otpHash', 'proofId', 'state']);
  assert.equal(proof.state, 'VERIFIED');
  assert.equal(proof.proofId, results[0].proofId);
  assert.ok(proofTtl > 0 && proofTtl <= 30000);
  assert.equal(await harness.redisClient.exists(`otp:challenge:${job.userId}`), 0);
  assert.doesNotMatch(JSON.stringify(proof), new RegExp(payload.recipient.replace('+', '\\+')));
  assert.doesNotMatch(JSON.stringify(proof), new RegExp(job.otp));
});

test('a correct retry reuses its proof without extending the original expiry', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 20).slice(-10)}`);
  await harness.service.requestOtp(payload);
  const job = harness.jobs[0];
  const first = await harness.service.verifyOtp({ ...payload, otp: job.otp });
  const firstTtl = await harness.redisClient.pttl(`otp:verified:${job.userId}`);
  assert.equal(await harness.service.markVerifiedProofCompleted(payload, first.proofId), true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const retry = await harness.service.verifyOtp({ ...payload, otp: job.otp });
  const retryTtl = await harness.redisClient.pttl(`otp:verified:${job.userId}`);

  assert.equal(retry.proofId, first.proofId);
  assert.equal(
    await harness.redisClient.hget(`otp:verified:${job.userId}`, 'state'),
    'COMPLETED',
  );
  assert.ok(retryTtl > 0 && retryTtl < firstTtl);
});

// **Validates: Requirements 2.6, 3.10, 3.12**
test('terminal denial closes a proof, removes retry material, and remains idempotent', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 21).slice(-10)}`);
  await harness.service.requestOtp(payload);
  const job = harness.jobs[0];
  const verification = await harness.service.verifyOtp({ ...payload, otp: job.otp });
  const proofKey = `otp:verified:${job.userId}`;
  const ttlBeforeClosure = await harness.redisClient.pttl(proofKey);

  assert.equal(await harness.service.markVerifiedProofCompleted(payload, verification.proofId), true);
  assert.equal(await harness.service.denyVerifiedProof(payload, verification.proofId), true);
  assert.equal(await harness.service.denyVerifiedProof(payload, verification.proofId), true);
  assert.equal(await harness.service.denyVerifiedProof(payload, crypto.randomUUID()), false);
  assert.equal(await harness.service.markVerifiedProofCompleted(payload, verification.proofId), false);
  await assert.rejects(
    harness.service.verifyOtp({ ...payload, otp: job.otp }),
    (error) => error.code === 'OTP_INVALID',
  );

  const closedProof = await harness.redisClient.hgetall(proofKey);
  const ttlAfterClosure = await harness.redisClient.pttl(proofKey);
  assert.deepEqual(closedProof, { proofId: verification.proofId, state: 'DENIED' });
  assert.ok(ttlAfterClosure > 0 && ttlAfterClosure <= ttlBeforeClosure);
});

// **Validates: Requirements 2.6, 3.3**
test('wrong guesses against a verified proof reveal nothing and do not mutate it', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 22).slice(-10)}`);
  await harness.service.requestOtp(payload);
  const job = harness.jobs[0];
  const verification = await harness.service.verifyOtp({ ...payload, otp: job.otp });
  const proofKey = `otp:verified:${job.userId}`;
  const before = await harness.redisClient.hgetall(proofKey);
  const ttlBefore = await harness.redisClient.pttl(proofKey);

  await assert.rejects(
    harness.service.verifyOtp({ ...payload, otp: job.otp === '000000' ? '111111' : '000000' }),
    (error) => {
      assert.equal(error.code, 'OTP_INVALID');
      assert.equal(JSON.stringify({ message: error.message, code: error.code }).includes(verification.proofId), false);
      return true;
    },
  );

  assert.deepEqual(await harness.redisClient.hgetall(proofKey), before);
  const ttlAfter = await harness.redisClient.pttl(proofKey);
  assert.ok(ttlAfter > 0 && ttlAfter <= ttlBefore);
});

// **Validates: Requirements 2.6**
test('verified proof inherits the challenge remaining TTL and expires without extension', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 23).slice(-10)}`);
  await harness.service.requestOtp(payload);
  const job = harness.jobs[0];
  const challengeKey = `otp:challenge:${job.userId}`;
  const proofKey = `otp:verified:${job.userId}`;
  assert.equal(await harness.redisClient.pexpire(challengeKey, 250), 1);
  const challengeTtl = await harness.redisClient.pttl(challengeKey);

  await harness.service.verifyOtp({ ...payload, otp: job.otp });
  const proofTtl = await harness.redisClient.pttl(proofKey);
  assert.ok(proofTtl > 0 && proofTtl <= challengeTtl);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await harness.redisClient.exists(proofKey), 0);
  await assert.rejects(
    harness.service.verifyOtp({ ...payload, otp: job.otp }),
    (error) => error.code === 'OTP_INVALID',
  );
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
    requestId: job.requestId,
  });
  await harness.service.recordProviderStatus(providerMessageId, 'delivered');
  await harness.service.recordProviderStatus(providerMessageId, 'sent');
  await harness.service.recordProviderStatus(providerMessageId, 'failed');

  const status = await harness.redisClient.hget(`otp:challenge:${job.userId}`, 'deliveryStatus');
  assert.equal(status, 'DELIVERED');
});

test('early signed status reconciles after acceptance with retained request correlation', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 5).slice(-10)}`);
  await harness.service.requestOtp(payload);
  const job = harness.jobs[0];
  const providerMessageId = `wamid.${crypto.randomUUID()}`;

  assert.equal(await harness.service.recordProviderStatus(providerMessageId, 'delivered'), false);
  assert.deepEqual(harness.diagnosticEvents, []);
  await harness.service.recordDeliveryAccepted({
    identity: job.userId,
    otpId: job.otpId,
    providerMessageId,
    requestId: job.requestId,
  });

  const messageKey = `otp:message:${harness.tokenService.identity(`meta-message:${providerMessageId}`)}`;
  const mapping = JSON.parse(await harness.redisClient.get(messageKey));
  const mappingTtl = await harness.redisClient.ttl(messageKey);
  const status = await harness.redisClient.hget(`otp:challenge:${job.userId}`, 'deliveryStatus');

  assert.deepEqual(mapping, {
    challengeKey: `otp:challenge:${job.userId}`,
    otpId: job.otpId,
    requestId: job.requestId,
  });
  assert.ok(mappingTtl > 30 && mappingTtl <= 120);
  assert.equal(status, 'DELIVERED');
  assert.deepEqual(
    harness.diagnosticEvents.map(({ eventType, requestId, deliveryState }) => (
      { eventType, requestId, ...(deliveryState ? { deliveryState } : {}) }
    )),
    [
      { eventType: 'ACCEPTED', requestId: job.requestId },
      { eventType: 'SIGNED_WEBHOOK_STATUS', requestId: job.requestId, deliveryState: 'DELIVERED' },
    ],
  );
  const serialized = JSON.stringify({ mapping, events: harness.diagnosticEvents });
  assert.equal(serialized.includes(payload.recipient), false);
  assert.equal(serialized.includes(job.otp), false);
});

test('provider-message correlation survives proof creation for late signed diagnostics', async (t) => {
  const harness = await createRedisHarness(t);
  if (!harness) return;

  const payload = createPayload(`+91${String(Date.now() + 6).slice(-10)}`);
  await harness.service.requestOtp(payload);
  const job = harness.jobs[0];
  const providerMessageId = `wamid.${crypto.randomUUID()}`;
  await harness.service.recordDeliveryAccepted({
    identity: job.userId,
    otpId: job.otpId,
    providerMessageId,
    requestId: job.requestId,
  });
  await harness.service.verifyOtp({ ...payload, otp: job.otp });
  harness.diagnosticEvents.length = 0;

  assert.equal(await harness.service.recordProviderStatus(providerMessageId, 'read'), false);
  assert.deepEqual(
    harness.diagnosticEvents.map(({ eventType, requestId, deliveryState }) => (
      { eventType, requestId, deliveryState }
    )),
    [{ eventType: 'SIGNED_WEBHOOK_STATUS', requestId: job.requestId, deliveryState: 'READ' }],
  );
});
