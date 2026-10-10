import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_LOGIN_PHONE, DEMO_LOGIN_OTP, DEMO_LOGIN_USER_ID, demoOtpFor, requireNonDemoCustomer } from '../src/modules/auth/demo-login.js';
import { buildLoginOtpPayload } from '../src/modules/auth/otp.module.js';
import { requestOtpWithDependencies, verifyOtpWithDependencies } from '../src/modules/auth/auth.service.js';
import { User } from '../src/modules/users/user.model.js';
import { createLoginCompletionHarness } from './helpers/login-completion-harness.js';
import { createTestClient } from './helpers/http.js';
import { signAccessToken } from '../src/modules/auth/token.service.js';
import { env } from '../src/config/env.js';
import { userSessionIsCurrent } from '../src/modules/auth/auth.middleware.js';

test('fixed OTP applies only to the configured demo login identity', () => {
  const demo = buildLoginOtpPayload(DEMO_LOGIN_PHONE, true);
  assert.equal(demoOtpFor(demo, true), DEMO_LOGIN_OTP);
  assert.equal(demoOtpFor(buildLoginOtpPayload(DEMO_LOGIN_PHONE), true), null);
  assert.equal(demoOtpFor(demo, false), null);
  assert.equal(demoOtpFor({ ...demo, userId: '+919888888888' }, true), null);
  assert.equal(demoOtpFor({ ...demo, purpose: 'DELIVERY' }, true), null);
  assert.equal(demoOtpFor({ ...demo, recipient: '+919888888888' }, true), null);
});

test('demo request and verify use a separate identity without affecting normal OTP for the same phone', async () => {
  const requests = [];
  const otpService = {
    async requestOtp(payload) { requests.push(payload); return { expiresIn: 300, resendAfterSeconds: 30 }; },
    async verifyOtp(payload) { requests.push(payload); return { status: 'OTP_VERIFIED', proofId: 'demo-proof' }; },
    async markVerifiedProofCompleted() {},
  };
  const getOtpService = () => otpService;
  await requestOtpWithDependencies(DEMO_LOGIN_PHONE, 'normal', { getOtpService });
  await requestOtpWithDependencies(DEMO_LOGIN_PHONE, 'demo', { getOtpService, demo: true, demoEnabled: true });
  assert.equal(requests[0].userId, DEMO_LOGIN_PHONE);
  assert.equal(requests[1].userId, `demo:${DEMO_LOGIN_PHONE}`);

  const session = { user: { demoAccount: true } };
  assert.equal(await verifyOtpWithDependencies({ phone: DEMO_LOGIN_PHONE, otp: DEMO_LOGIN_OTP, demo: true }, {
    otpService, demoEnabled: true, async completeLogin(input) {
      assert.equal(input.demo, true);
      return session;
    },
  }), session);
  assert.equal(requests[2].userId, requests[1].userId);
  await assert.rejects(requestOtpWithDependencies(DEMO_LOGIN_PHONE, 'disabled', { getOtpService, demo: true, demoEnabled: false }), { code: 'DEMO_LOGIN_UNAVAILABLE' });
  await assert.rejects(requestOtpWithDependencies('+919888888888', 'wrong-number', { getOtpService, demo: true, demoEnabled: true }), { code: 'DEMO_LOGIN_UNAVAILABLE' });
});

test('demo account has its own stable record, no phone, and cannot mutate customer data', async () => {
  const model = new User({ _id: DEMO_LOGIN_USER_ID, name: 'Demo Customer', role: 'customer', demoAccount: true, passwordHash: 'synthetic-hash' });
  assert.equal(model.validateSync(), undefined);
  assert.equal(model.phone, undefined);
  assert.ok(new User({ name: 'Customer', role: 'customer', passwordHash: 'synthetic-hash' }).validateSync()?.errors.phone);

  const harness = createLoginCompletionHarness({ demoEnabled: true });
  const result = await harness.complete({ normalizedPhone: DEMO_LOGIN_PHONE, demo: true });
  assert.equal(result.user.demoAccount, true);
  assert.equal(result.user.phone, DEMO_LOGIN_PHONE);
  assert.equal(harness.snapshot().user.phone, undefined);

  let error;
  requireNonDemoCustomer({ user: { demoAccount: true } }, {}, (value) => { error = value; });
  assert.equal(error?.code, 'DEMO_READ_ONLY');
  requireNonDemoCustomer({ user: { demoAccount: false } }, {}, (value) => { error = value; });
  assert.equal(error, undefined);
});

test('shared demo session cannot write addresses, orders, payments, support or profile', async (t) => {
  const previouslyEnabled = env.DEMO_LOGIN_ENABLED;
  env.DEMO_LOGIN_ENABLED = true;
  t.after(() => { env.DEMO_LOGIN_ENABLED = previouslyEnabled; });
  const client = await createTestClient();
  t.after(() => client.close());
  const user = new User({ _id: DEMO_LOGIN_USER_ID, name: 'Demo Customer', role: 'customer', status: 'active', demoAccount: true, passwordHash: 'synthetic-hash' });
  t.mock.method(User, 'findById', async () => user);
  const authorization = `Bearer ${signAccessToken(user)}`;
  for (const [method, path] of [
    ['PATCH', '/users/me'],
    ['POST', '/users/me/addresses'],
    ['POST', '/addresses'],
    ['POST', '/orders'],
    ['POST', '/payments/razorpay/order'],
    ['POST', '/support-tickets'],
  ]) {
    const { response, body } = await client.request(`/api/v1${path}`, { method, headers: { authorization }, body: '{}' });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(body.code, 'DEMO_READ_ONLY', `${method} ${path}`);
  }
});

test('turning off the demo switch invalidates existing demo access sessions', (t) => {
  const previouslyEnabled = env.DEMO_LOGIN_ENABLED;
  t.after(() => { env.DEMO_LOGIN_ENABLED = previouslyEnabled; });
  const user = { role: 'customer', status: 'active', demoAccount: true, tokenVersion: 0 };
  const token = { tokenVersion: 0 };
  env.DEMO_LOGIN_ENABLED = true;
  assert.equal(userSessionIsCurrent(user, token, 'customer'), true);
  env.DEMO_LOGIN_ENABLED = false;
  assert.equal(userSessionIsCurrent(user, token, 'customer'), false);
  assert.equal(userSessionIsCurrent({ ...user, demoAccount: false }, token, 'customer'), true);
});
