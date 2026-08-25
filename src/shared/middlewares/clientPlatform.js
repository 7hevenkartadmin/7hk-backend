import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { env } from '../../config/env.js';
import { AppError } from '../utils/AppError.js';

export const CLIENT_PLATFORM_HEADER = 'x-client-platform';
export const APP_CHECK_HEADER = 'x-firebase-appcheck';
export const CLIENT_PLATFORMS = Object.freeze({ WEB: 'web', ANDROID: 'android' });

const FIREBASE_APP_NAME = '7heven-android-app-check';
const APP_CHECK_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
let firebaseAppCheck;

function androidAppCheck() {
  if (firebaseAppCheck) return firebaseAppCheck;
  const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
  const app = existing || initializeApp({
    credential: applicationDefault(),
    projectId: env.FIREBASE_PROJECT_ID,
  }, FIREBASE_APP_NAME);
  firebaseAppCheck = getAppCheck(app);
  return firebaseAppCheck;
}

async function verifyFirebaseAppCheckToken(token) {
  return androidAppCheck().verifyToken(token);
}

function singleHeaderValue(value) {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

export function requestClientPlatform(req) {
  return req.clientPlatform?.platform === CLIENT_PLATFORMS.ANDROID
    ? CLIENT_PLATFORMS.ANDROID
    : CLIENT_PLATFORMS.WEB;
}

export function isAndroidRequest(req) {
  return requestClientPlatform(req) === CLIENT_PLATFORMS.ANDROID;
}

export function createClientPlatformMiddleware({
  mode = env.ANDROID_APP_CHECK_MODE,
  androidAppId = env.FIREBASE_ANDROID_APP_ID,
  verifyToken = verifyFirebaseAppCheckToken,
  report = (event) => console.warn('Android App Check monitor:', event),
} = {}) {
  return async function clientPlatformMiddleware(req, res, next) {
    res.vary(CLIENT_PLATFORM_HEADER);
    const claimed = singleHeaderValue(req.headers[CLIENT_PLATFORM_HEADER]).trim().toLowerCase();
    if (claimed && !Object.values(CLIENT_PLATFORMS).includes(claimed)) {
      return next(new AppError('Unsupported client platform', 400, 'CLIENT_PLATFORM_INVALID'));
    }

    const platform = claimed || CLIENT_PLATFORMS.WEB;
    const appCheckToken = singleHeaderValue(req.headers[APP_CHECK_HEADER]).trim();
    if (platform !== CLIENT_PLATFORMS.ANDROID && appCheckToken) {
      return next(new AppError(
        'Android app attestation requires the Android platform header',
        400,
        'CLIENT_PLATFORM_REQUIRED',
      ));
    }
    req.clientPlatform = { platform, attested: false };
    if (platform !== CLIENT_PLATFORMS.ANDROID) return next();

    // Prevent a shared CDN from serving an attested Android response to an
    // unattested caller or mixing it with the unrestricted web representation.
    res.setHeader('Cache-Control', 'private, no-store');
    const token = appCheckToken;
    const missing = !token;
    const malformed = token && (token.length > 8192 || !APP_CHECK_TOKEN_PATTERN.test(token));

    if (missing || malformed) {
      if (mode === 'enforce') {
        return next(new AppError(
          missing ? 'Android app attestation is required' : 'Android app attestation is invalid',
          401,
          missing ? 'APP_ATTESTATION_REQUIRED' : 'APP_ATTESTATION_INVALID',
        ));
      }
      if (mode === 'monitor') report({ reason: missing ? 'missing' : 'malformed', path: req.path });
      return next();
    }

    try {
      const verified = await verifyToken(token);
      const verifiedAppId = verified?.appId || verified?.token?.app_id;
      if (!verifiedAppId || verifiedAppId !== androidAppId) {
        throw new Error('Firebase App ID mismatch');
      }
      req.clientPlatform = { platform, attested: true, appId: verifiedAppId };
      return next();
    } catch {
      if (mode === 'enforce') {
        return next(new AppError('Android app attestation is invalid', 401, 'APP_ATTESTATION_INVALID'));
      }
      if (mode === 'monitor') report({ reason: 'invalid', path: req.path });
      return next();
    }
  };
}

export const identifyClientPlatform = createClientPlatformMiddleware();
