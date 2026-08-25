import mongoose from 'mongoose';

const restrictedProductConsentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  addressId: { type: mongoose.Schema.Types.ObjectId, ref: 'Address' },
  policyVersion: { type: String, required: true },
  legalAgeConfirmed: { type: Boolean, required: true, validate: (value) => value === true },
  educationalInstitutionDistanceConfirmed: { type: Boolean, required: true, validate: (value) => value === true },
  healthWarningAcknowledged: { type: Boolean, required: true, validate: (value) => value === true },
  acceptedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

restrictedProductConsentSchema.index(
  { expiresAt: 1 },
  { name: 'restricted_product_consent_expiry', expireAfterSeconds: 0 },
);
restrictedProductConsentSchema.index(
  { user: 1, addressId: 1, policyVersion: 1, expiresAt: -1 },
  { name: 'restricted_product_consent_lookup' },
);

export const RestrictedProductConsent = mongoose.model('RestrictedProductConsent', restrictedProductConsentSchema);
