import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';

const JWT_ALGORITHM = 'HS256';
const JWT_ISSUER = '7heaven-api';
const JWT_AUDIENCE = '7heaven-web';

function signingOptions(expiresIn) {
  return {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn,
    jwtid: crypto.randomUUID(),
  };
}

function deterministicSigningOptions(jwtid) {
  return {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    jwtid,
  };
}

function verificationOptions() {
  return {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  };
}

function expirationForTtl(issuedAtSeconds, expiresIn, secret) {
  const probe = jwt.sign(
    { iat: issuedAtSeconds },
    secret,
    { algorithm: JWT_ALGORITHM, expiresIn },
  );
  const expiration = jwt.decode(probe)?.exp;
  if (!Number.isSafeInteger(expiration) || expiration <= issuedAtSeconds) {
    throw new TypeError('Token lifetime must resolve to a positive whole-second duration');
  }
  return expiration;
}

function deterministicJwtId(proofDigest, tokenType) {
  return crypto.createHash('sha256')
    .update(`login-completion:${proofDigest}:${tokenType}`)
    .digest('hex');
}

function signCompletionToken({ userId, role, tokenVersion, type, issuedAt, expiresAt, jwtid }) {
  const payload = {
    sub: String(userId),
    ...(type === 'access' ? { role } : {}),
    tokenVersion,
    type,
    iat: issuedAt,
    exp: expiresAt,
  };
  const secret = type === 'access' ? env.JWT_ACCESS_SECRET : env.JWT_REFRESH_SECRET;
  return jwt.sign(payload, secret, deterministicSigningOptions(jwtid));
}

function serializeCompletionMetadata(metadata) {
  return {
    userId: String(metadata.userId),
    role: metadata.role,
    tokenVersion: Number(metadata.tokenVersion || 0),
    issuedAt: Math.floor(new Date(metadata.issuedAt).getTime() / 1000),
    accessExpiresAt: Math.floor(new Date(metadata.accessExpiresAt).getTime() / 1000),
    refreshExpiresAt: Math.floor(new Date(metadata.refreshExpiresAt).getTime() / 1000),
    accessJti: metadata.accessJti,
    refreshJti: metadata.refreshJti,
  };
}

export function signAccessToken(user) {
  return jwt.sign({
    sub: user.id,
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
    type: 'access',
  }, env.JWT_ACCESS_SECRET, signingOptions(env.ACCESS_TOKEN_TTL));
}

export function signRefreshToken(user) {
  return jwt.sign({
    sub: user.id,
    tokenVersion: user.tokenVersion || 0,
    type: 'refresh',
  }, env.JWT_REFRESH_SECRET, signingOptions(env.REFRESH_TOKEN_TTL));
}

export function createLoginCompletionTokens({ proofDigest, user, issuedAt = new Date() }) {
  const issuedAtSeconds = Math.floor(new Date(issuedAt).getTime() / 1000);
  if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds <= 0) {
    throw new TypeError('Login completion issuance time is invalid');
  }

  const metadata = {
    userId: String(user.id || user._id),
    role: user.role,
    tokenVersion: Number(user.tokenVersion || 0),
    issuedAt: new Date(issuedAtSeconds * 1000),
    accessExpiresAt: new Date(expirationForTtl(
      issuedAtSeconds,
      env.ACCESS_TOKEN_TTL,
      env.JWT_ACCESS_SECRET,
    ) * 1000),
    refreshExpiresAt: new Date(expirationForTtl(
      issuedAtSeconds,
      env.REFRESH_TOKEN_TTL,
      env.JWT_REFRESH_SECRET,
    ) * 1000),
    accessJti: deterministicJwtId(proofDigest, 'access'),
    refreshJti: deterministicJwtId(proofDigest, 'refresh'),
  };

  return {
    metadata,
    tokens: replayLoginCompletionTokens(metadata),
  };
}

export function replayLoginCompletionTokens(metadata) {
  const serialized = serializeCompletionMetadata(metadata);
  return {
    accessToken: signCompletionToken({
      ...serialized,
      type: 'access',
      expiresAt: serialized.accessExpiresAt,
      jwtid: serialized.accessJti,
    }),
    refreshToken: signCompletionToken({
      ...serialized,
      type: 'refresh',
      expiresAt: serialized.refreshExpiresAt,
      jwtid: serialized.refreshJti,
    }),
  };
}

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, verificationOptions());
  if (payload.type !== 'access') throw new jwt.JsonWebTokenError('Invalid token type');
  return payload;
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET, verificationOptions());
  if (payload.type !== 'refresh') throw new jwt.JsonWebTokenError('Invalid token type');
  return payload;
}

export function tokenLifetimeMs(token, currentTimeMs = Date.now()) {
  const payload = jwt.decode(token);
  if (!payload || typeof payload !== 'object'
    || !Number.isSafeInteger(payload.iat) || payload.iat <= 0
    || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat) {
    throw new TypeError('Token must contain positive whole-second iat and exp claims');
  }
  if (!Number.isSafeInteger(currentTimeMs) || currentTimeMs < 0) {
    throw new TypeError('Current time must be a nonnegative whole-millisecond timestamp');
  }

  const expiresAtMs = payload.exp * 1000;
  const remainingMs = expiresAtMs - currentTimeMs;
  if (!Number.isSafeInteger(expiresAtMs)
    || !Number.isSafeInteger(remainingMs)
    || remainingMs <= 0) {
    throw new TypeError('Token has no remaining cookie validity');
  }
  return remainingMs;
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
