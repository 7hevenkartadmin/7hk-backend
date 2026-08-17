import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  API_VERSION: z.string().default('v1'),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(24),
  JWT_REFRESH_SECRET: z.string().min(24),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('7d'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://admin.localhost:5173'),
  COOKIE_SECURE: z.coerce.boolean().default(false),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  OTP_HMAC_SECRET: z.string().min(32).optional(),
  OTP_QUEUE_NAME: z.string().min(1).default('otp-notifications'),
  OTP_WORKER_ENABLED: z.coerce.boolean().default(true),
  WHATSAPP_PROVIDER: z.enum(['disabled', 'mock', 'meta']).default('disabled'),
  META_WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
  META_WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/).optional(),
  META_WHATSAPP_TEMPLATE_NAME: z.string().regex(/^[a-z0-9_]+$/).optional(),
  META_WHATSAPP_TEMPLATE_LANGUAGE: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/).default('en_US'),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).optional(),
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
}).superRefine((data, ctx) => {
  const placeholderSecret = (value) => value.startsWith('replace-with');
  if (data.NODE_ENV === 'production'
    && (data.JWT_ACCESS_SECRET.length < 32 || placeholderSecret(data.JWT_ACCESS_SECRET))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_ACCESS_SECRET'],
      message: 'A random access-token secret of at least 32 characters is required in production',
    });
  }
  if (data.NODE_ENV === 'production'
    && (data.JWT_REFRESH_SECRET.length < 32 || placeholderSecret(data.JWT_REFRESH_SECRET))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_REFRESH_SECRET'],
      message: 'A random refresh-token secret of at least 32 characters is required in production',
    });
  }
  if (data.NODE_ENV === 'production' && !data.OTP_HMAC_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OTP_HMAC_SECRET'],
      message: 'A dedicated OTP HMAC secret is required in production',
    });
  }
  if (data.NODE_ENV === 'production' && data.OTP_HMAC_SECRET
    && (placeholderSecret(data.OTP_HMAC_SECRET)
      || data.OTP_HMAC_SECRET === data.JWT_ACCESS_SECRET
      || data.OTP_HMAC_SECRET === data.JWT_REFRESH_SECRET)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OTP_HMAC_SECRET'],
      message: 'OTP_HMAC_SECRET must be random and separate from both JWT secrets',
    });
  }
  if (data.NODE_ENV === 'production' && !data.COOKIE_SECURE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_SECURE'],
      message: 'Secure cookies are required in production',
    });
  }
  if (data.NODE_ENV === 'production' && data.JWT_ACCESS_SECRET === data.JWT_REFRESH_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_REFRESH_SECRET'],
      message: 'Access and refresh JWT secrets must be different',
    });
  }
  if (data.NODE_ENV === 'production') {
    [
      ['RAZORPAY_KEY_ID', data.RAZORPAY_KEY_ID, 8],
      ['RAZORPAY_KEY_SECRET', data.RAZORPAY_KEY_SECRET, 16],
      ['RAZORPAY_WEBHOOK_SECRET', data.RAZORPAY_WEBHOOK_SECRET, 16],
    ].forEach(([field, value, minLength]) => {
      if (!value || value.length < minLength || placeholderSecret(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must be configured for production payments` });
      }
    });
  }
  if (data.NODE_ENV === 'production' && data.WHATSAPP_PROVIDER !== 'meta') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WHATSAPP_PROVIDER'],
      message: 'The Meta WhatsApp provider is required in production',
    });
  }
  if (data.NODE_ENV === 'production' && !data.OTP_WORKER_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OTP_WORKER_ENABLED'],
      message: 'The OTP delivery worker is required in production',
    });
  }
  if (data.NODE_ENV === 'production') {
    [
      ['CLOUDINARY_CLOUD_NAME', data.CLOUDINARY_CLOUD_NAME],
      ['CLOUDINARY_API_KEY', data.CLOUDINARY_API_KEY],
      ['CLOUDINARY_API_SECRET', data.CLOUDINARY_API_SECRET],
    ].forEach(([field, value]) => {
      if (!value || placeholderSecret(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required in production` });
      }
    });
  }
  const requiredMetaFields = [
    ['META_WHATSAPP_ACCESS_TOKEN', data.META_WHATSAPP_ACCESS_TOKEN, 20],
    ['META_WHATSAPP_PHONE_NUMBER_ID', data.META_WHATSAPP_PHONE_NUMBER_ID, 1],
    ['META_WHATSAPP_TEMPLATE_NAME', data.META_WHATSAPP_TEMPLATE_NAME, 1],
    ['META_GRAPH_API_VERSION', data.META_GRAPH_API_VERSION, 1],
    ['META_WHATSAPP_APP_SECRET', data.META_WHATSAPP_APP_SECRET, 16],
    ['META_WHATSAPP_WEBHOOK_VERIFY_TOKEN', data.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN, 16],
  ];
  if (data.NODE_ENV === 'production' && data.WHATSAPP_PROVIDER === 'meta') {
    requiredMetaFields.forEach(([field, value, minLength]) => {
      if (!value || value.length < minLength || placeholderSecret(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be configured for Meta WhatsApp delivery`,
        });
      }
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid backend environment', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  OTP_HMAC_SECRET: parsed.data.OTP_HMAC_SECRET || parsed.data.JWT_REFRESH_SECRET,
  CORS_ORIGINS: parsed.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};
