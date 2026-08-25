import mongoose from 'mongoose';
import { AppError } from '../../shared/utils/AppError.js';
import { Address } from '../addresses/address.model.js';
import { isPaanCornerItem } from '../payments/payment-policy.js';
import { RestrictedProductConsent } from './restrictedProductConsent.model.js';

export const RESTRICTED_PRODUCT_POLICY_VERSION = '2026-08-25';
export const RESTRICTED_PRODUCT_CONSENT_TTL_MS = 12 * 60 * 60 * 1000;

export function restrictedProductPolicyForItems(items = []) {
  const consentRequired = items.some(isPaanCornerItem);
  return {
    version: RESTRICTED_PRODUCT_POLICY_VERSION,
    consentRequired,
    minimumAge: 18,
    educationalInstitutionMinimumDistanceYards: 100,
    cashOnDeliveryOnly: consentRequired,
    couponsAllowed: !consentRequired,
    message: consentRequired
      ? 'Restricted products require an adult declaration and a delivery location outside the educational-institution exclusion zone.'
      : null,
  };
}

export function assertRestrictedProductCouponAllowed(items, couponCode) {
  const policy = restrictedProductPolicyForItems(items);
  if (!policy.consentRequired || !String(couponCode || '').trim()) return policy;
  throw new AppError(
    'Coupons and promotional discounts are not available on orders containing restricted products.',
    422,
    'RESTRICTED_PRODUCT_COUPON_NOT_ALLOWED',
    { restrictedProductPolicy: policy },
  );
}

export async function recordRestrictedProductConsent(user, payload) {
  if (payload.addressId) {
    const addressExists = await Address.exists({ _id: payload.addressId, userId: user._id });
    if (!addressExists) throw new AppError('Delivery address not found', 404, 'ADDRESS_NOT_FOUND');
  }
  const acceptedAt = new Date();
  const consent = await RestrictedProductConsent.create({
    user: user._id,
    addressId: payload.addressId,
    policyVersion: RESTRICTED_PRODUCT_POLICY_VERSION,
    legalAgeConfirmed: true,
    educationalInstitutionDistanceConfirmed: true,
    healthWarningAcknowledged: true,
    acceptedAt,
    expiresAt: new Date(acceptedAt.getTime() + RESTRICTED_PRODUCT_CONSENT_TTL_MS),
  });
  return {
    consentId: String(consent._id),
    userId: String(user._id),
    policyVersion: consent.policyVersion,
    addressId: consent.addressId ? String(consent.addressId) : undefined,
    acceptedAt: consent.acceptedAt,
    expiresAt: consent.expiresAt,
  };
}

export async function assertRestrictedProductConsentForOrder({
  items,
  customer,
  consentId,
  addressId,
  session,
}) {
  const policy = restrictedProductPolicyForItems(items);
  if (!policy.consentRequired) return null;
  if (!consentId || !mongoose.isValidObjectId(consentId)) {
    throw new AppError(policy.message, 422, 'RESTRICTED_PRODUCT_CONSENT_REQUIRED', { restrictedProductPolicy: policy });
  }
  const query = RestrictedProductConsent.findOne({
    _id: consentId,
    user: customer._id,
    addressId,
    policyVersion: RESTRICTED_PRODUCT_POLICY_VERSION,
    legalAgeConfirmed: true,
    educationalInstitutionDistanceConfirmed: true,
    healthWarningAcknowledged: true,
    expiresAt: { $gt: new Date() },
  });
  if (session) query.session(session);
  const consent = await query;
  if (!consent) {
    throw new AppError(
      'Restricted-product acknowledgement is missing, expired, or does not match this delivery address.',
      422,
      'RESTRICTED_PRODUCT_CONSENT_REQUIRED',
      { restrictedProductPolicy: policy },
    );
  }
  return {
    consent: consent._id,
    policyVersion: consent.policyVersion,
    acceptedAt: consent.acceptedAt,
    legalAgeConfirmed: true,
    educationalInstitutionDistanceConfirmed: true,
    healthWarningAcknowledged: true,
  };
}
