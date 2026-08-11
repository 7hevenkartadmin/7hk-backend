import { Router } from 'express';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { getStoreSettings, updateStoreSettings } from './settings.service.js';
import { storeSettingsSchema } from './settings.validation.js';

export const settingsRoutes = Router();

settingsRoutes.get('/', asyncHandler(async (_req, res) => {
  ok(res, { settings: await getStoreSettings() }, 'Store settings loaded');
}));

settingsRoutes.patch('/', requireAuth, authorize('admin', 'manager'), validate(storeSettingsSchema), asyncHandler(async (req, res) => {
  ok(res, { settings: await updateStoreSettings(req.body) }, 'Store settings updated');
}));
