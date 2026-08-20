import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { distanceInKm } from '../../shared/utils/distance.js';
import { AppError } from '../../shared/utils/AppError.js';
import { User } from '../users/user.model.js';
import { deliveryZoneForDistance } from '../settings/settings.service.js';
import { Address } from './address.model.js';

function addressNotFound() {
  return new AppError('Address not found', 404, 'ADDRESS_NOT_FOUND');
}

function ownedAddressFilter(userId, addressId) {
  if (!mongoose.isValidObjectId(addressId)) throw addressNotFound();
  return { _id: addressId, userId };
}

export async function deliveryDetailsForLocation(latitude, longitude) {
  const distanceFromStoreKm = Number(distanceInKm(
    { latitude: env.STORE_LATITUDE, longitude: env.STORE_LONGITUDE },
    { latitude, longitude },
  ).toFixed(2));
  const zone = await deliveryZoneForDistance(distanceFromStoreKm);
  if (!zone || distanceFromStoreKm > env.DELIVERY_RADIUS_KM) {
    throw new AppError(`Delivery address is ${distanceFromStoreKm.toFixed(1)} km away. Service is unavailable for this location.`, 422, 'OUT_OF_DELIVERY_RADIUS', {
      distanceKm: distanceFromStoreKm,
      radiusKm: env.DELIVERY_RADIUS_KM,
    });
  }
  return { distanceFromStoreKm, deliveryZone: zone.code, deliveryCharge: zone.charge, radiusKm: env.DELIVERY_RADIUS_KM };
}

function normalizedAddress(user, payload, delivery, isDefault) {
  return {
    userId: user._id,
    flatNumber: payload.flatNumber,
    landmark: payload.landmark,
    formattedAddress: payload.formattedAddress,
    recipientName: payload.recipientName || user.name,
    phone: payload.phone || user.phone,
    line1: payload.line1,
    line2: payload.line2,
    city: payload.city,
    state: payload.state,
    pincode: payload.pincode,
    latitude: payload.latitude,
    longitude: payload.longitude,
    location: { type: 'Point', coordinates: [payload.longitude, payload.latitude] },
    distanceFromStoreKm: delivery.distanceFromStoreKm,
    deliveryZone: delivery.deliveryZone,
    deliveryCharge: delivery.deliveryCharge,
    isDefault,
  };
}

export function listAddresses(userId) {
  return Address.find({ userId }).sort({ isDefault: -1, createdAt: 1 });
}

export async function createAddress(user, payload) {
  const delivery = await deliveryDetailsForLocation(payload.latitude, payload.longitude);
  const addressCount = await Address.countDocuments({ userId: user._id });
  const isDefault = addressCount === 0 || payload.isDefault;
  if (isDefault) await Address.updateMany({ userId: user._id }, { $set: { isDefault: false } });
  const address = await Address.create(normalizedAddress(user, payload, delivery, isDefault));
  await User.updateOne({ _id: user._id }, { $addToSet: { addresses: address._id } });
  return { address, addresses: await listAddresses(user._id) };
}

export async function updateAddress(user, addressId, payload) {
  const filter = ownedAddressFilter(user._id, addressId);
  const current = await Address.findOne(filter);
  if (!current) throw addressNotFound();
  const delivery = await deliveryDetailsForLocation(payload.latitude, payload.longitude);
  const isDefault = payload.isDefault || current.isDefault;
  if (isDefault) await Address.updateMany({ userId: user._id, _id: { $ne: current._id } }, { $set: { isDefault: false } });
  const address = await Address.findOneAndUpdate(
    filter,
    { $set: normalizedAddress(user, payload, delivery, isDefault) },
    { new: true, runValidators: true },
  );
  return { address, addresses: await listAddresses(user._id) };
}

export async function setDefaultAddress(user, addressId) {
  const filter = ownedAddressFilter(user._id, addressId);
  const selected = await Address.findOne(filter);
  if (!selected) throw addressNotFound();
  await Address.updateMany({ userId: user._id }, { $set: { isDefault: false } });
  selected.isDefault = true;
  await selected.save();
  return { address: selected, addresses: await listAddresses(user._id) };
}

export async function deleteAddress(user, addressId) {
  const filter = ownedAddressFilter(user._id, addressId);
  const address = await Address.findOneAndDelete(filter);
  if (!address) throw addressNotFound();
  await User.updateOne({ _id: user._id }, { $pull: { addresses: address._id } });
  if (address.isDefault) {
    const next = await Address.findOne({ userId: user._id }).sort({ createdAt: 1 });
    if (next) {
      next.isDefault = true;
      await next.save();
    }
  }
  return { addresses: await listAddresses(user._id) };
}

export async function findOwnedAddress(userId, addressId, session) {
  if (!mongoose.isValidObjectId(addressId)) return null;
  const query = Address.findOne({ _id: addressId, userId });
  if (session) query.session(session);
  return query;
}
