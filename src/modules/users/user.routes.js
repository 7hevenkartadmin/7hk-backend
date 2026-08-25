import { Router } from 'express';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import {
  createAddress,
  deleteAddress,
  deliveryDetailsForLocation,
  listAddresses,
  setDefaultAddress,
  updateAddress,
} from '../addresses/address.service.js';
import { addressSchema, validateAddressLocationSchema } from '../addresses/address.validation.js';
import { updateProfileSchema } from './user.validation.js';
import { restrictedProductConsentRateLimiter } from '../../shared/middlewares/rateLimiters.js';
import { recordRestrictedProductConsent } from '../compliance/restrictedProductConsent.service.js';
import { restrictedProductConsentSchema } from '../compliance/restrictedProductConsent.validation.js';

export const userRoutes = Router();

userRoutes.use(requireAuth, authorize('customer'));

async function profileWithAddresses(user) {
  const profile = user.toObject();
  profile.id = user.id;
  profile.addresses = await listAddresses(user._id);
  return profile;
}

userRoutes.get('/me', asyncHandler(async (req, res) => {
  ok(res, { user: await profileWithAddresses(req.user) }, 'Profile loaded');
}));

userRoutes.patch('/me', validate(updateProfileSchema), asyncHandler(async (req, res) => {
  Object.assign(req.user, req.body);
  await req.user.save();
  ok(res, { user: await profileWithAddresses(req.user) }, 'Profile updated');
}));

userRoutes.post('/me/restricted-product-consents', restrictedProductConsentRateLimiter, validate(restrictedProductConsentSchema), asyncHandler(async (req, res) => {
  ok(res, { consent: await recordRestrictedProductConsent(req.user, req.body) }, 'Restricted-product acknowledgement recorded', 201);
}));

userRoutes.post('/me/addresses/validate', validate(validateAddressLocationSchema), asyncHandler(async (req, res) => {
  const delivery = await deliveryDetailsForLocation(req.body.latitude, req.body.longitude);
  ok(res, { ok: true, distanceKm: delivery.distanceFromStoreKm, radiusKm: delivery.radiusKm }, 'Location is deliverable');
}));

userRoutes.post('/me/addresses', validate(addressSchema), asyncHandler(async (req, res) => {
  ok(res, await createAddress(req.user, req.body), 'Address added', 201);
}));

userRoutes.patch('/me/addresses/:addressId', validate(addressSchema), asyncHandler(async (req, res) => {
  ok(res, await updateAddress(req.user, req.params.addressId, req.body), 'Address updated');
}));

userRoutes.patch('/me/addresses/:addressId/default', asyncHandler(async (req, res) => {
  ok(res, await setDefaultAddress(req.user, req.params.addressId), 'Default address updated');
}));

userRoutes.delete('/me/addresses/:addressId', asyncHandler(async (req, res) => {
  ok(res, await deleteAddress(req.user, req.params.addressId), 'Address removed');
}));
