import { Router } from 'express';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { validate } from '../../shared/validation/validate.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { ok } from '../../shared/utils/apiResponse.js';
import { createAddressSchema } from './address.validation.js';
import { createAddress } from './address.service.js';

export const addressRoutes = Router();

addressRoutes.use(requireAuth, authorize('customer'));

addressRoutes.post('/', validate(createAddressSchema), asyncHandler(async (req, res) => {
  const result = await createAddress(req.user, req.body);
  ok(res, result, 'Address saved', 201);
}));
