import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { requestOtpSchema, verifyOtpSchema } from '../src/modules/auth/auth.validation.js';
import {
  hashToken,
  tokenLifetimeMs,
} from '../src/modules/auth/token.service.js';
import { createLoginCompletionHarness } from './helpers/login-completion-harness.js';

const SEED = 20260607;
const root = new URL('../', import.meta.url);
const source = async (relativePath) => readFile(new URL(relativePath, root), 'utf8');

const validSyntheticEnvironment = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/synthetic-test',
  JWT_ACCESS_SECRET: 'synthetic-access-secret-1234567890',
  JWT_REFRESH_SECRET: 'synthetic-refresh-secret-123456789',
  OTP_HMAC_SECRET: 'synthetic-otp-hmac-secret-123456789012345',
  RAZORPAY_KEY_ID: '',
  RAZORPAY_KEY_SECRET: '',
  RAZORPAY_WEBHOOK_SECRET: '',
};

function parseEnvironmentInIsolatedProcess(overrides) {
  const envModule = new URL('../src/config/env.js', import.meta.url).href;
  const script = `import(${JSON.stringify(envModule)}).then(({ env }) => process.stdout.write(JSON.stringify({ COOKIE_SECURE: env.COOKIE_SECURE, OTP_WORKER_ENABLED: env.OTP_WORKER_ENABLED, WHATSAPP_PROVIDER: env.WHATSAPP_PROVIDER })))`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.env.TEMP || process.cwd(),
    encoding: 'utf8',
    env: { ...validSyntheticEnvironment, ...overrides },
  });
}

const bugConditionArbitrary = fc.oneof(
  fc.constant({ type: 'ConfigInput', variant: 'explicit-false' }),
  fc.constant({ type: 'ConfigInput', variant: 'invalid-meta' }),
  fc.constant({ type: 'ConfigInput', variant: 'mock-provider' }),
  fc.constantFrom('abc9876543210', '09876543210', '+449876543210').map((phone) => ({ type: 'OtpRequest', phone })),
  fc.constantFrom('12A456', '１２3456', '12345!').map((otp) => ({ type: 'OtpSubmission', otp })),
  fc.record({
    type: fc.constant('LoginCompletionAttempt'),
    boundary: fc.constantFrom(
      'user-lookup',
      'user-create',
      'user-update',
      'token-generation',
      'refresh-persistence',
      'completion-insert',
      'commit-acknowledgement',
    ),
    retryCount: fc.integer({ min: 2, max: 20 }),
  }),
  fc.constantFrom('30m', '45m', '14d').map((ttl) => ({ type: 'TokenCookiePair', ttl })),
  fc.constantFrom('ACCEPTED', 'PERMANENTLY_REJECTED', 'PERSISTENCE_FAILED', 'SIGNED_WEBHOOK_STATUS')
    .map((outcome) => ({ type: 'AsyncOutcome', outcome })),
  fc.constant({ type: 'DocumentationContract', obsoleteOpaqueTokenClaim: true }),
  fc.array(fc.boolean(), { minLength: 5, maxLength: 5 })
    .filter((checks) => checks.some((value) => !value))
    .map((checks) => ({ type: 'CallbackEvidence', checks })),
);

function isBugCondition(input) {
  return [
    'ConfigInput', 'OtpRequest', 'OtpSubmission', 'LoginCompletionAttempt',
    'TokenCookiePair', 'AsyncOutcome', 'DocumentationContract', 'CallbackEvidence',
  ].includes(input.type);
}

async function expectedBehavior(input) {
  if (input.type === 'ConfigInput' && input.variant === 'explicit-false') {
    const result = parseEnvironmentInIsolatedProcess({ COOKIE_SECURE: 'false', OTP_WORKER_ENABLED: 'false' });
    if (result.status !== 0) return false;
    const parsed = JSON.parse(result.stdout);
    return parsed.COOKIE_SECURE === false && parsed.OTP_WORKER_ENABLED === false;
  }
  if (input.type === 'ConfigInput' && input.variant === 'invalid-meta') {
    const result = parseEnvironmentInIsolatedProcess({ WHATSAPP_PROVIDER: 'meta' });
    return result.status !== 0 && result.stderr.includes('META_WHATSAPP_ACCESS_TOKEN');
  }
  if (input.type === 'ConfigInput' && input.variant === 'mock-provider') {
    return parseEnvironmentInIsolatedProcess({ WHATSAPP_PROVIDER: 'mock' }).status !== 0;
  }
  if (input.type === 'OtpRequest') return !requestOtpSchema.safeParse({ phone: input.phone }).success;
  if (input.type === 'OtpSubmission') {
    return !verifyOtpSchema.safeParse({ phone: '9876543210', otp: input.otp }).success;
  }
  if (input.type === 'LoginCompletionAttempt') {
    const harness = createLoginCompletionHarness({ failOnceAt: input.boundary });
    let firstResult;
    let firstError;
    try {
      firstResult = await harness.complete();
    } catch (error) {
      firstError = error;
    }

    if (input.boundary === 'commit-acknowledgement') {
      if (!firstResult || firstError) return false;
    } else if (firstError?.boundary !== input.boundary) {
      return false;
    }

    const retries = await Promise.all(
      Array.from({ length: input.retryCount }, () => harness.complete()),
    );
    const reference = firstResult || retries[0];
    const state = harness.snapshot();
    return retries.every((result) => result.tokens.accessToken === reference.tokens.accessToken
        && result.tokens.refreshToken === reference.tokens.refreshToken)
      && state.completionWrites === 1
      && state.refreshWrites === 1
      && state.user.refreshTokenHash === hashToken(reference.tokens.refreshToken);
  }
  if (input.type === 'TokenCookiePair') {
    const lifetimeSeconds = { '30m': 1800, '45m': 2700, '14d': 1209600 }[input.ttl];
    const issuedAt = 2_000_000_000;
    const currentTimeMs = (issuedAt + 120) * 1000;
    const token = jwt.sign({ iat: issuedAt, exp: issuedAt + lifetimeSeconds }, 'x'.repeat(32));
    return tokenLifetimeMs(token, currentTimeMs) === (lifetimeSeconds - 120) * 1000;
  }
  if (input.type === 'AsyncOutcome') {
    try {
      const { createOtpDiagnostic } = await import('../src/modules/auth/otp-diagnostics.js');
      const diagnostic = createOtpDiagnostic({
        eventType: input.outcome,
        requestId: '00000000-0000-4000-8000-000000000001',
        providerCode: 'META_132001',
        deliveryState: 'DELIVERED',
      });
      return diagnostic.requestId === '00000000-0000-4000-8000-000000000001'
        && Object.keys(diagnostic).every((key) => ['eventType', 'requestId', 'timestamp', 'providerCode', 'deliveryState'].includes(key));
    } catch {
      return false;
    }
  }
  if (input.type === 'DocumentationContract') {
    const documentation = await source('docs/whatsapp-login-otp.md');
    return documentation.includes('expiresInSeconds')
      && documentation.includes('resendAfterSeconds')
      && !/returns? only an opaque token|opaque token and timing/i.test(documentation);
  }
  if (input.type === 'CallbackEvidence') {
    try {
      const { evaluateCallbackReadiness } = await import('../scripts/verify-whatsapp-callback-readiness.js');
      return evaluateCallbackReadiness(input.checks).ready === false;
    } catch {
      return false;
    }
  }
  return false;
}

// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10**
test('Property 1: every bug-condition input satisfies the production correction oracle', async () => {
  const deterministicCases = [
    { type: 'ConfigInput', variant: 'explicit-false' },
    { type: 'ConfigInput', variant: 'invalid-meta' },
    { type: 'ConfigInput', variant: 'mock-provider' },
    { type: 'OtpRequest', phone: 'abc9876543210' },
    { type: 'OtpSubmission', otp: '12A456' },
    { type: 'LoginCompletionAttempt', boundary: 'refresh-persistence', retryCount: 6 },
    { type: 'TokenCookiePair', ttl: '30m' },
    { type: 'AsyncOutcome', outcome: 'PERMANENTLY_REJECTED' },
    { type: 'DocumentationContract', obsoleteOpaqueTokenClaim: true },
    { type: 'CallbackEvidence', checks: [true, true, true, true, false] },
  ];
  const generated = fc.sample(bugConditionArbitrary, { seed: SEED, numRuns: 100 });
  const defects = [];
  for (const input of [...deterministicCases, ...generated]) {
    assert.equal(isBugCondition(input), true);
    if (!(await expectedBehavior(input))) {
      const label = input.type === 'ConfigInput' ? `${input.type}:${input.variant}` : input.type;
      if (!defects.includes(label)) defects.push(label);
    }
  }
  assert.deepEqual(defects, [], `seed=${SEED}; path=deterministic+generated; defectClasses=${defects.join(',')}`);
});
