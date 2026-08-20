import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { attachCookies } from '../src/modules/auth/auth.routes.js';
import {
  createLoginCompletionTokens,
  signAccessToken,
  signRefreshToken,
  tokenLifetimeMs,
} from '../src/modules/auth/token.service.js';

const SEED = 20260635;
const signingKey = 'x'.repeat(32);

function signedToken(issuedAt, lifetimeSeconds) {
  return jwt.sign({ iat: issuedAt, exp: issuedAt + lifetimeSeconds }, signingKey);
}

function cookieResponse() {
  const values = [];
  return {
    req: {},
    cookie: express.response.cookie,
    append(name, value) {
      assert.equal(name, 'Set-Cookie');
      values.push(value);
      return this;
    },
    values,
  };
}

function attribute(cookie, name) {
  return cookie.split('; ')
    .find((part) => part.toLowerCase().startsWith(`${name.toLowerCase()}=`))
    ?.slice(name.length + 1);
}

// **Validates: Requirements 1.7, 2.7, 3.9**
test('tokenLifetimeMs returns generated remaining validity at a controlled current time', () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 2_000_000_000 }),
    fc.integer({ min: 2, max: 31_536_000 }),
    fc.integer({ min: 0, max: 999 }),
    (issuedAt, lifetimeSeconds, elapsedMilliseconds) => {
      const currentTimeMs = issuedAt * 1000 + elapsedMilliseconds;
      assert.equal(
        tokenLifetimeMs(signedToken(issuedAt, lifetimeSeconds), currentTimeMs),
        lifetimeSeconds * 1000 - elapsedMilliseconds,
      );
    },
  ), { seed: SEED, numRuns: 100 });
});

test('tokenLifetimeMs rejects invalid claims, invalid clocks, and expired tokens', () => {
  const encoded = (payload) => [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');

  [
    {},
    { iat: 0, exp: 1 },
    { iat: 10, exp: 10 },
    { iat: 10, exp: 9 },
    { iat: 10.5, exp: 20 },
    { iat: 1, exp: Number.MAX_SAFE_INTEGER },
  ].forEach((payload) => assert.throws(() => tokenLifetimeMs(encoded(payload), 1000), TypeError));
  assert.throws(() => tokenLifetimeMs(signedToken(100, 60), -1), TypeError);
  assert.throws(() => tokenLifetimeMs(signedToken(100, 60), 160000), TypeError);
});

test('shared session cookie attachment serializes remaining validity and security scope', () => {
  const accessSeconds = 37 * 60;
  const refreshSeconds = 19 * 24 * 60 * 60;
  const issuedAt = Math.floor(Date.now() / 1000);
  const currentTimeMs = (issuedAt + 120) * 1000;
  const response = cookieResponse();

  attachCookies(response, {
    accessToken: signedToken(issuedAt, accessSeconds),
    refreshToken: signedToken(issuedAt, refreshSeconds),
  }, currentTimeMs);

  assert.equal(response.values.length, 2);
  const [accessCookie, refreshCookie] = response.values;
  assert.match(accessCookie, /^accessToken=/);
  assert.match(refreshCookie, /^customerRefreshToken=/);
  assert.equal(Number(attribute(accessCookie, 'Max-Age')), accessSeconds - 120);
  assert.equal(Number(attribute(refreshCookie, 'Max-Age')), refreshSeconds - 120);
  assert.match(accessCookie, /; Path=\//);
  assert.match(refreshCookie, /; Path=\/api\/v1\/auth;/);
  for (const cookie of response.values) {
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.doesNotMatch(cookie, /; Secure/);
  }
});

test('admin and customer sessions use separate refresh cookies', () => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const currentTimeMs = issuedAt * 1000;
  const tokens = {
    accessToken: signedToken(issuedAt, 60),
    refreshToken: signedToken(issuedAt, 120),
  };
  const customerResponse = cookieResponse();
  const adminResponse = cookieResponse();

  attachCookies(customerResponse, tokens, currentTimeMs, 'customer');
  attachCookies(adminResponse, tokens, currentTimeMs, 'admin');

  assert.match(customerResponse.values[1], /^customerRefreshToken=/);
  assert.match(adminResponse.values[1], /^adminRefreshToken=/);
});

test('delayed deterministic replay keeps cookie expiry aligned to JWT exp under a controlled clock', () => {
  const issuedAt = 2_000_000_000;
  const lifetimeSeconds = 15 * 60;
  const replayTimeMs = (issuedAt + 120) * 1000;
  const token = signedToken(issuedAt, lifetimeSeconds);
  const response = cookieResponse();
  const originalNow = Date.now;

  Date.now = () => replayTimeMs;
  try {
    attachCookies(response, { accessToken: token, refreshToken: token }, replayTimeMs);
  } finally {
    Date.now = originalNow;
  }

  for (const cookie of response.values) {
    assert.equal(Number(attribute(cookie, 'Max-Age')), lifetimeSeconds - 120);
    assert.equal(
      new Date(attribute(cookie, 'Expires')).getTime(),
      (issuedAt + lifetimeSeconds) * 1000,
    );
  }
});

test('expired or invalid token claims prevent both cookies from being attached atomically', () => {
  const response = cookieResponse();
  const currentTimeMs = 200000;
  assert.throws(() => attachCookies(response, {
    accessToken: signedToken(100, 60),
    refreshToken: signedToken(100, 100),
  }, currentTimeMs), TypeError);
  assert.deepEqual(response.values, []);

  assert.throws(() => attachCookies(response, {
    accessToken: signedToken(100, 200),
    refreshToken: 'not-a-jwt',
  }, currentTimeMs), TypeError);
  assert.deepEqual(response.values, []);
});

test('normal and idempotent OTP issuance families use the same remaining-validity boundary', () => {
  const user = {
    id: '507f1f77bcf86cd799439011',
    role: 'customer',
    tokenVersion: 0,
  };
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const currentTimeMs = issuedAtSeconds * 1000;
  const normalTokens = {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
  };
  const completionTokens = createLoginCompletionTokens({
    proofDigest: 'a'.repeat(64),
    user,
    issuedAt: new Date(currentTimeMs),
  }).tokens;

  for (const tokens of [normalTokens, completionTokens]) {
    const response = cookieResponse();
    attachCookies(response, tokens, currentTimeMs);
    assert.equal(
      Number(attribute(response.values[0], 'Max-Age')) * 1000,
      tokenLifetimeMs(tokens.accessToken, currentTimeMs),
    );
    assert.equal(
      Number(attribute(response.values[1], 'Max-Age')) * 1000,
      tokenLifetimeMs(tokens.refreshToken, currentTimeMs),
    );
  }
});
