import crypto from 'crypto';
import mongoose from 'mongoose';
import { User } from '../users/user.model.js';
import { AppError } from '../../shared/utils/AppError.js';
import {
  createLoginCompletionTokens,
  hashToken,
  replayLoginCompletionTokens,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from './token.service.js';
import { buildLoginOtpPayload, getSevenHeavenOtpService } from './otp.module.js';
import { OTP_CODE_PATTERN } from './otp.constants.js';
import { normalizeIndianMobile } from './phone.js';
import { digestLoginProof, LoginCompletion } from './login-completion.model.js';
import { decryptTotpSecret, verifyTotpCode } from './totp.service.js';

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    assignmentExpiresAt: user.assignmentExpiresAt,
  };
}

function tokenPayload(user, refreshToken) {
  return {
    user: publicUser(user),
    tokens: {
      accessToken: signAccessToken(user),
      refreshToken,
    },
  };
}

export function assertLoginCompletionReplayCurrent({ user, completion, tokens }) {
  const currentTokenVersion = Number(user?.tokenVersion || 0);
  const expectedRefreshHash = hashToken(tokens.refreshToken);
  const currentRefreshHash = user?.refreshTokenHash;
  const hashesMatch = typeof currentRefreshHash === 'string'
    && /^[a-f0-9]{64}$/.test(currentRefreshHash)
    && crypto.timingSafeEqual(
      Buffer.from(currentRefreshHash, 'utf8'),
      Buffer.from(expectedRefreshHash, 'utf8'),
    );

  if (user?.status !== 'active'
    || currentTokenVersion !== Number(completion.tokenVersion)
    || !hashesMatch) {
    throw new AppError(
      'Verified login completion is no longer current',
      401,
      'OTP_COMPLETION_STALE',
    );
  }
  return true;
}

function completedTokenPayload(user, completion) {
  const tokens = replayLoginCompletionTokens({
    userId: completion.userId,
    role: completion.role,
    tokenVersion: completion.tokenVersion,
    issuedAt: completion.issuedAt,
    accessExpiresAt: completion.accessExpiresAt,
    refreshExpiresAt: completion.refreshExpiresAt,
    accessJti: completion.accessJti,
    refreshJti: completion.refreshJti,
  });
  assertLoginCompletionReplayCurrent({ user, completion, tokens });
  return {
    user: publicUser(user),
    tokens,
  };
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

async function findCompletedLogin(proofDigest, session) {
  const completion = await withSession(
    LoginCompletion.findOne({ proofDigest }).select('+accessJti +refreshJti'),
    session,
  );
  if (!completion) return null;

  const user = await withSession(
    User.findById(completion.userId).select('+refreshTokenHash'),
    session,
  );
  if (!user) throw new AppError('Completed login account is unavailable', 503, 'OTP_COMPLETION_UNAVAILABLE');
  return { completion, user };
}

function isTransactionUnavailable(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.code === 20
      || current.codeName === 'IllegalOperation'
      || /transaction numbers are only allowed|transactions are not supported/i.test(
        String(current.message || ''),
      )) return true;
    current = current.cause;
  }
  return false;
}

async function findLoginUser(normalizedPhone, session) {
  return withSession(
    User.findOne({ phone: normalizedPhone }).select('+refreshTokenHash'),
    session,
  );
}

async function createLoginUser(attributes, session) {
  const [user] = await User.create([attributes], { session });
  return user;
}

function updateLoginUser(user, issuedAt) {
  user.lastLoginAt = issuedAt;
}

async function persistLoginRefreshSession(user, refreshTokenHash, session) {
  user.refreshTokenHash = refreshTokenHash;
  await user.save({ session });
}

async function insertLoginCompletion(attributes, session) {
  const [completion] = await LoginCompletion.create([attributes], { session });
  return completion;
}

export async function registerCustomer(payload) {
  let user;
  try {
    user = await User.create({
      ...payload,
      passwordHash: await User.hashPassword(payload.password),
    });
  } catch (error) {
    if (error?.code === 11000) throw new AppError('User already exists', 409, 'USER_EXISTS');
    throw error;
  }
  const refreshToken = signRefreshToken(user);
  user.refreshTokenHash = hashToken(refreshToken);
  user.lastLoginAt = new Date();
  await user.save();
  return tokenPayload(user, refreshToken);
}

export async function login(payload) {
  const user = await User.findOne({
    $or: [{ phone: payload.identifier }, { email: payload.identifier.toLowerCase() }],
  }).select('+passwordHash +refreshTokenHash +totpSecretEncrypted');
  if (!user || !(await user.comparePassword(payload.password))) {
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'active') throw new AppError('Account is blocked', 403, 'ACCOUNT_BLOCKED');
  if (user.role === 'admin' && (user.staffSeat !== 'PRIMARY_ADMIN' || !user.assignmentExpiresAt || user.assignmentExpiresAt <= new Date())) {
    throw new AppError('Administrator assignment is unavailable or expired', 403, 'ADMIN_ASSIGNMENT_EXPIRED');
  }
  if (user.role === 'owner') {
    if (user.staffSeat !== 'PRIMARY_OWNER') {
      throw new AppError('Owner security account is unavailable', 403, 'OWNER_ACCOUNT_UNAVAILABLE');
    }
    if (!user.totpEnabled || !user.totpSecretEncrypted) {
      throw new AppError('Owner authenticator is not configured', 403, 'OWNER_TOTP_NOT_CONFIGURED');
    }
    if (!payload.totp) throw new AppError('Owner authenticator code required', 401, 'TOTP_REQUIRED');
    let valid = false;
    try {
      valid = verifyTotpCode(decryptTotpSecret(user.totpSecretEncrypted), payload.totp);
    } catch {
      valid = false;
    }
    if (!valid) throw new AppError('Invalid owner authenticator code', 401, 'TOTP_INVALID');
  }
  const refreshToken = signRefreshToken(user);
  user.refreshTokenHash = hashToken(refreshToken);
  user.lastLoginAt = new Date();
  await user.save();
  return tokenPayload(user, refreshToken);
}

export async function refreshSession(refreshToken) {
  if (!refreshToken) throw new AppError('Refresh token required', 401, 'REFRESH_REQUIRED');
  const payload = verifyRefreshToken(refreshToken);
  const user = await User.findById(payload.sub).select('+refreshTokenHash');
  if (!user
    || payload.tokenVersion !== Number(user.tokenVersion || 0)
    || user.refreshTokenHash !== hashToken(refreshToken)) {
    throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH');
  }
  if (user.status !== 'active') throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH');
  if (user.role === 'admin' && (user.staffSeat !== 'PRIMARY_ADMIN' || !user.assignmentExpiresAt || user.assignmentExpiresAt <= new Date())) {
    throw new AppError('Administrator assignment is unavailable or expired', 403, 'ADMIN_ASSIGNMENT_EXPIRED');
  }
  if (user.role === 'owner' && user.staffSeat !== 'PRIMARY_OWNER') {
    throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH');
  }
  const nextRefreshToken = signRefreshToken(user);
  user.refreshTokenHash = hashToken(nextRefreshToken);
  await user.save();
  return tokenPayload(user, nextRefreshToken);
}

export async function logout(userId) {
  await User.findByIdAndUpdate(userId, {
    $unset: { refreshTokenHash: 1 },
    $inc: { tokenVersion: 1 },
  });
}

function normalizePhone(phone) {
  try {
    return normalizeIndianMobile(phone);
  } catch {
    throw new AppError('Valid Indian mobile number required', 422, 'INVALID_PHONE');
  }
}

export async function requestOtpWithDependencies(phone, requestId, {
  getOtpService = getSevenHeavenOtpService,
} = {}) {
  const normalizedPhone = normalizePhone(phone);
  const result = await getOtpService().requestOtp({
    ...buildLoginOtpPayload(normalizedPhone),
    requestId,
  });

  return {
    expiresInSeconds: result.expiresIn,
    resendAfterSeconds: result.resendAfterSeconds,
  };
}

export async function requestOtp(phone, requestId) {
  return requestOtpWithDependencies(phone, requestId);
}

export async function resendOtpWithDependencies(phone, requestId, {
  getOtpService = getSevenHeavenOtpService,
} = {}) {
  const normalizedPhone = normalizePhone(phone);
  const result = await getOtpService().resendOtp({
    ...buildLoginOtpPayload(normalizedPhone),
    requestId,
  });
  return {
    expiresInSeconds: result.expiresIn,
    resendAfterSeconds: result.resendAfterSeconds,
  };
}

export async function resendOtp(phone, requestId) {
  return resendOtpWithDependencies(phone, requestId);
}

export async function completeVerifiedLoginWithDependencies({ normalizedPhone, name, proofId }, {
  digestProof = digestLoginProof,
  findCompletion = findCompletedLogin,
  startSession = () => mongoose.startSession(),
  hashPassword = (value) => User.hashPassword(value),
  createPasswordSeed = () => crypto.randomBytes(32).toString('hex'),
  now = () => Date.now(),
  findUser = findLoginUser,
  createUser = createLoginUser,
  updateUser = updateLoginUser,
  createTokens = createLoginCompletionTokens,
  hashRefreshToken = hashToken,
  persistRefreshSession = persistLoginRefreshSession,
  insertCompletion = insertLoginCompletion,
  replayCompletion = completedTokenPayload,
  transactionUnavailable = isTransactionUnavailable,
} = {}) {
  const proofDigest = digestProof(proofId);
  const existing = await findCompletion(proofDigest);
  if (existing) return replayCompletion(existing.user, existing.completion);

  const issuedAt = new Date(Math.floor(now() / 1000) * 1000);
  const passwordHash = await hashPassword(`otp-${createPasswordSeed()}`);
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let session;
    try {
      session = await startSession();
      await session.withTransaction(async () => {
        const completed = await findCompletion(proofDigest, session);
        if (completed) return;

        let user = await findUser(normalizedPhone, session);
        if (!user) {
          user = await createUser({
            name: name || `Customer ${normalizedPhone.slice(-4)}`,
            phone: normalizedPhone,
            passwordHash,
            role: 'customer',
          }, session);
        }

        if (user.status !== 'active') {
          throw new AppError('Account is blocked', 403, 'ACCOUNT_BLOCKED');
        }

        const { metadata, tokens } = createTokens({
          proofDigest,
          user,
          issuedAt,
        });
        updateUser(user, issuedAt);
        await persistRefreshSession(user, hashRefreshToken(tokens.refreshToken), session);

        await insertCompletion({
          proofDigest,
          userId: user._id,
          role: metadata.role,
          issuedAt: metadata.issuedAt,
          tokenVersion: metadata.tokenVersion,
          accessJti: metadata.accessJti,
          refreshJti: metadata.refreshJti,
          accessExpiresAt: metadata.accessExpiresAt,
          refreshExpiresAt: metadata.refreshExpiresAt,
        }, session);
      });

      const durable = await findCompletion(proofDigest);
      if (!durable) {
        throw new AppError('Login completion was not persisted', 503, 'OTP_COMPLETION_UNAVAILABLE');
      }
      return replayCompletion(durable.user, durable.completion);
    } catch (error) {
      lastError = error;
      if (transactionUnavailable(error)) {
        throw new AppError(
          'OTP login requires database transaction support',
          503,
          'OTP_COMPLETION_TRANSACTION_UNAVAILABLE',
        );
      }

      const winner = await findCompletion(proofDigest);
      if (winner) return replayCompletion(winner.user, winner.completion);
      if (error?.code !== 11000 || attempt === 1) throw error;
    } finally {
      if (session) await session.endSession();
    }
  }

  throw lastError;
}

export async function completeVerifiedLogin(payload) {
  return completeVerifiedLoginWithDependencies(payload);
}

export async function verifyOtpWithDependencies({ phone, otp, name }, {
  otpService,
  getOtpService = getSevenHeavenOtpService,
  completeLogin = completeVerifiedLogin,
}) {
  const normalizedPhone = normalizePhone(phone);
  if (typeof otp !== 'string' || !OTP_CODE_PATTERN.test(otp)) {
    throw new AppError('OTP must contain exactly six decimal digits', 422, 'INVALID_OTP');
  }

  const resolvedOtpService = otpService || getOtpService();
  const otpPayload = {
    ...buildLoginOtpPayload(normalizedPhone),
    otp,
  };
  const verification = await resolvedOtpService.verifyOtp(otpPayload);
  if (verification.status !== 'OTP_VERIFIED' || !verification.proofId) {
    throw new AppError('OTP expired or not found', 401, 'OTP_NOT_FOUND');
  }

  let result;
  try {
    result = await completeLogin({ normalizedPhone, name, proofId: verification.proofId });
  } catch (error) {
    if (error?.code === 'ACCOUNT_BLOCKED' || error?.code === 'OTP_COMPLETION_STALE') {
      let closed = false;
      try {
        closed = await resolvedOtpService.denyVerifiedProof(otpPayload, verification.proofId);
      } catch {
        throw new AppError(
          'Verified login proof could not be closed safely',
          503,
          'OTP_PROOF_CLOSE_FAILED',
        );
      }
      if (!closed) {
        throw new AppError(
          'Verified login proof could not be closed safely',
          503,
          'OTP_PROOF_CLOSE_FAILED',
        );
      }
    }
    throw error;
  }

  await resolvedOtpService.markVerifiedProofCompleted(otpPayload, verification.proofId).catch(() => {});
  return result;
}

export async function verifyOtp(payload) {
  return verifyOtpWithDependencies(payload, {
    getOtpService: getSevenHeavenOtpService,
    completeLogin: completeVerifiedLogin,
  });
}
