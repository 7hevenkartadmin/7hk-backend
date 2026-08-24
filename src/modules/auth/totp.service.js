import crypto from 'crypto';
import { env } from '../../config/env.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;

function encryptionKey() {
  if (env.OWNER_TOTP_ENCRYPTION_KEY) return Buffer.from(env.OWNER_TOTP_ENCRYPTION_KEY, 'hex');
  return crypto.createHash('sha256').update(`owner-totp:${env.JWT_REFRESH_SECRET}`).digest();
}

export function encodeBase32(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let encoded = '';
  for (let index = 0; index < bits.length; index += 5) {
    encoded += BASE32_ALPHABET[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  }
  return encoded;
}

export function decodeBase32(value) {
  const normalized = String(value || '').toUpperCase().replace(/=+$/u, '');
  if (!normalized || [...normalized].some((character) => !BASE32_ALPHABET.includes(character))) {
    throw new TypeError('Invalid Base32 secret');
  }
  const bits = [...normalized]
    .map((character) => BASE32_ALPHABET.indexOf(character).toString(2).padStart(5, '0'))
    .join('');
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

export function encryptTotpSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptTotpSecret(encrypted) {
  const [ivValue, tagValue, ciphertextValue, extra] = String(encrypted || '').split('.');
  if (!ivValue || !tagValue || !ciphertextValue || extra) throw new TypeError('Invalid encrypted TOTP secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function totpCode(secret, timestampMs = Date.now()) {
  const counter = BigInt(Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

export function verifyTotpCode(secret, code, timestampMs = Date.now(), window = 1) {
  if (!/^\d{6}$/u.test(String(code || ''))) return false;
  const supplied = Buffer.from(String(code));
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = Buffer.from(totpCode(secret, timestampMs + offset * TOTP_STEP_SECONDS * 1000));
    if (crypto.timingSafeEqual(supplied, expected)) return true;
  }
  return false;
}

export function ownerTotpUri({ email, secret }) {
  const issuer = '7HevenKart';
  const label = `${issuer}:${String(email).toLowerCase()}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
