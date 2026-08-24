import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  decodeBase32,
  decryptTotpSecret,
  encodeBase32,
  encryptTotpSecret,
  generateTotpSecret,
  ownerTotpUri,
  totpCode,
  verifyTotpCode,
} from '../src/modules/auth/totp.service.js';
import { AdminActionToken } from '../src/modules/owner/adminActionToken.model.js';
import { adminActionTokenSchema, ownerTotpSchema, replaceAdminSchema } from '../src/modules/owner/owner.validation.js';
import { assertSecureStaffPassword, safePrimaryAdmin } from '../src/modules/owner/owner.service.js';
import { adminSecurityUrl, sendAdminActionEmail } from '../src/modules/owner/securityEmail.service.js';
import { login } from '../src/modules/auth/auth.service.js';
import { User } from '../src/modules/users/user.model.js';
import { userSessionIsCurrent } from '../src/modules/auth/auth.middleware.js';

test('TOTP secrets round-trip through Base32 and authenticated encryption', () => {
  const bytes = Buffer.from('7heven-owner-security');
  assert.deepEqual(decodeBase32(encodeBase32(bytes)), bytes);
  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptTotpSecret(encrypted), secret);
  const [iv, tag, ciphertext] = encrypted.split('.');
  const tamperedTag = Buffer.from(tag, 'base64url');
  tamperedTag[0] ^= 1;
  assert.throws(() => decryptTotpSecret(`${iv}.${tamperedTag.toString('base64url')}.${ciphertext}`));
});

test('TOTP codes accept the current bounded time window and reject tampering', () => {
  const secret = encodeBase32(Buffer.from('12345678901234567890'));
  const now = Date.UTC(2026, 7, 24, 12, 0, 0);
  const code = totpCode(secret, now);
  assert.match(code, /^\d{6}$/u);
  assert.equal(verifyTotpCode(secret, code, now), true);
  assert.equal(verifyTotpCode(secret, code, now + 30_000), true);
  assert.equal(verifyTotpCode(secret, code, now + 90_000), false);
  assert.equal(verifyTotpCode(secret, code === '000000' ? '000001' : '000000', now), false);
});

test('owner authenticator URI is scoped to the expected issuer and account', () => {
  const uri = ownerTotpUri({ email: 'OWNER@EXAMPLE.COM', secret: 'ABC234' });
  assert.match(uri, /^otpauth:\/\/totp\//u);
  assert.match(uri, /secret=ABC234/u);
  assert.match(uri, /issuer=7HevenKart/u);
  assert.match(decodeURIComponent(uri), /owner@example.com/u);
});

test('owner security validation requires exact TOTP and future-compatible payload shapes', () => {
  const valid = {
    name: 'Primary Admin',
    email: 'admin@example.com',
    phone: '+919876543210',
    assignmentExpiresAt: '2027-02-24T00:00:00.000Z',
    totp: '123456',
  };
  assert.equal(replaceAdminSchema.safeParse(valid).success, true);
  assert.equal(replaceAdminSchema.safeParse({ ...valid, totp: '12345' }).success, false);
  assert.equal(replaceAdminSchema.safeParse({ ...valid, role: 'owner' }).success, false);
  assert.equal(ownerTotpSchema.safeParse({ totp: '123456' }).success, true);
  assert.equal(adminActionTokenSchema.safeParse({ token: 'x'.repeat(43), password: 'a secure owner password' }).success, true);
  assert.equal(adminActionTokenSchema.safeParse({ token: 'x'.repeat(43), password: 'short-password' }).success, false);
});

test('staff passwords reject weak/common values and safe admin output excludes credentials', () => {
  assert.equal(assertSecureStaffPassword('a long private password'), 'a long private password');
  assert.throws(() => assertSecureStaffPassword('123456789012345'), { code: 'WEAK_STAFF_PASSWORD' });
  const safe = safePrimaryAdmin({
    _id: new mongoose.Types.ObjectId(),
    name: 'Admin',
    email: 'admin@example.com',
    status: 'active',
    assignmentExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
    passwordHash: 'secret-hash',
    refreshTokenHash: 'refresh-hash',
    totpSecretEncrypted: 'encrypted-secret',
  });
  assert.equal(safe.name, 'Admin');
  assert.equal(Object.hasOwn(safe, 'passwordHash'), false);
  assert.equal(Object.hasOwn(safe, 'refreshTokenHash'), false);
  assert.equal(Object.hasOwn(safe, 'totpSecretEncrypted'), false);
});

test('admin action tokens retain one-time lifecycle and expiry indexes', () => {
  const token = new AdminActionToken({
    tokenHash: 'a'.repeat(64),
    type: 'admin_invite',
    user: new mongoose.Types.ObjectId(),
    email: 'admin@example.com',
    createdBy: new mongoose.Types.ObjectId(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(token.validateSync(), undefined);
  const indexes = AdminActionToken.schema.indexes();
  assert.ok(indexes.some(([key, options]) => key.tokenHash === 1 && options.unique));
  assert.ok(indexes.some(([key, options]) => key.activeTokenKey === 1 && options.unique && options.sparse));
  assert.ok(indexes.some(([key, options]) => key.expiresAt === 1 && options.expireAfterSeconds === 0));
});

test('development security mail exposes only the intended local preview link', async () => {
  const actionUrl = adminSecurityUrl('/admin/setup', 'token with spaces');
  const result = await sendAdminActionEmail({
    to: 'admin@example.com',
    name: 'Admin',
    actionUrl,
    kind: 'invite',
    expiresIn: '24 hours',
  });
  assert.equal(result.delivered, false);
  assert.equal(result.previewUrl, actionUrl);
  assert.match(actionUrl, /token=token%20with%20spaces/u);
});

test('owner password login requires a valid TOTP while expired admins fail closed', async () => {
  const originalFindOne = User.findOne;
  const secret = generateTotpSecret();
  const owner = {
    id: new mongoose.Types.ObjectId().toString(),
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    status: 'active',
    staffSeat: 'PRIMARY_OWNER',
    tokenVersion: 0,
    totpEnabled: true,
    totpSecretEncrypted: encryptTotpSecret(secret),
    comparePassword: async () => true,
    save: async () => undefined,
  };
  try {
    User.findOne = () => ({ select: async () => owner });
    await assert.rejects(
      () => login({ identifier: owner.email, password: 'correct-password' }),
      { code: 'TOTP_REQUIRED' },
    );
    const result = await login({
      identifier: owner.email,
      password: 'correct-password',
      totp: totpCode(secret),
    });
    assert.equal(result.user.role, 'owner');

    User.findOne = () => ({ select: async () => ({ ...owner, staffSeat: undefined }) });
    await assert.rejects(
      () => login({ identifier: owner.email, password: 'correct-password', totp: totpCode(secret) }),
      { code: 'OWNER_ACCOUNT_UNAVAILABLE' },
    );

    User.findOne = () => ({ select: async () => ({
      ...owner,
      role: 'admin',
      totpEnabled: false,
      assignmentExpiresAt: new Date(Date.now() - 1000),
    }) });
    await assert.rejects(
      () => login({ identifier: 'admin@example.com', password: 'correct-password' }),
      { code: 'ADMIN_ASSIGNMENT_EXPIRED' },
    );
  } finally {
    User.findOne = originalFindOne;
  }
});

test('every authenticated request rejects an expired or unassigned primary admin', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');
  const payload = { tokenVersion: 4 };
  const base = { role: 'admin', status: 'active', staffSeat: 'PRIMARY_ADMIN', tokenVersion: 4 };
  assert.equal(userSessionIsCurrent({ ...base, assignmentExpiresAt: new Date('2026-08-25T12:00:00.000Z') }, payload, 'admin', now), true);
  assert.equal(userSessionIsCurrent({ ...base, assignmentExpiresAt: new Date('2026-08-24T11:59:59.000Z') }, payload, 'admin', now), false);
  assert.equal(userSessionIsCurrent({ ...base, staffSeat: undefined, assignmentExpiresAt: new Date('2026-08-25T12:00:00.000Z') }, payload, 'admin', now), false);
  assert.equal(userSessionIsCurrent(base, payload, 'admin', now), false);
  assert.equal(userSessionIsCurrent({ ...base, role: 'owner', staffSeat: 'PRIMARY_OWNER' }, payload, 'owner', now), true);
  assert.equal(userSessionIsCurrent({ ...base, role: 'owner', staffSeat: undefined }, payload, 'owner', now), false);
  assert.equal(userSessionIsCurrent({ ...base, status: 'revoked' }, payload, 'admin', now), false);
});
