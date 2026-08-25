import dotenv from 'dotenv';
import { z } from 'zod';

if (process.env.NODE_ENV !== 'test') dotenv.config();

const strictEnvironmentBoolean = (defaultValue) => z.string()
  .refine((value) => value === 'true' || value === 'false', {
    message: 'must be exactly "true" or "false"',
  })
  .default(String(defaultValue))
  .transform((value) => value === 'true');

const whatsappProviderSchema = z.string()
  .refine((value) => ['disabled', 'console', 'meta'].includes(value), {
    message: 'must select an implemented provider',
  })
  .default('disabled');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  API_VERSION: z.string().default('v1'),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(24),
  JWT_REFRESH_SECRET: z.string().min(24),
  ACCESS_TOKEN_TTL: z.string().default('30m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://admin.localhost:5173'),
  COOKIE_SECURE: strictEnvironmentBoolean(false),
  ADMIN_APP_URL: z.string().url().default('http://localhost:5174'),
  OWNER_TOTP_ENCRYPTION_KEY: z.union([z.string().regex(/^[a-fA-F0-9]{64}$/), z.literal('')]).default(''),
  SMTP_HOST: z.string().trim().optional().default(''),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  SMTP_SECURE: strictEnvironmentBoolean(false),
  SMTP_USER: z.string().trim().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.union([z.string().email(), z.literal('')]).default(''),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  OTP_HMAC_SECRET: z.string().min(32).optional(),
  OTP_QUEUE_NAME: z.string().min(1).default('otp-notifications'),
  OTP_WORKER_ENABLED: strictEnvironmentBoolean(true),
  WHATSAPP_PROVIDER: whatsappProviderSchema,
  META_WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
  META_WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
  META_WHATSAPP_TEMPLATE_NAME: z.string().optional().default(''),
  META_WHATSAPP_TEMPLATE_LANGUAGE: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/).default('en_US'),
  META_GRAPH_API_VERSION: z.string().optional().default(''),
  META_GRAPH_API_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  META_WHATSAPP_APP_SECRET: z.string().optional().default(''),
  META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional().default(''),
  CLOUDINARY_CLOUD_NAME: z.string().trim().optional().default(''),
  CLOUDINARY_API_KEY: z.string().trim().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().trim().optional().default(''),
  CLOUDINARY_FOLDER: z.string().trim().regex(/^[a-zA-Z0-9/_-]+$/).default('7heven/catalog'),
  CLOUDINARY_MAX_IMAGE_MB: z.coerce.number().int().min(1).max(3).default(3),
  LOW_STOCK_THRESHOLD: z.coerce.number().int().positive().default(20),
  STORE_LATITUDE: z.coerce.number().default(26.713052497465416),
  STORE_LONGITUDE: z.coerce.number().default(85.68640273918543),
  DELIVERY_RADIUS_KM: z.coerce.number().positive().default(10),
  ANDROID_APP_CHECK_MODE: z.enum(['off', 'monitor', 'enforce']).default('monitor'),
  FIREBASE_PROJECT_ID: z.string().trim().regex(/^[a-z][a-z0-9-]{4,29}$/).or(z.literal('')).default(''),
  FIREBASE_ANDROID_APP_ID: z.string().trim().regex(/^1:\d+:android:[a-fA-F0-9]+$/).or(z.literal('')).default(''),
}).superRefine((data, ctx) => {
  const isPlaceholder = (value) => String(value || '').trim().toLowerCase().startsWith('replace-with');
  const issue = (field, message) => ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [field],
    message: `${field} ${message}`,
  });

  if (data.NODE_ENV === 'production') {
    if (data.JWT_ACCESS_SECRET.length < 32 || isPlaceholder(data.JWT_ACCESS_SECRET)) {
      issue('JWT_ACCESS_SECRET', 'requires a random value of at least 32 characters in production');
    }
    if (data.JWT_REFRESH_SECRET.length < 32 || isPlaceholder(data.JWT_REFRESH_SECRET)) {
      issue('JWT_REFRESH_SECRET', 'requires a random value of at least 32 characters in production');
    }
    if (!data.OTP_HMAC_SECRET) issue('OTP_HMAC_SECRET', 'is required in production');
    if (data.OTP_HMAC_SECRET && (isPlaceholder(data.OTP_HMAC_SECRET)
      || data.OTP_HMAC_SECRET === data.JWT_ACCESS_SECRET
      || data.OTP_HMAC_SECRET === data.JWT_REFRESH_SECRET)) {
      issue('OTP_HMAC_SECRET', 'must be random and separate from JWT secrets');
    }
    if (!data.COOKIE_SECURE) issue('COOKIE_SECURE', 'must be true in production');
    if (data.JWT_ACCESS_SECRET === data.JWT_REFRESH_SECRET) {
      issue('JWT_REFRESH_SECRET', 'must differ from JWT_ACCESS_SECRET');
    }
    if (!data.OWNER_TOTP_ENCRYPTION_KEY) {
      issue('OWNER_TOTP_ENCRYPTION_KEY', 'requires a random 32-byte hexadecimal key in production');
    }
    if (!data.ADMIN_APP_URL.startsWith('https://')) {
      issue('ADMIN_APP_URL', 'must use HTTPS in production');
    }
    [
      ['SMTP_HOST', data.SMTP_HOST],
      ['SMTP_USER', data.SMTP_USER],
      ['SMTP_PASS', data.SMTP_PASS],
      ['SMTP_FROM', data.SMTP_FROM],
    ].forEach(([field, value]) => {
      if (!value || isPlaceholder(value)) issue(field, 'is required for production admin security emails');
    });
    [
      ['RAZORPAY_KEY_ID', data.RAZORPAY_KEY_ID, 8],
      ['RAZORPAY_KEY_SECRET', data.RAZORPAY_KEY_SECRET, 16],
      ['RAZORPAY_WEBHOOK_SECRET', data.RAZORPAY_WEBHOOK_SECRET, 16],
    ].forEach(([field, value, minimum]) => {
      if (!value || value.length < minimum || isPlaceholder(value)) issue(field, 'is not configured for production payments');
    });
    if (data.RAZORPAY_KEY_ID && !data.RAZORPAY_KEY_ID.startsWith('rzp_live_')) {
      issue('RAZORPAY_KEY_ID', 'must be a Live Mode key (rzp_live_...) in production');
    }
    if (data.WHATSAPP_PROVIDER !== 'meta') issue('WHATSAPP_PROVIDER', 'must be meta in production');
    if (!data.OTP_WORKER_ENABLED) issue('OTP_WORKER_ENABLED', 'must be true in production');
    if (data.ANDROID_APP_CHECK_MODE !== 'enforce') {
      issue('ANDROID_APP_CHECK_MODE', 'must be enforce in production');
    }
    [
      ['CLOUDINARY_CLOUD_NAME', data.CLOUDINARY_CLOUD_NAME],
      ['CLOUDINARY_API_KEY', data.CLOUDINARY_API_KEY],
      ['CLOUDINARY_API_SECRET', data.CLOUDINARY_API_SECRET],
    ].forEach(([field, value]) => {
      if (!value || isPlaceholder(value)) issue(field, 'is required in production');
    });
  }

  if (data.WHATSAPP_PROVIDER === 'meta') {
    const checks = [
      ['META_WHATSAPP_ACCESS_TOKEN', data.META_WHATSAPP_ACCESS_TOKEN, 20, null],
      ['META_WHATSAPP_PHONE_NUMBER_ID', data.META_WHATSAPP_PHONE_NUMBER_ID, 1, /^\d+$/],
      ['META_WHATSAPP_TEMPLATE_NAME', data.META_WHATSAPP_TEMPLATE_NAME, 1, /^[a-z0-9_]+$/],
      ['META_GRAPH_API_VERSION', data.META_GRAPH_API_VERSION, 1, /^v\d+\.\d+$/],
      ['META_WHATSAPP_APP_SECRET', data.META_WHATSAPP_APP_SECRET, 16, null],
      ['META_WHATSAPP_WEBHOOK_VERIFY_TOKEN', data.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN, 16, null],
    ];
    checks.forEach(([field, rawValue, minimum, pattern]) => {
      const value = String(rawValue || '').trim();
      if (!value || value.length < minimum || isPlaceholder(value)) {
        issue(field, 'is required for Meta WhatsApp delivery');
      } else if (pattern && !pattern.test(value)) {
        issue(field, 'has an invalid format');
      }
    });
  }

  if (data.ANDROID_APP_CHECK_MODE === 'enforce') {
    if (!data.FIREBASE_PROJECT_ID || isPlaceholder(data.FIREBASE_PROJECT_ID)) {
      issue('FIREBASE_PROJECT_ID', 'is required when Android App Check is enforced');
    }
    if (!data.FIREBASE_ANDROID_APP_ID || isPlaceholder(data.FIREBASE_ANDROID_APP_ID)) {
      issue('FIREBASE_ANDROID_APP_ID', 'is required when Android App Check is enforced');
    }
  }
});

export function parseEnvironment(source) {
  const parsed = envSchema.parse(source);
  return {
    ...parsed,
    OTP_HMAC_SECRET: parsed.OTP_HMAC_SECRET || parsed.JWT_REFRESH_SECRET,
    CORS_ORIGINS: parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  };
}

let runtimeEnvironment;
try {
  runtimeEnvironment = parseEnvironment(process.env);
} catch (error) {
  const fieldErrors = error instanceof z.ZodError
    ? error.flatten().fieldErrors
    : { environment: ['Environment validation failed'] };
  console.error('Invalid backend environment', fieldErrors);
  process.exit(1);
}

export const env = runtimeEnvironment;
