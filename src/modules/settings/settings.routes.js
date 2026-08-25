import { Router } from 'express';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { getStoreSettings, updateStoreSettings } from './settings.service.js';
import { storeSettingsSchema } from './settings.validation.js';
import { availabilityQuerySchema } from './settings.validation.js';
import { getStoreAvailability } from './storeAvailability.service.js';
import { audit } from '../audit/audit.service.js';
import { isAndroidRequest } from '../../shared/middlewares/clientPlatform.js';
import { containsPaanCornerReference } from '../catalog/paanCorner.visibility.js';

export const settingsRoutes = Router();

function settingsForClient(settings, req) {
  if (!isAndroidRequest(req)) return settings;
  return {
    ...settings,
    homepageBanners: (settings.homepageBanners || []).filter((banner) => ![
      banner.title,
      banner.highlight,
      banner.copy,
      banner.tag,
      banner.ctaLabel,
      banner.ctaHref,
    ].some(containsPaanCornerReference)),
  };
}

settingsRoutes.get('/', asyncHandler(async (req, res) => {
  ok(res, { settings: settingsForClient(await getStoreSettings(), req) }, 'Store settings loaded');
}));

settingsRoutes.get('/availability', validate(availabilityQuerySchema, 'query'), asyncHandler(async (req, res) => {
  ok(res, { availability: await getStoreAvailability(req.query) }, 'Store availability loaded');
}));

settingsRoutes.patch('/', requireAuth, authorize('admin', 'manager'), validate(storeSettingsSchema), asyncHandler(async (req, res) => {
  const before = await getStoreSettings();
  const settings = await updateStoreSettings(req.body);
  await audit({ req, action: 'settings.update', entityType: 'StoreSettings', entityId: 'storefront', before, after: settings });
  ok(res, { settings }, 'Store settings updated');
}));
