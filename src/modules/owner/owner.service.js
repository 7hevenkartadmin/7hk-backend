import crypto from 'crypto';
import mongoose from 'mongoose';
import { User } from '../users/user.model.js';
import { AdminActionToken } from './adminActionToken.model.js';
import { AppError } from '../../shared/utils/AppError.js';
import { decryptTotpSecret, verifyTotpCode } from '../auth/totp.service.js';
import { adminSecurityUrl, sendAdminActionEmail, sendSecurityNotice } from './securityEmail.service.js';

const ADMIN_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const COMMON_PASSWORDS = new Set([
  'passwordpassword', 'adminadminadmin', '123456789012345', 'qwertyqwerty123',
]);

function withSession(query, session) {
  return session ? query.session(session) : query;
}

export function assertSecureStaffPassword(password) {
  const normalized = String(password || '');
  if (normalized.length < 15 || normalized.length > 128 || COMMON_PASSWORDS.has(normalized.toLowerCase())) {
    throw new AppError('Use a password of 15 to 128 characters that is not commonly used', 422, 'WEAK_STAFF_PASSWORD');
  }
  return normalized;
}

function tokenMaterial() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: crypto.createHash('sha256').update(token).digest('hex') };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function safePrimaryAdmin(user) {
  if (!user) return null;
  const raw = typeof user.toObject === 'function' ? user.toObject() : user;
  const expired = raw.assignmentExpiresAt && new Date(raw.assignmentExpiresAt) <= new Date();
  return {
    id: String(raw._id || raw.id),
    name: raw.name,
    email: raw.email,
    phone: raw.phone,
    status: expired && raw.status === 'active' ? 'expired' : raw.status,
    assignmentExpiresAt: raw.assignmentExpiresAt,
    lastLoginAt: raw.lastLoginAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

async function requireOwnerTotp(ownerId, code) {
  const owner = await User.findById(ownerId).select('+totpSecretEncrypted');
  if (!owner || owner.role !== 'owner' || owner.status !== 'active' || !owner.totpEnabled || !owner.totpSecretEncrypted) {
    throw new AppError('Owner authenticator is not configured', 403, 'OWNER_TOTP_NOT_CONFIGURED');
  }
  let valid = false;
  try {
    valid = verifyTotpCode(decryptTotpSecret(owner.totpSecretEncrypted), code);
  } catch {
    valid = false;
  }
  if (!valid) throw new AppError('Invalid owner authenticator code', 401, 'TOTP_INVALID');
  return owner;
}

export async function getPrimaryAdmin() {
  return safePrimaryAdmin(await User.findOne({ staffSeat: 'PRIMARY_ADMIN' }).lean());
}

async function createActionToken({ userId, email, ownerId, type, ttlMs, session }) {
  const material = tokenMaterial();
  const activeTokenKey = `${String(userId)}:${type}`;
  await AdminActionToken.updateMany(
    { user: userId, type, consumedAt: null, invalidatedAt: null },
    { $set: { invalidatedAt: new Date() }, $unset: { activeTokenKey: 1 } },
    { session },
  );
  await AdminActionToken.create([{
    tokenHash: material.tokenHash,
    activeTokenKey,
    type,
    user: userId,
    email,
    createdBy: ownerId,
    expiresAt: new Date(Date.now() + ttlMs),
  }], { session });
  return material.token;
}

async function deliverAdminActionEmail(payload) {
  try {
    return await sendAdminActionEmail(payload);
  } catch (error) {
    if (error?.code !== 'SECURITY_EMAIL_UNAVAILABLE') throw error;
    // The seat/token transaction has already committed. Return a safe delivery
    // status so the owner sees the failure and the route can still audit it.
    return { delivered: false };
  }
}

export async function replacePrimaryAdmin(payload, ownerId) {
  await requireOwnerTotp(ownerId, payload.totp);
  const assignmentExpiresAt = new Date(payload.assignmentExpiresAt);
  if (assignmentExpiresAt <= new Date()) {
    throw new AppError('Administrator assignment expiry must be in the future', 422, 'ADMIN_ASSIGNMENT_EXPIRY_INVALID');
  }
  const email = payload.email.trim().toLowerCase();
  const session = await mongoose.startSession();
  let administrator;
  let revokedAdministrator;
  let inviteToken;
  try {
    await session.withTransaction(async () => {
      const current = await withSession(User.findOne({ staffSeat: 'PRIMARY_ADMIN' }), session);
      let candidate = await withSession(User.findOne({ email }).select('+passwordHash'), session);
      if (candidate && candidate.role !== 'admin') {
        throw new AppError('That email belongs to another account', 409, 'STAFF_EMAIL_IN_USE');
      }

      if (current && (!candidate || String(current._id) !== String(candidate._id))) {
        revokedAdministrator = safePrimaryAdmin(current);
        current.status = 'revoked';
        current.revokedAt = new Date();
        current.revokedBy = ownerId;
        current.staffSeat = undefined;
        current.refreshTokenHash = undefined;
        current.tokenVersion = Number(current.tokenVersion || 0) + 1;
        await current.save({ session });
      }

      if (!candidate) {
        const [created] = await User.create([{
          name: payload.name,
          email,
          phone: payload.phone,
          passwordHash: await User.hashPassword(crypto.randomBytes(48).toString('base64url')),
          role: 'admin',
          status: 'invited',
          staffSeat: 'PRIMARY_ADMIN',
          assignmentExpiresAt,
        }], { session });
        candidate = created;
      } else {
        candidate.name = payload.name;
        candidate.phone = payload.phone;
        candidate.role = 'admin';
        candidate.status = 'invited';
        candidate.staffSeat = 'PRIMARY_ADMIN';
        candidate.assignmentExpiresAt = assignmentExpiresAt;
        candidate.revokedAt = undefined;
        candidate.revokedBy = undefined;
        candidate.refreshTokenHash = undefined;
        candidate.tokenVersion = Number(candidate.tokenVersion || 0) + 1;
        await candidate.save({ session });
      }

      inviteToken = await createActionToken({
        userId: candidate._id,
        email,
        ownerId,
        type: 'admin_invite',
        ttlMs: ADMIN_INVITE_TTL_MS,
        session,
      });
      administrator = safePrimaryAdmin(candidate);
    });
  } finally {
    await session.endSession();
  }

  const actionUrl = adminSecurityUrl('/admin/setup', inviteToken);
  const emailResult = await deliverAdminActionEmail({
    to: email,
    name: payload.name,
    actionUrl,
    kind: 'invite',
    expiresIn: '24 hours',
  });
  if (revokedAdministrator?.email) {
    await sendSecurityNotice({
      to: revokedAdministrator.email,
      name: revokedAdministrator.name,
      subject: '7HevenKart administrator access removed',
      message: 'Your primary administrator assignment was revoked by the owner and all sessions were ended.',
    });
  }
  return { administrator, email: emailResult };
}

export async function sendPrimaryAdminPasswordReset(ownerId, totp) {
  await requireOwnerTotp(ownerId, totp);
  const administrator = await User.findOne({ staffSeat: 'PRIMARY_ADMIN', role: 'admin' });
  if (!administrator || administrator.status !== 'active') {
    throw new AppError('No current administrator is available', 404, 'PRIMARY_ADMIN_NOT_FOUND');
  }
  const resetToken = await createActionToken({
    userId: administrator._id,
    email: administrator.email,
    ownerId,
    type: 'admin_password_reset',
    ttlMs: PASSWORD_RESET_TTL_MS,
  });
  const actionUrl = adminSecurityUrl('/admin/reset-password', resetToken);
  const emailResult = await deliverAdminActionEmail({
    to: administrator.email,
    name: administrator.name,
    actionUrl,
    kind: 'reset',
    expiresIn: '15 minutes',
  });
  return { administrator: safePrimaryAdmin(administrator), email: emailResult };
}

export async function revokePrimaryAdmin(ownerId, totp) {
  await requireOwnerTotp(ownerId, totp);
  const administrator = await User.findOneAndUpdate(
    { staffSeat: 'PRIMARY_ADMIN', role: 'admin' },
    {
      $set: { status: 'revoked', revokedAt: new Date(), revokedBy: ownerId },
      $unset: { staffSeat: 1, refreshTokenHash: 1 },
      $inc: { tokenVersion: 1 },
    },
    { new: false },
  );
  if (!administrator) throw new AppError('No current administrator is available', 404, 'PRIMARY_ADMIN_NOT_FOUND');
  await AdminActionToken.updateMany(
    { user: administrator._id, consumedAt: null, invalidatedAt: null },
    { $set: { invalidatedAt: new Date() }, $unset: { activeTokenKey: 1 } },
  );
  await sendSecurityNotice({
    to: administrator.email,
    name: administrator.name,
    subject: '7HevenKart administrator access removed',
    message: 'Your primary administrator assignment was revoked by the owner and all sessions were ended.',
  });
  return safePrimaryAdmin({ ...administrator.toObject(), status: 'revoked', staffSeat: undefined });
}

async function consumeToken({ rawToken, type, password }) {
  const nextPassword = assertSecureStaffPassword(password);
  const session = await mongoose.startSession();
  let administrator;
  try {
    await session.withTransaction(async () => {
      const action = await AdminActionToken.findOneAndUpdate(
        {
          tokenHash: tokenHash(rawToken),
          type,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { $gt: new Date() },
        },
        { $set: { consumedAt: new Date() }, $unset: { activeTokenKey: 1 } },
        { new: true, session },
      );
      if (!action) throw new AppError('This security link is invalid or expired', 410, 'ADMIN_ACTION_TOKEN_INVALID');
      const user = await withSession(User.findById(action.user).select('+passwordHash'), session);
      const allowedStatus = type === 'admin_invite' ? user?.status === 'invited' : user?.status === 'active';
      if (!user || user.role !== 'admin' || user.staffSeat !== 'PRIMARY_ADMIN' || !allowedStatus) {
        throw new AppError('This administrator account is no longer available', 409, 'ADMIN_ACCOUNT_UNAVAILABLE');
      }
      if (!user.assignmentExpiresAt || user.assignmentExpiresAt <= new Date()) {
        throw new AppError('The administrator assignment has expired', 410, 'ADMIN_ASSIGNMENT_EXPIRED');
      }
      user.passwordHash = await User.hashPassword(nextPassword);
      user.passwordChangedAt = new Date();
      user.status = 'active';
      user.refreshTokenHash = undefined;
      user.tokenVersion = Number(user.tokenVersion || 0) + 1;
      await user.save({ session });
      administrator = safePrimaryAdmin(user);
    });
  } finally {
    await session.endSession();
  }
  const owner = await User.findOne({ staffSeat: 'PRIMARY_OWNER', status: 'active' }).select('name email').lean();
  const message = type === 'admin_invite'
    ? 'The primary administrator account was activated.'
    : 'The primary administrator password was reset and all previous sessions were revoked.';
  await Promise.allSettled([
    sendSecurityNotice({ to: administrator.email, name: administrator.name, subject: '7HevenKart administrator security update', message }),
    ...(owner?.email ? [sendSecurityNotice({ to: owner.email, name: owner.name, subject: '7HevenKart owner security notice', message })] : []),
  ]);
  return administrator;
}

export function acceptAdminInvitation(payload) {
  return consumeToken({ rawToken: payload.token, type: 'admin_invite', password: payload.password });
}

export function resetAdminPassword(payload) {
  return consumeToken({ rawToken: payload.token, type: 'admin_password_reset', password: payload.password });
}

export async function changeStaffPassword(userId, payload) {
  const nextPassword = assertSecureStaffPassword(payload.newPassword);
  const user = await User.findById(userId).select('+passwordHash +totpSecretEncrypted +refreshTokenHash');
  if (!user || !['owner', 'admin'].includes(user.role) || !(await user.comparePassword(payload.currentPassword))) {
    throw new AppError('Current password is incorrect', 401, 'CURRENT_PASSWORD_INVALID');
  }
  if (user.role === 'owner') {
    const validTotp = user.totpEnabled && payload.totp
      && verifyTotpCode(decryptTotpSecret(user.totpSecretEncrypted), payload.totp);
    if (!validTotp) throw new AppError('Valid owner authenticator code required', 401, 'TOTP_INVALID');
  }
  user.passwordHash = await User.hashPassword(nextPassword);
  user.passwordChangedAt = new Date();
  user.refreshTokenHash = undefined;
  user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  await user.save();
  return true;
}
