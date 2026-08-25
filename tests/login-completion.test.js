import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { AppError } from '../src/shared/utils/AppError.js';
import { assertDatabaseTransactionSupport } from '../src/config/database.js';
import {
  assertLoginCompletionReplayCurrent,
  completeVerifiedLogin,
  completeVerifiedLoginWithDependencies,
  verifyOtpWithDependencies,
} from '../src/modules/auth/auth.service.js';
import {
  digestLoginProof,
  LoginCompletion,
} from '../src/modules/auth/login-completion.model.js';
import {
  createLoginCompletionTokens,
  hashToken,
  replayLoginCompletionTokens,
  verifyAccessToken,
  verifyRefreshToken,
} from '../src/modules/auth/token.service.js';
import { User } from '../src/modules/users/user.model.js';
import {
  integrationFixturesRequired,
  unavailableIntegrationFixture,
} from './integration-fixture-policy.js';
import { createLoginCompletionHarness } from './helpers/login-completion-harness.js';

function syntheticUser(overrides = {}) {
  return {
    id: new mongoose.Types.ObjectId().toString(),
    role: 'customer',
    tokenVersion: 0,
    ...overrides,
  };
}

test('login completion schema requires immutable replay metadata and a unique proof digest', () => {
  const indexes = LoginCompletion.schema.indexes();
  const proofIndex = indexes.find(([fields]) => fields.proofDigest === 1);
  assert.equal(proofIndex?.[1].unique, true);

  const completion = new LoginCompletion({
    proofDigest: 'a'.repeat(64),
    userId: new mongoose.Types.ObjectId(),
    role: 'customer',
    issuedAt: new Date('2026-01-01T00:00:00.000Z'),
    tokenVersion: 0,
    accessJti: 'b'.repeat(64),
    refreshJti: 'c'.repeat(64),
    accessExpiresAt: new Date('2026-01-01T00:15:00.000Z'),
    refreshExpiresAt: new Date('2026-01-08T00:00:00.000Z'),
  });

  assert.equal(completion.validateSync(), undefined);
  assert.equal(LoginCompletion.schema.path('proofDigest').options.immutable, true);
  assert.equal(LoginCompletion.schema.path('accessJti').options.select, false);
  assert.equal(LoginCompletion.schema.path('refreshJti').options.select, false);
  assert.equal(completion.clientPlatform, 'web');
  assert.equal(LoginCompletion.schema.path('clientPlatform').options.immutable, true);
  assert.equal(LoginCompletion.schema.path('proofId'), undefined);
  assert.equal(LoginCompletion.schema.path('otp'), undefined);
  assert.equal(LoginCompletion.schema.path('phone'), undefined);
  assert.equal(indexes.some(([, options]) => options.expireAfterSeconds !== undefined), false);
});

// **Validates: Requirements 2.6**
test('2-20 retries reconstruct one byte-stable logical token pair without the raw proof', () => {
  const proofId = crypto.randomUUID();
  const proofDigest = digestLoginProof(proofId);
  const user = syntheticUser();
  const first = createLoginCompletionTokens({
    proofDigest,
    user,
    issuedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
  });

  for (let retryCount = 2; retryCount <= 20; retryCount += 1) {
    const retries = Array.from(
      { length: retryCount },
      () => replayLoginCompletionTokens(first.metadata),
    );
    assert.ok(retries.every((tokens) => tokens.accessToken === first.tokens.accessToken));
    assert.ok(retries.every((tokens) => tokens.refreshToken === first.tokens.refreshToken));
  }

  const access = verifyAccessToken(first.tokens.accessToken);
  const refresh = verifyRefreshToken(first.tokens.refreshToken);
  assert.equal(access.sub, user.id);
  assert.equal(refresh.sub, user.id);
  assert.equal(access.jti, first.metadata.accessJti);
  assert.equal(refresh.jti, first.metadata.refreshJti);
  assert.notEqual(proofDigest, proofId);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(proofId));
});

test('different verified proofs derive different completion identities and token pairs', () => {
  const user = syntheticUser();
  const issuedAt = new Date('2026-06-07T12:00:00.000Z');
  const leftDigest = digestLoginProof(crypto.randomUUID());
  const rightDigest = digestLoginProof(crypto.randomUUID());
  const left = createLoginCompletionTokens({ proofDigest: leftDigest, user, issuedAt });
  const right = createLoginCompletionTokens({ proofDigest: rightDigest, user, issuedAt });

  assert.notEqual(leftDigest, rightDigest);
  assert.notEqual(left.tokens.accessToken, right.tokens.accessToken);
  assert.notEqual(left.tokens.refreshToken, right.tokens.refreshToken);
});

async function connectTransactionHarness(t) {
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 1000,
        autoIndex: true,
      });
    }
    await LoginCompletion.createIndexes();
    await assertDatabaseTransactionSupport(mongoose.connection.db);
  } catch (error) {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    return unavailableIntegrationFixture(t, 'MongoDB transaction', error);
  }

  return true;
}

test('Mongo transaction creates one completion and one refresh hash under concurrent retries', async (t) => {
  if (!(await connectTransactionHarness(t))) return;

  const proofId = crypto.randomUUID();
  const proofDigest = digestLoginProof(proofId);
  const phone = `+919${String(Date.now()).slice(-9)}`;
  t.after(async () => {
    await LoginCompletion.deleteMany({ proofDigest });
    await User.deleteMany({ phone });
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => completeVerifiedLogin({
      normalizedPhone: phone,
      name: 'Transaction Test Customer',
      proofId,
    })),
  );

  assert.equal(new Set(results.map((result) => result.tokens.accessToken)).size, 1);
  assert.equal(new Set(results.map((result) => result.tokens.refreshToken)).size, 1);
  assert.equal(await LoginCompletion.countDocuments({ proofDigest }), 1);
  assert.equal(await User.countDocuments({ phone }), 1);

  const user = await User.findOne({ phone }).select('+refreshTokenHash');
  assert.equal(user.refreshTokenHash, hashToken(results[0].tokens.refreshToken));
  assert.equal(JSON.stringify(results).includes(proofId), false);
});

test('Mongo transaction creates no completion or session for a blocked account', async (t) => {
  if (!(await connectTransactionHarness(t))) return;

  const proofId = crypto.randomUUID();
  const proofDigest = digestLoginProof(proofId);
  const phone = `+918${String(Date.now()).slice(-9)}`;
  await User.create({
    name: 'Blocked Transaction Customer',
    phone,
    passwordHash: await User.hashPassword('synthetic-password'),
    role: 'customer',
    status: 'blocked',
  });
  t.after(async () => {
    await LoginCompletion.deleteMany({ proofDigest });
    await User.deleteMany({ phone });
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });

  await assert.rejects(
    completeVerifiedLogin({ normalizedPhone: phone, name: 'Ignored', proofId }),
    (error) => error.code === 'ACCOUNT_BLOCKED',
  );
  assert.equal(await LoginCompletion.countDocuments({ proofDigest }), 0);
  const user = await User.findOne({ phone }).select('+refreshTokenHash');
  assert.equal(user.refreshTokenHash, undefined);
});

function replayFixture() {
  const user = syntheticUser({ status: 'active' });
  const issued = createLoginCompletionTokens({
    proofDigest: 'd'.repeat(64),
    user,
    issuedAt: new Date('2026-06-07T12:00:00.000Z'),
  });
  return {
    completion: issued.metadata,
    tokens: issued.tokens,
    user: {
      ...user,
      refreshTokenHash: hashToken(issued.tokens.refreshToken),
    },
  };
}

test('completion replay accepts only the active current persisted refresh session', () => {
  const fixture = replayFixture();
  assert.equal(assertLoginCompletionReplayCurrent(fixture), true);

  const staleStates = [
    ['refresh rotation', { refreshTokenHash: hashToken('rotated-refresh-token') }],
    ['logout', { refreshTokenHash: undefined, tokenVersion: 1 }],
    ['blocking', { status: 'blocked' }],
    ['token-version change', { tokenVersion: 1 }],
  ];
  for (const [label, changes] of staleStates) {
    assert.throws(
      () => assertLoginCompletionReplayCurrent({
        ...fixture,
        user: { ...fixture.user, ...changes },
      }),
      (error) => error.code === 'OTP_COMPLETION_STALE',
      label,
    );
  }
});

test('stale completion closes the verified proof and never reports login success', async () => {
  const proofId = crypto.randomUUID();
  const calls = [];
  const otpService = {
    async verifyOtp() { return { status: 'OTP_VERIFIED', proofId }; },
    async denyVerifiedProof(payload, receivedProofId) {
      calls.push(['denied', payload.otp, receivedProofId]);
      return true;
    },
    async markVerifiedProofCompleted() { calls.push(['completed']); },
  };

  await assert.rejects(
    verifyOtpWithDependencies({ phone: '9876543210', otp: '123456' }, {
      otpService,
      async completeLogin() {
        throw new AppError('stale', 401, 'OTP_COMPLETION_STALE');
      },
    }),
    (error) => error.code === 'OTP_COMPLETION_STALE',
  );
  assert.deepEqual(calls, [['denied', '123456', proofId]]);
});

// **Validates: Requirements 3.10**
test('blocked account denial terminally closes the verified proof before returning', async () => {
  const proofId = crypto.randomUUID();
  const calls = [];
  const otpService = {
    async verifyOtp() { return { status: 'OTP_VERIFIED', proofId }; },
    async denyVerifiedProof(payload, receivedProofId) {
      calls.push(['denied', payload.otp, receivedProofId]);
      return true;
    },
    async markVerifiedProofCompleted() { calls.push(['completed']); },
  };

  await assert.rejects(
    verifyOtpWithDependencies({ phone: '9876543210', otp: '123456' }, {
      otpService,
      async completeLogin() {
        throw new AppError('blocked', 403, 'ACCOUNT_BLOCKED');
      },
    }),
    (error) => error.code === 'ACCOUNT_BLOCKED',
  );
  assert.deepEqual(calls, [['denied', '123456', proofId]]);
});

// **Validates: Requirements 2.6, 3.10**
test('terminal proof closure fails closed when Redis cannot confirm denial', async () => {
  const proofId = crypto.randomUUID();
  for (const denyVerifiedProof of [
    async () => false,
    async () => { throw new Error('synthetic Redis failure'); },
  ]) {
    const otpService = {
      async verifyOtp() { return { status: 'OTP_VERIFIED', proofId }; },
      denyVerifiedProof,
      async markVerifiedProofCompleted() { assert.fail('denied login must not be completed'); },
    };

    await assert.rejects(
      verifyOtpWithDependencies({ phone: '9876543210', otp: '123456' }, {
        otpService,
        async completeLogin() {
          throw new AppError('blocked', 403, 'ACCOUNT_BLOCKED');
        },
      }),
      (error) => error.code === 'OTP_PROOF_CLOSE_FAILED' && error.statusCode === 503,
    );
  }
});

// **Validates: Requirements 2.6**
test('Redis completion marking is optional after durable logical completion', async () => {
  const proofId = crypto.randomUUID();
  const expected = { user: { id: 'public-user' }, tokens: { accessToken: 'a', refreshToken: 'r' } };
  const otpService = {
    async verifyOtp() { return { status: 'OTP_VERIFIED', proofId }; },
    async denyVerifiedProof() { assert.fail('successful login must not be denied'); },
    async markVerifiedProofCompleted() { throw new Error('synthetic Redis failure'); },
  };

  const result = await verifyOtpWithDependencies({ phone: '9876543210', otp: '123456' }, {
    otpService,
    async completeLogin({ proofId: receivedProofId }) {
      assert.equal(receivedProofId, proofId);
      return expected;
    },
  });

  assert.equal(result, expected);
});

test('Mongo replay rejects refresh rotation, logout, blocking, and token-version changes', async (t) => {
  if (!(await connectTransactionHarness(t))) return;

  const records = [];
  t.after(async () => {
    await LoginCompletion.deleteMany({ proofDigest: { $in: records.map((item) => item.proofDigest) } });
    await User.deleteMany({ phone: { $in: records.map((item) => item.phone) } });
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });

  const transitions = [
    ['refresh rotation', (user) => { user.refreshTokenHash = hashToken('rotated-refresh-token'); }],
    ['logout', (user) => { user.refreshTokenHash = undefined; user.tokenVersion += 1; }],
    ['blocking', (user) => { user.status = 'blocked'; }],
    ['token-version change', (user) => { user.tokenVersion += 1; }],
  ];

  for (let index = 0; index < transitions.length; index += 1) {
    const [label, transition] = transitions[index];
    const proofId = crypto.randomUUID();
    const proofDigest = digestLoginProof(proofId);
    const phone = `+917${String(Date.now() + index).slice(-9)}`;
    records.push({ proofDigest, phone });
    await completeVerifiedLogin({ normalizedPhone: phone, name: label, proofId });
    const user = await User.findOne({ phone }).select('+refreshTokenHash');
    transition(user);
    await user.save();

    await assert.rejects(
      completeVerifiedLogin({ normalizedPhone: phone, name: label, proofId }),
      (error) => error.code === 'OTP_COMPLETION_STALE',
      label,
    );
  }
});


test('required integration fixture flag is exact and fail-closed', () => {
  assert.equal(integrationFixturesRequired({ REQUIRE_INTEGRATION_FIXTURES: 'true' }), true);
  assert.equal(integrationFixturesRequired({ REQUIRE_INTEGRATION_FIXTURES: 'false' }), false);
  assert.equal(integrationFixturesRequired({ REQUIRE_INTEGRATION_FIXTURES: 'TRUE' }), false);
  assert.throws(
    () => unavailableIntegrationFixture(
      { skip() { assert.fail('required fixtures must not skip'); } },
      'synthetic',
      new Error('offline'),
      { REQUIRE_INTEGRATION_FIXTURES: 'true' },
    ),
    /synthetic fixture unavailable/,
  );
});

// **Validates: Requirements 2.6, 3.9**
test('transaction model keeps every pre-commit failure retryable and commits one logical session', async () => {
  const boundaries = [
    'user-lookup',
    'user-create',
    'user-update',
    'token-generation',
    'refresh-persistence',
    'completion-insert',
  ];

  for (const boundary of boundaries) {
    const harness = createLoginCompletionHarness({ failOnceAt: boundary });
    await assert.rejects(
      harness.complete(),
      (error) => error.boundary === boundary,
      boundary,
    );
    const failedState = harness.snapshot();
    assert.equal(failedState.completion, null, boundary);
    assert.equal(failedState.refreshWrites, 0, boundary);

    const completed = await harness.complete();
    const replayed = await harness.complete();
    assert.equal(replayed.tokens.accessToken, completed.tokens.accessToken, boundary);
    assert.equal(replayed.tokens.refreshToken, completed.tokens.refreshToken, boundary);

    const state = harness.snapshot();
    assert.equal(state.completionWrites, 1, boundary);
    assert.equal(state.refreshWrites, 1, boundary);
    assert.equal(state.user.refreshTokenHash, hashToken(completed.tokens.refreshToken), boundary);
  }
});

// **Validates: Requirements 2.6**
test('transaction model resolves an ambiguous commit acknowledgement from the durable winner', async () => {
  const harness = createLoginCompletionHarness({ failOnceAt: 'commit-acknowledgement' });

  const completed = await harness.complete();
  const replayed = await harness.complete();

  assert.equal(harness.failureCount('commit-acknowledgement'), 1);
  assert.equal(replayed.tokens.accessToken, completed.tokens.accessToken);
  assert.equal(replayed.tokens.refreshToken, completed.tokens.refreshToken);
  assert.equal(harness.snapshot().completionWrites, 1);
  assert.equal(harness.snapshot().refreshWrites, 1);
});

// **Validates: Requirements 2.6**
test('transaction model converges 2-20 concurrent retries on one completion and refresh hash', async () => {
  for (let retryCount = 2; retryCount <= 20; retryCount += 1) {
    const harness = createLoginCompletionHarness();
    const results = await Promise.all(
      Array.from({ length: retryCount }, () => harness.complete()),
    );
    assert.equal(new Set(results.map((result) => result.tokens.accessToken)).size, 1);
    assert.equal(new Set(results.map((result) => result.tokens.refreshToken)).size, 1);
    const state = harness.snapshot();
    assert.equal(state.completionWrites, 1);
    assert.equal(state.refreshWrites, 1);
    assert.equal(state.user.refreshTokenHash, hashToken(results[0].tokens.refreshToken));
  }
});

// **Validates: Requirements 2.6, 3.10**
test('runtime replay after rotation, logout, blocking, or token-version change is rejected and terminally denied', async () => {
  const transitions = [
    ['refresh rotation', () => ({ refreshTokenHash: hashToken('rotated-refresh-token') })],
    ['logout', () => ({ refreshTokenHash: undefined, tokenVersion: 1 })],
    ['blocking', () => ({ status: 'blocked' })],
    ['token-version change', () => ({ tokenVersion: 1 })],
  ];

  for (const [label, transition] of transitions) {
    const harness = createLoginCompletionHarness();
    await harness.complete();
    harness.transitionUser(transition());
    let denied = 0;
    const otpService = {
      async verifyOtp() {
        return { status: 'OTP_VERIFIED', proofId: '00000000-0000-4000-8000-000000000001' };
      },
      async denyVerifiedProof() {
        denied += 1;
        return true;
      },
      async markVerifiedProofCompleted() {
        assert.fail(`${label} must not mark the proof completed`);
      },
    };

    await assert.rejects(
      verifyOtpWithDependencies({ phone: '9876543210', otp: '123456' }, {
        otpService,
        completeLogin: (input) => harness.complete(input),
      }),
      (error) => error.code === 'OTP_COMPLETION_STALE',
      label,
    );
    assert.equal(denied, 1, label);
    assert.equal(harness.snapshot().completionWrites, 1, label);
  }
});

// **Validates: Requirements 2.6, 3.10**
test('runtime blocked-account completion commits no session and terminally denies the proof', async () => {
  const harness = createLoginCompletionHarness({ existingUser: true, blocked: true });
  let denied = 0;
  const otpService = {
    async verifyOtp() {
      return { status: 'OTP_VERIFIED', proofId: '00000000-0000-4000-8000-000000000001' };
    },
    async denyVerifiedProof() {
      denied += 1;
      return true;
    },
    async markVerifiedProofCompleted() {
      assert.fail('blocked account must not mark the proof completed');
    },
  };

  await assert.rejects(
    verifyOtpWithDependencies({ phone: '9876543210', otp: '123456' }, {
      otpService,
      completeLogin: (input) => harness.complete(input),
    }),
    (error) => error.code === 'ACCOUNT_BLOCKED',
  );
  const state = harness.snapshot();
  assert.equal(denied, 1);
  assert.equal(state.completionWrites, 0);
  assert.equal(state.refreshWrites, 0);
  assert.equal(state.user.refreshTokenHash, undefined);
});

// **Validates: Requirements 2.6**
test('completion fails closed when transaction sessions are unavailable', async () => {
  await assert.rejects(
    completeVerifiedLoginWithDependencies({
      normalizedPhone: '+919876543210',
      name: 'Synthetic Customer',
      proofId: crypto.randomUUID(),
    }, {
      async findCompletion() { return null; },
      async hashPassword() { return 'synthetic-password-hash'; },
      createPasswordSeed() { return 'synthetic-password-seed'; },
      async startSession() {
        const cause = new Error('transactions are not supported');
        throw new Error('session acquisition failed', { cause });
      },
    }),
    (error) => error.code === 'OTP_COMPLETION_TRANSACTION_UNAVAILABLE'
      && error.statusCode === 503,
  );
});

// **Validates: Requirements 2.6**
test('database transaction capability check executes a transaction and fails closed', async () => {
  let reads = 0;
  let ended = 0;
  const database = {
    collection(name) {
      assert.equal(name, 'logincompletions');
      return {
        async findOne() { reads += 1; },
      };
    },
  };
  const workingSession = {
    async withTransaction(work) { await work(); },
    async endSession() { ended += 1; },
  };
  await assertDatabaseTransactionSupport(database, {
    async startSession() { return workingSession; },
  });
  assert.equal(reads, 1);
  assert.equal(ended, 1);

  await assert.rejects(
    assertDatabaseTransactionSupport(database, {
      async startSession() {
        return {
          async withTransaction() { throw new Error('standalone MongoDB'); },
          async endSession() { ended += 1; },
        };
      },
    }),
    /MongoDB transaction support is required/,
  );
  assert.equal(ended, 2);
});

// **Validates: Requirements 2.6, 3.9**
test('transaction model completes both new and existing active customer accounts', async () => {
  for (const existingUser of [false, true]) {
    const harness = createLoginCompletionHarness({ existingUser });
    const result = await harness.complete();
    const state = harness.snapshot();
    assert.equal(result.user.id, '507f1f77bcf86cd799439011');
    assert.equal(result.user.role, 'customer');
    assert.equal(Object.hasOwn(result.user, 'refreshTokenHash'), false);
    assert.equal(state.completionWrites, 1);
    assert.equal(state.refreshWrites, 1);
    assert.equal(state.user.refreshTokenHash, hashToken(result.tokens.refreshToken));
  }
});
