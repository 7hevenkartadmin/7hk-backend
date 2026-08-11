import { Router } from 'express';
import { created, ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { createSlot, listAvailableSlots } from './delivery.service.js';
import { deliverySlotSchema } from './delivery.validation.js';

export const deliveryRoutes = Router();

deliveryRoutes.get('/', asyncHandler(async (req, res) => {
  ok(res, { slots: await listAvailableSlots(req.query) }, 'Delivery slots loaded');
}));

deliveryRoutes.post('/', requireAuth, authorize('admin', 'manager'), validate(deliverySlotSchema), asyncHandler(async (req, res) => {
  created(res, { slot: await createSlot(req.body) }, 'Delivery slot created');
}));
