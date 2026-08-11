import { StoreSettings } from './storeSettings.model.js';
import { defaultCodSettings, defaultDeliveryZones, defaultHomepageBanners } from './settings.defaults.js';

function normalizeSettings(settings) {
  return {
    homepageBanners: (settings.homepageBanners?.length ? settings.homepageBanners : defaultHomepageBanners)
      .map((banner) => (typeof banner.toObject === 'function' ? banner.toObject() : banner))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)),
    deliveryZones: (settings.deliveryZones?.length ? settings.deliveryZones : defaultDeliveryZones)
      .map((zone) => (typeof zone.toObject === 'function' ? zone.toObject() : zone))
      .filter((zone) => zone.isActive !== false)
      .sort((a, b) => a.limit - b.limit),
    codSettings: {
      ...defaultCodSettings,
      ...(settings.codSettings && typeof settings.codSettings.toObject === 'function' ? settings.codSettings.toObject() : settings.codSettings || {}),
    },
  };
}

export async function getStoreSettings() {
  const settings = await StoreSettings.findOneAndUpdate(
    { key: 'storefront' },
    { $setOnInsert: { homepageBanners: defaultHomepageBanners, deliveryZones: defaultDeliveryZones, codSettings: defaultCodSettings } },
    { upsert: true, new: true },
  );
  return normalizeSettings(settings);
}

export async function updateStoreSettings(payload) {
  const update = {};
  if (payload.homepageBanners) update.homepageBanners = payload.homepageBanners;
  if (payload.deliveryZones) update.deliveryZones = payload.deliveryZones.sort((a, b) => a.limit - b.limit);
  if (payload.codSettings) update.codSettings = payload.codSettings;
  const settings = await StoreSettings.findOneAndUpdate(
    { key: 'storefront' },
    { $set: update, $setOnInsert: { key: 'storefront' } },
    { upsert: true, new: true, runValidators: true },
  );
  return normalizeSettings(settings);
}

export async function getCodSettings() {
  const settings = await getStoreSettings();
  return settings.codSettings;
}

export async function deliveryFeeForDistance(distanceKm, fallbackFee = 30) {
  if (!Number.isFinite(distanceKm)) return fallbackFee;
  const { deliveryZones } = await getStoreSettings();
  const zone = deliveryZones.find((item) => distanceKm <= item.limit);
  return zone ? zone.charge : fallbackFee;
}
