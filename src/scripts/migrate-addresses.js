import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Address } from '../modules/addresses/address.model.js';
import { deliveryDetailsForLocation } from '../modules/addresses/address.service.js';

const apply = process.argv.includes('--apply');
const phonePattern = /^(?:\+91)?[6-9][0-9]{9}$/;

function isObjectId(value) {
  return value instanceof mongoose.Types.ObjectId || value?._bsontype === 'ObjectId';
}

await connectDatabase();

const users = mongoose.connection.collection('users');
const cursor = users.find({ 'addresses.0': { $exists: true } });
let usersScanned = 0;
let legacyAddresses = 0;
let referencesReused = 0;

for await (const user of cursor) {
  usersScanned += 1;
  const references = [];
  for (const entry of user.addresses || []) {
    if (isObjectId(entry)) {
      references.push(entry);
      continue;
    }
    legacyAddresses += 1;
    const latitude = Number(entry.latitude);
    const longitude = Number(entry.longitude);
    const phone = entry.phone || user.phone;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !phonePattern.test(phone || '')) {
      throw new Error(`Cannot migrate address for user ${user._id}: valid coordinates and phone are required`);
    }
    const line1 = entry.line1 || [entry.flatNumber, entry.formattedAddress].filter(Boolean).join(', ');
    const existing = await Address.findOne({ userId: user._id, latitude, longitude, line1 }).select('_id').lean();
    const addressId = existing?._id || entry._id || new mongoose.Types.ObjectId();
    if (existing) referencesReused += 1;
    if (apply && !existing) {
      const delivery = await deliveryDetailsForLocation(latitude, longitude);
      await Address.create({
        _id: addressId,
        userId: user._id,
        flatNumber: entry.flatNumber || '',
        landmark: entry.landmark || '',
        formattedAddress: entry.formattedAddress || entry.line2 || '',
        recipientName: entry.recipientName || user.name,
        phone,
        line1,
        line2: entry.line2 || entry.formattedAddress || '',
        city: entry.city || 'Parihar',
        state: entry.state || 'Bihar',
        pincode: entry.pincode || '843324',
        latitude,
        longitude,
        location: { type: 'Point', coordinates: [longitude, latitude] },
        distanceFromStoreKm: delivery.distanceFromStoreKm,
        deliveryZone: delivery.deliveryZone,
        deliveryCharge: delivery.deliveryCharge,
        isDefault: Boolean(entry.isDefault),
      });
    }
    references.push(addressId);
  }
  if (apply) await users.updateOne({ _id: user._id }, { $set: { addresses: references } });
}

console.log(`${apply ? 'Applied' : 'Dry run'}: ${usersScanned} users scanned, ${legacyAddresses} embedded addresses found, ${referencesReused} existing address documents reused.`);
if (!apply && legacyAddresses > 0) console.log('Run npm run migrate:addresses -- --apply to persist this migration.');
await disconnectDatabase();
