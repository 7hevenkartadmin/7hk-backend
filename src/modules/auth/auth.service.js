import { User } from '../users/user.model.js';
import { AppError } from '../../shared/utils/AppError.js';
import { hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from './token.service.js';
import { buildLoginOtpPayload, getSevenHeavenOtpService } from './otp.module.js';

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    addresses: user.addresses,
  };
}

function tokenPayload(user, refreshToken) {
  return {
    user: publicUser(user),
    accessToken: signAccessToken(user),
    refreshToken,
  };
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
  }).select('+passwordHash +refreshTokenHash');
  if (!user || !(await user.comparePassword(payload.password))) {
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'active') throw new AppError('Account is blocked', 403, 'ACCOUNT_BLOCKED');
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
  if (!user || user.refreshTokenHash !== hashToken(refreshToken)) {
    throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH');
  }
  if (user.status !== 'active') throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH');
  const nextRefreshToken = signRefreshToken(user);
  user.refreshTokenHash = hashToken(nextRefreshToken);
  await user.save();
  return tokenPayload(user, nextRefreshToken);
}

export async function logout(userId) {
  await User.findByIdAndUpdate(userId, { $unset: { refreshTokenHash: 1 } });
}

function normalizePhone(phone) {
  const raw = String(phone || '').replace(/\D/g, '').slice(-10);
  if (raw.length !== 10) throw new AppError('Valid Indian mobile number required', 422, 'INVALID_PHONE');
  return `+91${raw}`;
}

export async function requestOtp(phone) {
  const normalizedPhone = normalizePhone(phone);
  const result = await getSevenHeavenOtpService().requestOtp(buildLoginOtpPayload(normalizedPhone));

  return {
    phone: normalizedPhone,
    expiresInSeconds: result.expiresIn,
    otpId: result.otpId,
    status: result.status,
  };
}

export async function verifyOtp({ phone, otp, name }) {
  const normalizedPhone = normalizePhone(phone);
  const verification = await getSevenHeavenOtpService().verifyOtp({
    ...buildLoginOtpPayload(normalizedPhone),
    otp,
  });

  if (verification.status !== 'OTP_VERIFIED') {
    throw new AppError('OTP expired or not found', 401, 'OTP_NOT_FOUND');
  }

  let user = await User.findOne({ phone: normalizedPhone }).select('+refreshTokenHash');
  if (!user) {
    try {
      user = await User.create({
        name: name || `Customer ${normalizedPhone.slice(-4)}`,
        phone: normalizedPhone,
        passwordHash: await User.hashPassword(`otp-${normalizedPhone}-${Date.now()}`),
        role: 'customer',
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      user = await User.findOne({ phone: normalizedPhone }).select('+refreshTokenHash');
    }
  }

  if (user.status !== 'active') throw new AppError('Account is blocked', 403, 'ACCOUNT_BLOCKED');
  const refreshToken = signRefreshToken(user);
  user.refreshTokenHash = hashToken(refreshToken);
  user.lastLoginAt = new Date();
  await user.save();
  return tokenPayload(user, refreshToken);
}
