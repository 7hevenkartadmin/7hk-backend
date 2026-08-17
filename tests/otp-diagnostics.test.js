import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  createOtpDiagnostic,
  emitOtpDiagnostic,
  OTP_DIAGNOSTIC_EVENT,
  sanitizeProviderCode,
} from '../src/modules/auth/otp-diagnostics.js';
import { SecureOtpService } from '../src/modules/auth/secure-otp.service.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000036';
const SEED = 20260636;

// **Validates: Requirements 1.8, 2.8, 3.12**
test('diagnostics expose only event-specific allow-listed fields', () => {
  const accepted = createOtpDiagnostic({
    eventType: OTP_DIAGNOSTIC_EVENT.ACCEPTED,
    requestId: REQUEST_ID,
    providerCode: 'IGNORED_SAFE_CODE',
    deliveryState: 'DELIVERED',
  });
  const rejected = createOtpDiagnostic({
    eventType: OTP_DIAGNOSTIC_EVENT.PERMANENTLY_REJECTED,
    requestId: REQUEST_ID,
    providerCode: 'META_132001',
    deliveryState: 'DELIVERED',
  });
  const persistence = createOtpDiagnostic({
    eventType: OTP_DIAGNOSTIC_EVENT.PERSISTENCE_FAILED,
    requestId: REQUEST_ID,
  });
  const signedStatus = createOtpDiagnostic({
    eventType: OTP_DIAGNOSTIC_EVENT.SIGNED_WEBHOOK_STATUS,
    requestId: REQUEST_ID,
    deliveryState: 'delivered',
  });

  assert.deepEqual(Object.keys(accepted), ['eventType', 'requestId', 'timestamp']);
  assert.deepEqual(Object.keys(rejected), ['eventType', 'requestId', 'timestamp', 'providerCode']);
  assert.deepEqual(Object.keys(persistence), ['eventType', 'requestId', 'timestamp']);
  assert.deepEqual(Object.keys(signedStatus), ['eventType', 'requestId', 'timestamp', 'deliveryState']);
  assert.equal(rejected.providerCode, 'META_132001');
  assert.equal(signedStatus.deliveryState, 'DELIVERED');
  [accepted, rejected, persistence, signedStatus].forEach((event) => {
    assert.equal(event.requestId, REQUEST_ID);
    assert.equal(new Date(event.timestamp).toISOString(), event.timestamp);
  });
});

test('provider-code sanitization is bounded to uppercase digits and underscores', () => {
  fc.assert(fc.property(fc.string(), (value) => {
    const sanitized = sanitizeProviderCode(value);
    assert.match(sanitized, /^[A-Z0-9_]{1,64}$/);
    if (/^[A-Z0-9_]{1,64}$/.test(value)) assert.equal(sanitized, value);
    else assert.equal(sanitized, 'UNKNOWN_PROVIDER_CODE');
  }), { seed: SEED, numRuns: 100 });
});

test('diagnostics reject arbitrary metadata, Error objects, invalid IDs, and invalid states', () => {
  assert.throws(() => createOtpDiagnostic({
    eventType: OTP_DIAGNOSTIC_EVENT.ACCEPTED,
    requestId: REQUEST_ID,
    metadata: {},
  }), TypeError);
  assert.throws(() => createOtpDiagnostic(new Error('not accepted')), TypeError);
  assert.throws(() => createOtpDiagnostic({
    eventType: OTP_DIAGNOSTIC_EVENT.ACCEPTED,
    requestId: 'invalid',
  }), TypeError);
  assert.throws(() => createOtpDiagnostic({
    eventType: OTP_DIAGNOSTIC_EVENT.SIGNED_WEBHOOK_STATUS,
    requestId: REQUEST_ID,
    deliveryState: 'UNKNOWN',
  }), TypeError);
});

test('recursive sensitive canaries cannot enter emitted diagnostics', () => {
  const canaries = [
    'otp-canary',
    'phone-canary',
    'credential-canary',
    'access-token-canary',
    'refresh-token-canary',
    'cookie-canary',
    'message-body-canary',
    'provider-error-canary',
    'raw-payload-canary',
  ];
  const captured = [];
  const diagnostic = emitOtpDiagnostic({
    eventType: OTP_DIAGNOSTIC_EVENT.PERMANENTLY_REJECTED,
    requestId: REQUEST_ID,
    providerCode: canaries.join('-'),
  }, (event) => captured.push(event));
  const serialized = JSON.stringify({ diagnostic, captured });

  canaries.forEach((canary) => assert.equal(serialized.includes(canary), false));
  assert.equal(diagnostic.providerCode, 'UNKNOWN_PROVIDER_CODE');
});

test('a failing diagnostic sink cannot alter the sanitized event result', () => {
  const event = emitOtpDiagnostic({
    eventType: OTP_DIAGNOSTIC_EVENT.ACCEPTED,
    requestId: REQUEST_ID,
  }, () => { throw new Error('sink unavailable'); });
  assert.equal(event.eventType, OTP_DIAGNOSTIC_EVENT.ACCEPTED);
});

function persistenceFailureService(events) {
  return new SecureOtpService({
    redisClient: {
      async eval() { throw new Error('state unavailable'); },
    },
    notificationQueue: { async close() {} },
    tokenService: { identity(value) { return `digest-${value.length}`; } },
    diagnosticSink(event) { events.push(event); },
  });
}

test('acceptance persistence failure emits only its correlated safe event', async () => {
  const events = [];
  const service = persistenceFailureService(events);
  await assert.rejects(service.recordDeliveryAccepted({
    identity: 'hashed-identity',
    otpId: 'otp-id',
    providerMessageId: 'message-id',
    requestId: REQUEST_ID,
  }));
  assert.deepEqual(events.map(({ eventType, requestId }) => ({ eventType, requestId })), [{
    eventType: OTP_DIAGNOSTIC_EVENT.PERSISTENCE_FAILED,
    requestId: REQUEST_ID,
  }]);
});

test('permanent rejection remains visible when failure-state persistence also fails', async () => {
  const events = [];
  const service = persistenceFailureService(events);
  await assert.rejects(service.recordDeliveryFailed({
    identity: 'hashed-identity',
    otpId: 'otp-id',
    requestId: REQUEST_ID,
    providerCode: 'META_132001',
    permanent: true,
  }));
  assert.deepEqual(events.map(({ eventType, requestId, providerCode }) => ({
    eventType,
    requestId,
    ...(providerCode ? { providerCode } : {}),
  })), [
    {
      eventType: OTP_DIAGNOSTIC_EVENT.PERMANENTLY_REJECTED,
      requestId: REQUEST_ID,
      providerCode: 'META_132001',
    },
    { eventType: OTP_DIAGNOSTIC_EVENT.PERSISTENCE_FAILED, requestId: REQUEST_ID },
  ]);
});
