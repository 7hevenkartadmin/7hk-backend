import { completeVerifiedLoginWithDependencies } from '../../src/modules/auth/auth.service.js';
import { createLoginCompletionTokens } from '../../src/modules/auth/token.service.js';

function clone(value) {
  return structuredClone(value);
}

export function createLoginCompletionHarness({
  existingUser = false,
  blocked = false,
  failOnceAt = [],
  now = Date.now(),
} = {}) {
  const failures = new Set(Array.isArray(failOnceAt) ? failOnceAt : [failOnceAt]);
  const failureCounts = new Map();
  let state = {
    user: existingUser ? {
      _id: '507f1f77bcf86cd799439011',
      id: '507f1f77bcf86cd799439011',
      name: 'Existing Customer',
      phone: '+919876543210',
      role: 'customer',
      status: blocked ? 'blocked' : 'active',
      tokenVersion: 0,
    } : null,
    completion: null,
    completionWrites: 0,
    refreshWrites: 0,
  };
  let lock = Promise.resolve();

  function fail(boundary) {
    if (!failures.has(boundary)) return;
    const count = failureCounts.get(boundary) || 0;
    failureCounts.set(boundary, count + 1);
    if (count === 0) {
      const error = new Error(`synthetic ${boundary} failure`);
      error.boundary = boundary;
      throw error;
    }
  }

  function storeFor(session) {
    return session?.draft || state;
  }

  const dependencies = {
    async findCompletion(proofDigest, session) {
      const store = storeFor(session);
      if (!store.completion || store.completion.proofDigest !== proofDigest) return null;
      return { completion: store.completion, user: store.user };
    },
    async startSession() {
      return {
        draft: null,
        async withTransaction(work) {
          let release;
          const previous = lock;
          lock = new Promise((resolve) => { release = resolve; });
          await previous;
          this.draft = clone(state);
          try {
            await work();
            state = this.draft;
            fail('commit-acknowledgement');
          } finally {
            this.draft = null;
            release();
          }
        },
        async endSession() {},
      };
    },
    async hashPassword() {
      return 'synthetic-password-hash';
    },
    createPasswordSeed() {
      return 'synthetic-password-seed';
    },
    now() {
      return now;
    },
    async findUser(_normalizedPhone, session) {
      fail('user-lookup');
      return storeFor(session).user;
    },
    async createUser(attributes, session) {
      fail('user-create');
      const store = storeFor(session);
      store.user = {
        ...attributes,
        _id: '507f1f77bcf86cd799439011',
        id: '507f1f77bcf86cd799439011',
        status: 'active',
        tokenVersion: 0,
      };
      return store.user;
    },
    updateUser(user, issuedAt) {
      fail('user-update');
      user.lastLoginAt = issuedAt;
    },
    createTokens(input) {
      fail('token-generation');
      return createLoginCompletionTokens(input);
    },
    async persistRefreshSession(user, refreshTokenHash, session) {
      fail('refresh-persistence');
      user.refreshTokenHash = refreshTokenHash;
      storeFor(session).refreshWrites += 1;
    },
    async insertCompletion(attributes, session) {
      fail('completion-insert');
      const store = storeFor(session);
      if (store.completion) {
        const duplicate = new Error('synthetic duplicate completion');
        duplicate.code = 11000;
        throw duplicate;
      }
      store.completion = {
        ...attributes,
        _id: 'completion-1',
      };
      store.completionWrites += 1;
      return store.completion;
    },
  };

  return {
    async complete({
      normalizedPhone = '+919876543210',
      name = 'Synthetic Customer',
      proofId = '00000000-0000-4000-8000-000000000001',
    } = {}) {
      return completeVerifiedLoginWithDependencies(
        { normalizedPhone, name, proofId },
        dependencies,
      );
    },
    snapshot() {
      return clone(state);
    },
    transitionUser(changes) {
      state.user = { ...state.user, ...changes };
    },
    failureCount(boundary) {
      return failureCounts.get(boundary) || 0;
    },
  };
}
