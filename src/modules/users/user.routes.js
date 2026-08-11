import { Router } from 'express';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { addressSchema, updateProfileSchema } from './user.validation.js';
import { distanceInKm } from '../../shared/utils/distance.js';
import { env } from '../../config/env.js';

export const userRoutes = Router();

userRoutes.use(requireAuth);

function checkDeliveryAddress(address) {
  if (typeof address.latitude !== 'number' || typeof address.longitude !== 'number') {
    return { ok: false, status: 422, message: 'Delivery location is required. Please use map location.', code: 'LOCATION_REQUIRED' };
  }
  const distance = distanceInKm(
    { latitude: env.STORE_LATITUDE, longitude: env.STORE_LONGITUDE },
    { latitude: address.latitude, longitude: address.longitude },
  );
  if (distance > env.DELIVERY_RADIUS_KM) {
    return {
      ok: false,
      status: 422,
      message: `Delivery address is ${distance.toFixed(1)} km away. Service is available within ${env.DELIVERY_RADIUS_KM} km.`,
      code: 'OUT_OF_DELIVERY_RADIUS',
      data: { distanceKm: Number(distance.toFixed(2)), radiusKm: env.DELIVERY_RADIUS_KM },
    };
  }
  return { ok: true, distanceKm: Number(distance.toFixed(2)), radiusKm: env.DELIVERY_RADIUS_KM };
}

userRoutes.get('/me', asyncHandler(async (req, res) => {
  ok(res, { user: req.user }, 'Profile loaded');
}));

userRoutes.patch('/me', validate(updateProfileSchema), asyncHandler(async (req, res) => {
  Object.assign(req.user, req.body);
  await req.user.save();
  ok(res, { user: req.user }, 'Profile updated');
}));

userRoutes.post('/me/addresses/validate', validate(addressSchema.partial().required({ latitude: true, longitude: true })), asyncHandler(async (req, res) => {
  const result = checkDeliveryAddress(req.body);
  if (!result.ok) return res.status(result.status).json({ success: false, message: result.message, code: result.code, data: result.data });
  ok(res, result, 'Location is deliverable');
}));

userRoutes.post('/me/addresses', validate(addressSchema), asyncHandler(async (req, res) => {
  const result = checkDeliveryAddress(req.body);
  if (!result.ok) return res.status(result.status).json({ success: false, message: result.message, code: result.code, data: result.data });
  req.body.distanceFromStoreKm = result.distanceKm;
  if (req.user.addresses.length === 0) req.body.isDefault = true;
  if (req.body.isDefault) req.user.addresses.forEach((address) => { address.isDefault = false; });
  req.user.addresses.push(req.body);
  await req.user.save();
  ok(res, { addresses: req.user.addresses }, 'Address added', 201);
}));

userRoutes.patch('/me/addresses/:addressId', validate(addressSchema), asyncHandler(async (req, res) => {
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) return res.status(404).json({ success: false, message: 'Address not found', code: 'ADDRESS_NOT_FOUND' });
  const result = checkDeliveryAddress(req.body);
  if (!result.ok) return res.status(result.status).json({ success: false, message: result.message, code: result.code, data: result.data });
  req.body.distanceFromStoreKm = result.distanceKm;
  if (req.body.isDefault) req.user.addresses.forEach((entry) => { entry.isDefault = false; });
  Object.assign(address, req.body);
  await req.user.save();
  ok(res, { addresses: req.user.addresses }, 'Address updated');
}));

userRoutes.patch('/me/addresses/:addressId/default', asyncHandler(async (req, res) => {
  const selected = req.user.addresses.id(req.params.addressId);
  if (!selected) return res.status(404).json({ success: false, message: 'Address not found', code: 'ADDRESS_NOT_FOUND' });
  req.user.addresses.forEach((address) => { address.isDefault = String(address._id) === req.params.addressId; });
  await req.user.save();
  ok(res, { addresses: req.user.addresses }, 'Default address updated');
}));

userRoutes.delete('/me/addresses/:addressId', asyncHandler(async (req, res) => {
  const address = req.user.addresses.id(req.params.addressId);
  if (!address) return res.status(404).json({ success: false, message: 'Address not found', code: 'ADDRESS_NOT_FOUND' });
  const wasDefault = address.isDefault;
  req.user.addresses.pull(req.params.addressId);
  if (wasDefault && req.user.addresses.length > 0) req.user.addresses[0].isDefault = true;
  await req.user.save();
  ok(res, { addresses: req.user.addresses }, 'Address removed');
}));
