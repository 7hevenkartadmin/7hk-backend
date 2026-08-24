import { Router } from 'express';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { adminActionTokenRateLimiter, ownerSecurityRateLimiter } from '../../shared/middlewares/rateLimiters.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { audit } from '../audit/audit.service.js';
import {
  acceptAdminInvitation,
  changeStaffPassword,
  getPrimaryAdmin,
  replacePrimaryAdmin,
  resetAdminPassword,
  revokePrimaryAdmin,
  sendPrimaryAdminPasswordReset,
} from './owner.service.js';
import {
  adminActionTokenSchema,
  changeStaffPasswordSchema,
  ownerTotpSchema,
  replaceAdminSchema,
} from './owner.validation.js';

export const ownerRoutes = Router();
export const adminSecurityRoutes = Router();

ownerRoutes.use(requireAuth, authorize('owner'));

ownerRoutes.get('/admin', asyncHandler(async (_req, res) => {
  ok(res, { administrator: await getPrimaryAdmin() }, 'Administrator access loaded');
}));

ownerRoutes.post('/admin/replace', ownerSecurityRateLimiter, validate(replaceAdminSchema), asyncHandler(async (req, res) => {
  const before = await getPrimaryAdmin();
  const result = await replacePrimaryAdmin(req.body, req.user._id);
  await audit({ req, action: 'admin.replace', entityType: 'User', entityId: result.administrator.id, before, after: { ...result.administrator, emailDelivered: result.email.delivered } });
  ok(res, result, 'Administrator invitation created');
}));

ownerRoutes.post('/admin/password-reset', ownerSecurityRateLimiter, validate(ownerTotpSchema), asyncHandler(async (req, res) => {
  const result = await sendPrimaryAdminPasswordReset(req.user._id, req.body.totp);
  await audit({ req, action: 'admin.password_reset.request', entityType: 'User', entityId: result.administrator.id, before: null, after: { requested: true, emailDelivered: result.email.delivered } });
  ok(res, result, 'Administrator password reset sent');
}));

ownerRoutes.post('/admin/revoke', ownerSecurityRateLimiter, validate(ownerTotpSchema), asyncHandler(async (req, res) => {
  const before = await getPrimaryAdmin();
  const administrator = await revokePrimaryAdmin(req.user._id, req.body.totp);
  await audit({ req, action: 'admin.revoke', entityType: 'User', entityId: administrator.id, before, after: administrator });
  ok(res, { administrator }, 'Administrator access revoked');
}));

adminSecurityRoutes.post('/setup', adminActionTokenRateLimiter, validate(adminActionTokenSchema), asyncHandler(async (req, res) => {
  const administrator = await acceptAdminInvitation(req.body);
  await audit({ req, action: 'admin.invitation.accept', entityType: 'User', entityId: administrator.id, before: { status: 'invited' }, after: administrator });
  ok(res, { administrator }, 'Administrator account activated');
}));

adminSecurityRoutes.post('/reset-password', adminActionTokenRateLimiter, validate(adminActionTokenSchema), asyncHandler(async (req, res) => {
  const administrator = await resetAdminPassword(req.body);
  await audit({ req, action: 'admin.password_reset.complete', entityType: 'User', entityId: administrator.id, before: null, after: { sessionsRevoked: true } });
  ok(res, { administrator }, 'Administrator password changed');
}));

adminSecurityRoutes.post('/change-password', requireAuth, authorize('owner', 'admin'), ownerSecurityRateLimiter, validate(changeStaffPasswordSchema), asyncHandler(async (req, res) => {
  await changeStaffPassword(req.user._id, req.body);
  await audit({ req, action: 'staff.password.change', entityType: 'User', entityId: req.user._id, before: null, after: { sessionsRevoked: true } });
  ok(res, null, 'Password changed. Please sign in again.');
}));
