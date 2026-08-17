process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/sevenheaven_synthetic_test';
process.env.JWT_ACCESS_SECRET = 'synthetic-access-secret-1234567890';
process.env.JWT_REFRESH_SECRET = 'synthetic-refresh-secret-123456789';
process.env.OTP_HMAC_SECRET = 'synthetic-otp-hmac-secret-123456789012345';
process.env.WHATSAPP_PROVIDER = 'disabled';
process.env.OTP_WORKER_ENABLED = 'false';
process.env.COOKIE_SECURE = 'false';
