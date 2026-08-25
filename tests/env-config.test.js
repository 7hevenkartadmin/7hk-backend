import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvironment } from '../src/config/env.js';

const base = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/synthetic',
  JWT_ACCESS_SECRET: 'synthetic-access-secret-1234567890',
  JWT_REFRESH_SECRET: 'synthetic-refresh-secret-123456789',
  OTP_HMAC_SECRET: 'synthetic-otp-hmac-secret-123456789012345',
};

const validMeta = {
  WHATSAPP_PROVIDER: 'meta',
  META_WHATSAPP_ACCESS_TOKEN: 'synthetic_meta_access_token_12345',
  META_WHATSAPP_PHONE_NUMBER_ID: '123456789',
  META_WHATSAPP_TEMPLATE_NAME: 'sevenheaven_login_otp',
  META_GRAPH_API_VERSION: 'v23.0',
  META_WHATSAPP_APP_SECRET: 'synthetic_app_secret_12345',
  META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'synthetic_verify_token_12345',
};

const productionRequirements = {
  COOKIE_SECURE: 'true',
  OTP_WORKER_ENABLED: 'true',
  RAZORPAY_KEY_ID: 'rzp_live_synthetic',
  RAZORPAY_KEY_SECRET: 'synthetic_payment_secret_12345',
  RAZORPAY_WEBHOOK_SECRET: 'synthetic_webhook_secret_12345',
  CLOUDINARY_CLOUD_NAME: 'synthetic-cloud',
  CLOUDINARY_API_KEY: 'synthetic-cloud-key',
  CLOUDINARY_API_SECRET: 'synthetic-cloud-secret',
  ADMIN_APP_URL: 'https://admin.example.com',
  OWNER_TOTP_ENCRYPTION_KEY: 'ab'.repeat(32),
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_USER: 'security@example.com',
  SMTP_PASS: 'synthetic-smtp-password',
  SMTP_FROM: 'security@example.com',
  ANDROID_APP_CHECK_MODE: 'enforce',
  FIREBASE_PROJECT_ID: 'synthetic-firebase-project',
  FIREBASE_ANDROID_APP_ID: '1:123456789:android:abcdef123456',
};

function environmentFor(NODE_ENV, overrides = {}) {
  return {
    ...base,
    ...(NODE_ENV === 'production' ? productionRequirements : {}),
    NODE_ENV,
    ...overrides,
  };
}

function assertIssueFields(source, expectedFields, forbiddenValues = []) {
  assert.throws(() => parseEnvironment(source), (error) => {
    const fields = new Set(error.issues.map((issue) => issue.path[0]));
    expectedFields.forEach((field) => assert.equal(fields.has(field), true, `${field} must be reported`));
    const serializedIssues = JSON.stringify(error.issues);
    forbiddenValues.forEach((value) => assert.equal(serializedIssues.includes(value), false));
    return true;
  });
}

test('environment booleans default only when absent and preserve exact true and false strings', () => {
  assert.equal(parseEnvironment(base).COOKIE_SECURE, false);
  assert.equal(parseEnvironment(base).OTP_WORKER_ENABLED, true);
  assert.equal(parseEnvironment({ ...base, COOKIE_SECURE: 'false' }).COOKIE_SECURE, false);
  assert.equal(parseEnvironment({ ...base, COOKIE_SECURE: 'true' }).COOKIE_SECURE, true);
  assert.equal(parseEnvironment({ ...base, OTP_WORKER_ENABLED: 'false' }).OTP_WORKER_ENABLED, false);
  assert.equal(parseEnvironment({ ...base, OTP_WORKER_ENABLED: 'true' }).OTP_WORKER_ENABLED, true);

  for (const invalidValue of ['1', '0', 'yes', 'False', '', true, false]) {
    assert.throws(() => parseEnvironment({ ...base, COOKIE_SECURE: invalidValue }));
    assert.throws(() => parseEnvironment({ ...base, OTP_WORKER_ENABLED: invalidValue }));
  }
});

test('only implemented OTP delivery providers are accepted', () => {
  assert.equal(parseEnvironment({ ...base, WHATSAPP_PROVIDER: 'disabled' }).WHATSAPP_PROVIDER, 'disabled');
  assert.equal(parseEnvironment({ ...base, WHATSAPP_PROVIDER: 'console' }).WHATSAPP_PROVIDER, 'console');
  for (const unsupported of ['mock', 'twilio', 'META', '']) {
    assertIssueFields({ ...base, WHATSAPP_PROVIDER: unsupported }, ['WHATSAPP_PROVIDER']);
  }
});

test('valid Meta configuration is accepted in every environment', () => {
  for (const NODE_ENV of ['development', 'test', 'production']) {
    assert.equal(
      parseEnvironment(environmentFor(NODE_ENV, validMeta)).WHATSAPP_PROVIDER,
      'meta',
    );
  }
});

test('production requires enforced Android App Check with an exact Firebase identity', () => {
  assertIssueFields(
    environmentFor('production', { ...validMeta, ANDROID_APP_CHECK_MODE: 'monitor' }),
    ['ANDROID_APP_CHECK_MODE'],
  );
  assertIssueFields(
    environmentFor('production', {
      ...validMeta,
      FIREBASE_PROJECT_ID: '',
      FIREBASE_ANDROID_APP_ID: '',
    }),
    ['FIREBASE_PROJECT_ID', 'FIREBASE_ANDROID_APP_ID'],
  );
});

test('Meta selection reports every missing field together in every environment', () => {
  const requiredFields = Object.keys(validMeta).filter((field) => field !== 'WHATSAPP_PROVIDER');
  for (const NODE_ENV of ['development', 'test', 'production']) {
    assertIssueFields(
      environmentFor(NODE_ENV, { WHATSAPP_PROVIDER: 'meta' }),
      requiredFields,
    );
  }
});

test('Meta fields reject empty, placeholder, short, and malformed values without exposing values', () => {
  const invalidCases = {
    META_WHATSAPP_ACCESS_TOKEN: ['', ' RePlAcE-WiTh-access-token ', 'short'],
    META_WHATSAPP_PHONE_NUMBER_ID: ['', 'replace-with-phone-id', '123x'],
    META_WHATSAPP_TEMPLATE_NAME: ['', 'replace-with-template', 'Invalid-Template'],
    META_GRAPH_API_VERSION: ['', 'replace-with-version', '23.0'],
    META_WHATSAPP_APP_SECRET: ['', 'replace-with-app-secret', 'tiny'],
    META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: ['', 'replace-with-verify-token', 'tiny'],
  };

  for (const NODE_ENV of ['development', 'test', 'production']) {
    for (const [field, invalidValues] of Object.entries(invalidCases)) {
      for (const invalidValue of invalidValues) {
        assertIssueFields(
          environmentFor(NODE_ENV, { ...validMeta, [field]: invalidValue }),
          [field],
          invalidValue ? [invalidValue] : [],
        );
      }
    }
  }
});

test('parser returns normalized derived values without reading process environment', () => {
  const parsed = parseEnvironment({
    ...base,
    OTP_HMAC_SECRET: undefined,
    CORS_ORIGINS: 'https://store.example, https://admin.example,',
  });
  assert.equal(parsed.OTP_HMAC_SECRET, base.JWT_REFRESH_SECRET);
  assert.deepEqual(parsed.CORS_ORIGINS, ['https://store.example', 'https://admin.example']);
  assert.equal(parsed.REFRESH_TOKEN_TTL, '30d');
});

test('invalid booleans and providers use value-free parser issues', () => {
  const invalidCases = [
    ['COOKIE_SECURE', 'secret-boolean-canary'],
    ['OTP_WORKER_ENABLED', 'secret-worker-canary'],
    ['WHATSAPP_PROVIDER', 'secret-provider-canary'],
  ];

  for (const [field, value] of invalidCases) {
    assertIssueFields({ ...base, [field]: value }, [field], [value]);
  }
});

test('Meta validation aggregates malformed fields without exposing configured values', () => {
  const invalidMeta = {
    ...validMeta,
    META_WHATSAPP_ACCESS_TOKEN: 'replace-with-access-canary',
    META_WHATSAPP_PHONE_NUMBER_ID: 'phone-id-canary',
    META_WHATSAPP_TEMPLATE_NAME: 'Template-Canary',
    META_GRAPH_API_VERSION: 'version-canary',
    META_WHATSAPP_APP_SECRET: 'tiny-app',
    META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'tiny-verify',
  };
  const requiredFields = Object.keys(validMeta).filter((field) => field !== 'WHATSAPP_PROVIDER');
  const configuredValues = requiredFields.map((field) => invalidMeta[field]);

  assertIssueFields(
    environmentFor('test', invalidMeta),
    requiredFields,
    configuredValues,
  );
});

test('production preserves secure-cookie, Meta-provider, and enabled-worker safeguards', () => {
  assertIssueFields(
    environmentFor('production', { ...validMeta, COOKIE_SECURE: 'false' }),
    ['COOKIE_SECURE'],
  );
  assertIssueFields(
    environmentFor('production', { WHATSAPP_PROVIDER: 'disabled' }),
    ['WHATSAPP_PROVIDER'],
  );
  assertIssueFields(
    environmentFor('production', { WHATSAPP_PROVIDER: 'console' }),
    ['WHATSAPP_PROVIDER'],
  );
  assertIssueFields(
    environmentFor('production', { ...validMeta, OTP_WORKER_ENABLED: 'false' }),
    ['OTP_WORKER_ENABLED'],
  );
});

test('production rejects Razorpay test-mode keys', () => {
  assertIssueFields(
    environmentFor('production', { ...validMeta, RAZORPAY_KEY_ID: 'rzp_test_synthetic' }),
    ['RAZORPAY_KEY_ID'],
  );
});

test('startup exits before serving and prints only sanitized field reasons', async () => {
  const { spawnSync } = await import('node:child_process');
  const envModule = new URL('../src/config/env.js', import.meta.url).href;
  const invalidMeta = {
    ...validMeta,
    META_WHATSAPP_ACCESS_TOKEN: 'replace-with-startup-access-canary',
    META_WHATSAPP_PHONE_NUMBER_ID: 'startup-phone-canary',
    META_WHATSAPP_TEMPLATE_NAME: 'Startup-Template-Canary',
    META_GRAPH_API_VERSION: 'startup-version-canary',
    META_WHATSAPP_APP_SECRET: 'app-x',
    META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-x',
  };
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import(${JSON.stringify(envModule)})`],
    {
      cwd: process.env.TEMP || process.cwd(),
      encoding: 'utf8',
      env: { ...base, ...invalidMeta },
    },
  );

  assert.equal(result.status, 1);
  for (const field of Object.keys(validMeta).filter((name) => name !== 'WHATSAPP_PROVIDER')) {
    assert.equal(result.stderr.includes(field), true, `${field} must be reported at startup`);
    assert.equal(result.stderr.includes(invalidMeta[field]), false, `${field} value must be redacted`);
  }
});
