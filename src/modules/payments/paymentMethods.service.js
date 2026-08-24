import { env } from '../../config/env.js';
import { AppError } from '../../shared/utils/AppError.js';

const RAZORPAY_METHODS_URL = 'https://api.razorpay.com/v1/methods';
const METHOD_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 8000;
const POPULAR_BANK_CODES = new Set(['SBIN', 'HDFC', 'ICIC', 'UTIB', 'KKBK', 'YESB', 'BARB_R', 'PUNB_R']);

export const UPI_CHECKOUT_CHOICES = Object.freeze([
  { id: 'gpay', label: 'Google Pay' },
  { id: 'phonepe', label: 'PhonePe' },
  { id: 'paytm', label: 'Paytm' },
  { id: 'bhim', label: 'BHIM' },
  { id: 'upi-id', label: 'UPI ID' },
  { id: 'qr', label: 'QR code' },
]);

let cachedCatalog;

export function normalizeRazorpayMethodCatalog(payload = {}) {
  const source = payload?.netbanking && typeof payload.netbanking === 'object'
    ? payload.netbanking
    : {};
  const banks = Object.entries(source)
    .filter(([code, name]) => /^[A-Z0-9_]{3,20}$/.test(code) && typeof name === 'string' && name.trim())
    .map(([code, name]) => ({ code, name: name.trim(), popular: POPULAR_BANK_CODES.has(code) }))
    .sort((left, right) => Number(right.popular) - Number(left.popular) || left.name.localeCompare(right.name));

  return { banks, upiChoices: UPI_CHECKOUT_CHOICES };
}

export function clearPaymentMethodCatalogCache() {
  cachedCatalog = undefined;
}

export async function getRazorpayMethodCatalog({
  fetchImpl = globalThis.fetch,
  keyId = env.RAZORPAY_KEY_ID,
  now = Date.now(),
} = {}) {
  if (cachedCatalog && cachedCatalog.expiresAt > now) return cachedCatalog.value;
  if (!keyId) throw new AppError('Online payment methods are not configured', 503, 'PAYMENT_CONFIG_MISSING');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const authorization = Buffer.from(`${keyId}:`).toString('base64');
    const response = await fetchImpl(RAZORPAY_METHODS_URL, {
      headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Razorpay methods request failed with ${response.status}`);
    const value = normalizeRazorpayMethodCatalog(await response.json());
    if (!value.banks.length) throw new Error('Razorpay returned an empty bank catalog');
    cachedCatalog = { value, expiresAt: now + METHOD_CATALOG_TTL_MS };
    return value;
  } catch {
    if (cachedCatalog?.value) return cachedCatalog.value;
    throw new AppError('Payment methods are temporarily unavailable', 503, 'PAYMENT_METHODS_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}
