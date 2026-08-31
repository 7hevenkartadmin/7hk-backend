import { StoreSettings } from './storeSettings.model.js';
import { defaultCodSettings, defaultDeliveryZones, defaultHomepageBanners, defaultHomepageBannerSections, defaultOrderingSchedule } from './settings.defaults.js';

function normalizeBannerSections(sections = {}) {
  const source = typeof sections?.toObject === 'function' ? sections.toObject() : sections || {};
  return {
    hero: { ...defaultHomepageBannerSections.hero, ...(source.hero || {}) },
    middle: { ...defaultHomepageBannerSections.middle, ...(source.middle || {}) },
  };
}

function normalizeOrderingSchedule(schedule = {}) {
  const source = typeof schedule.toObject === 'function' ? schedule.toObject() : schedule;
  const savedDays = new Map((source.weeklySchedule || []).map((day) => [Number(day.dayOfWeek), typeof day.toObject === 'function' ? day.toObject() : day]));
  return {
    ...defaultOrderingSchedule,
    ...source,
    timezone: 'Asia/Kolkata',
    weeklySchedule: defaultOrderingSchedule.weeklySchedule.map((day) => ({ ...day, ...(savedDays.get(day.dayOfWeek) || {}) })),
    specialDates: (source.specialDates || []).map((date) => (typeof date.toObject === 'function' ? date.toObject() : date)),
    temporaryClosure: {
      ...defaultOrderingSchedule.temporaryClosure,
      ...(source.temporaryClosure && typeof source.temporaryClosure.toObject === 'function' ? source.temporaryClosure.toObject() : source.temporaryClosure || {}),
    },
  };
}

function normalizeSettings(settings) {
  return {
    homepageBanners: (Array.isArray(settings.homepageBanners) ? settings.homepageBanners : defaultHomepageBanners)
      .map((banner) => (typeof banner.toObject === 'function' ? banner.toObject() : banner))
      .map((banner) => ({ placement: 'hero', displayStyle: 'content', theme: 'dark', textPosition: 'left', imagePosition: 'center', overlayOpacity: 55, ...banner }))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)),
    homepageBannerSections: normalizeBannerSections(settings.homepageBannerSections),
    deliveryZones: (settings.deliveryZones?.length ? settings.deliveryZones : defaultDeliveryZones)
      .map((zone) => (typeof zone.toObject === 'function' ? zone.toObject() : zone))
      .map((zone) => ({ ...zone, orderCutoff: zone.orderCutoff || (zone.code === 'A' ? '20:00' : '19:00') }))
      .sort((a, b) => a.limit - b.limit),
    codSettings: {
      ...defaultCodSettings,
      ...(settings.codSettings && typeof settings.codSettings.toObject === 'function' ? settings.codSettings.toObject() : settings.codSettings || {}),
    },
    orderingSchedule: normalizeOrderingSchedule(settings.orderingSchedule),
  };
}

export async function getStoreSettings() {
  const settings = await StoreSettings.findOneAndUpdate(
    { key: 'storefront' },
    { $setOnInsert: { homepageBanners: defaultHomepageBanners, homepageBannerSections: defaultHomepageBannerSections, deliveryZones: defaultDeliveryZones, codSettings: defaultCodSettings, orderingSchedule: defaultOrderingSchedule } },
    { upsert: true, new: true },
  );
  return normalizeSettings(settings);
}

export async function updateStoreSettings(payload) {
  const update = {};
  if (payload.homepageBanners) update.homepageBanners = payload.homepageBanners;
  if (payload.homepageBannerSections) update.homepageBannerSections = payload.homepageBannerSections;
  if (payload.deliveryZones) update.deliveryZones = payload.deliveryZones.sort((a, b) => a.limit - b.limit);
  if (payload.codSettings) update.codSettings = payload.codSettings;
  if (payload.orderingSchedule) update.orderingSchedule = payload.orderingSchedule;
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
  const zone = deliveryZones.find((item) => item.isActive !== false && distanceKm <= item.limit);
  return zone ? zone.charge : fallbackFee;
}

export async function deliveryZoneForDistance(distanceKm) {
  if (!Number.isFinite(Number(distanceKm))) return null;
  const { deliveryZones } = await getStoreSettings();
  return deliveryZones.find((item) => item.isActive !== false && Number(distanceKm) <= Number(item.limit)) || null;
}
