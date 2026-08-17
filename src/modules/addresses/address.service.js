import { env } from '../../config/env.js';
import { distanceInKm } from '../../shared/utils/distance.js';
import { AppError } from '../../shared/utils/AppError.js';
import { Address } from './address.model.js';
import { deliveryZoneForDistance } from '../settings/settings.service.js';

export async function createAddress(user, payload) {
  const latitude = payload.lat ?? payload.latitude;
  const longitude = payload.lng ?? payload.longitude;
  const distanceFromStoreKm = Number(distanceInKm(
    { latitude: env.STORE_LATITUDE, longitude: env.STORE_LONGITUDE },
    { latitude, longitude },
  ).toFixed(2));
  const zone = await deliveryZoneForDistance(distanceFromStoreKm);
  if (!zone || distanceFromStoreKm > env.DELIVERY_RADIUS_KM) {
    throw new AppError(`Delivery address is ${distanceFromStoreKm.toFixed(1)} km away. Service is unavailable for this location.`, 422, 'OUT_OF_DELIVERY_RADIUS');
  }
  const delivery = { deliveryZone: zone.code, deliveryCharge: zone.charge };

  const address = await Address.create({
    userId: user.id,
    label: payload.label,
    flatNumber: payload.flatNumber,
    landmark: payload.landmark,
    formattedAddress: payload.formattedAddress,
    location: { type: 'Point', coordinates: [longitude, latitude] },
    distanceFromStoreKm,
    deliveryZone: delivery.deliveryZone,
    deliveryCharge: delivery.deliveryCharge,
    isDefault: payload.isDefault,
  });

  if (payload.isDefault) user.addresses.forEach((entry) => { entry.isDefault = false; });
  user.addresses.push({
    label: payload.label,
    flatNumber: payload.flatNumber,
    formattedAddress: payload.formattedAddress,
    recipientName: payload.recipientName || user.name,
    phone: payload.phone || user.phone,
    line1: [payload.flatNumber, payload.formattedAddress].filter(Boolean).join(', '),
    line2: payload.formattedAddress,
    landmark: payload.landmark,
    city: payload.city,
    state: payload.state,
    pincode: payload.pincode,
    latitude,
    longitude,
    distanceFromStoreKm,
    isDefault: payload.isDefault,
  });
  await user.save();

  return { address, addresses: user.addresses };
}
