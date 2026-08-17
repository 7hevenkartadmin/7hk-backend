export const INDIAN_MOBILE_PATTERN = /^(?:\+91)?[6-9][0-9]{9}$/;

export function normalizeIndianMobile(value) {
  if (typeof value !== 'string' || !INDIAN_MOBILE_PATTERN.test(value)) {
    throw new RangeError('Invalid Indian mobile number');
  }
  return value.startsWith('+91') ? value : `+91${value}`;
}
