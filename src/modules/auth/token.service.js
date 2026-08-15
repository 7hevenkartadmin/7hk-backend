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

function verificationOptions() {
  return {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
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

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
