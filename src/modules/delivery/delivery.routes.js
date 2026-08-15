import { Router } from 'express';
import { created, ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { createSlot, listAdminSlots, listAvailableSlots, updateSlot } from './delivery.service.js';
import { deliverySlotSchema, deliverySlotUpdateSchema } from './delivery.validation.js';

export const deliveryRoutes = Router();

deliveryRoutes.get('/', asyncHandler(async (req, res) => {
  ok(res, { slots: await listAvailableSlots(req.query) }, 'Delivery slots loaded');
}));

deliveryRoutes.get('/admin', requireAuth, authorize('admin', 'manager'), asyncHandler(async (_req, res) => {
  ok(res, { slots: await listAdminSlots() }, 'Admin delivery slots loaded');
}));

deliveryRoutes.post('/', requireAuth, authorize('admin', 'manager'), validate(deliverySlotSchema), asyncHandler(async (req, res) => {
  created(res, { slot: await createSlot(req.body) }, 'Delivery slot created');
}));

deliveryRoutes.patch('/:id', requireAuth, authorize('admin', 'manager'), validate(deliverySlotUpdateSchema), asyncHandler(async (req, res) => {
  ok(res, { slot: await updateSlot(req.params.id, req.body) }, 'Delivery slot updated');
}));
