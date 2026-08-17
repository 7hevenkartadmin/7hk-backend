import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { validate } from '../src/shared/validation/validate.js';
import { requestOtpSchema, verifyOtpSchema } from '../src/modules/auth/auth.validation.js';
import { normalizeIndianMobile } from '../src/modules/auth/phone.js';
import {
  requestOtpWithDependencies,
  resendOtpWithDependencies,
  verifyOtpWithDependencies,
} from '../src/modules/auth/auth.service.js';

const supportedPhones = [
  ['6123456789', '+916123456789'],
  ['9876543210', '+919876543210'],
  ['+917654321098', '+917654321098'],
];

const unsupportedPhones = [
  '',
  '5123456789',
  '09876543210',
  'abc9876543210',
  '+449876543210',
  '+91 9876543210',
  '98765-43210',
  ' 9876543210 ',
  '９876543210',
  9876543210,
  null,
  undefined,
];

const malformedOtps = [
  '', '12345', '1234567', '12A456', '12345!', '１２3456', ' 123456', 123456, null, undefined,
];

const subscriberArbitrary = fc.tuple(
  fc.constantFrom('6', '7', '8', '9'),
  fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 9, maxLength: 9 }),
).map(([first, rest]) => `${first}${rest.join('')}`);

const aliasedInvalidPhoneArbitrary = fc.tuple(
  fc.constantFrom('abc', '0', '+44', 'x-', ' '),
  subscriberArbitrary,
).map(([prefix, subscriber]) => `${prefix}${subscriber}`);

const malformedSixCharacterOtpArbitrary = fc.tuple(
  fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 6, maxLength: 6 }),
  fc.integer({ min: 0, max: 5 }),
  fc.constantFrom('A', '!', ' ', '９'),
).map(([digits, invalidIndex, invalidCharacter]) => {
  const characters = digits.map(String);
  characters[invalidIndex] = invalidCharacter;
  return characters.join('');
});

test('normalizeIndianMobile accepts only exact supported forms and returns one canonical identity', () => {
  for (const [input, expected] of supportedPhones) {
    assert.equal(normalizeIndianMobile(input), expected);
  }

  for (const input of unsupportedPhones) {
    assert.throws(() => normalizeIndianMobile(input), RangeError);
  }
});

test('request and verification schemas share the strict Indian phone grammar', () => {
  for (const [phone] of supportedPhones) {
    assert.equal(requestOtpSchema.safeParse({ phone }).success, true);
    assert.equal(verifyOtpSchema.safeParse({ phone, otp: '012345' }).success, true);
  }

  for (const phone of unsupportedPhones) {
    assert.equal(requestOtpSchema.safeParse({ phone }).success, false);
    assert.equal(verifyOtpSchema.safeParse({ phone, otp: '012345' }).success, false);
  }
});

test('verification schema accepts exactly six ASCII decimal digits', () => {
  for (const otp of ['000000', '012345', '999999']) {
    assert.equal(verifyOtpSchema.safeParse({ phone: '9876543210', otp }).success, true);
  }

  for (const otp of malformedOtps) {
    assert.equal(verifyOtpSchema.safeParse({ phone: '9876543210', otp }).success, false);
  }
});

test('route validation stops malformed phone and OTP bodies before the downstream handler', () => {
  const cases = [
    [requestOtpSchema, { phone: 'abc9876543210' }],
    [verifyOtpSchema, { phone: '9876543210', otp: '12A456' }],
  ];

  for (const [schema, body] of cases) {
    let downstreamCalls = 0;
    let validationError;
    validate(schema)({ body }, {}, (error) => {
      validationError = error;
      if (!error) downstreamCalls += 1;
    });
    assert.equal(validationError?.code, 'VALIDATION_ERROR');
    assert.equal(downstreamCalls, 0);
  }
});

test('service boundaries reject malformed credentials before OTP infrastructure initialization', async () => {
  let infrastructureAccesses = 0;
  const getOtpService = () => {
    infrastructureAccesses += 1;
    throw new Error('OTP infrastructure must not be initialized');
  };

  await assert.rejects(
    requestOtpWithDependencies('abc9876543210', 'synthetic-request-id', { getOtpService }),
    (error) => error.code === 'INVALID_PHONE' && error.statusCode === 422,
  );
  await assert.rejects(
    resendOtpWithDependencies('+449876543210', 'synthetic-request-id', { getOtpService }),
    (error) => error.code === 'INVALID_PHONE' && error.statusCode === 422,
  );
  await assert.rejects(
    verifyOtpWithDependencies(
      { phone: '9876543210', otp: '12A456' },
      { getOtpService },
    ),
    (error) => error.code === 'INVALID_OTP' && error.statusCode === 422,
  );
  await assert.rejects(
    verifyOtpWithDependencies(
      { phone: '9876543210', otp: 123456 },
      { getOtpService },
    ),
    (error) => error.code === 'INVALID_OTP' && error.statusCode === 422,
  );
  assert.equal(infrastructureAccesses, 0);
});

// **Validates: Requirements 1.4, 1.5, 2.4, 2.5**
test('Property 3.2: supported phone forms share one identity and malformed partitions fail route validation', () => {
  fc.assert(fc.property(
    subscriberArbitrary,
    aliasedInvalidPhoneArbitrary,
    malformedSixCharacterOtpArbitrary,
    (subscriber, invalidPhone, invalidOtp) => {
      const canonical = `+91${subscriber}`;
      assert.equal(normalizeIndianMobile(subscriber), canonical);
      assert.equal(normalizeIndianMobile(canonical), canonical);
      assert.equal(requestOtpSchema.safeParse({ phone: invalidPhone }).success, false);
      assert.equal(verifyOtpSchema.safeParse({ phone: canonical, otp: invalidOtp }).success, false);

      for (const [schema, body] of [
        [requestOtpSchema, { phone: invalidPhone }],
        [verifyOtpSchema, { phone: canonical, otp: invalidOtp }],
      ]) {
        let downstreamCalls = 0;
        validate(schema)({ body }, {}, (error) => {
          assert.equal(error?.code, 'VALIDATION_ERROR');
          if (!error) downstreamCalls += 1;
        });
        assert.equal(downstreamCalls, 0);
      }
    },
  ), { seed: 20260607, numRuns: 100 });
});

// **Validates: Requirements 2.4, 2.5, 3.11**
test('Property 3.2: rejected credentials cause zero OTP service, challenge, attempt, or queue access', async () => {
  await fc.assert(fc.asyncProperty(
    aliasedInvalidPhoneArbitrary,
    malformedSixCharacterOtpArbitrary,
    async (invalidPhone, invalidOtp) => {
      let infrastructureAccesses = 0;
      const getOtpService = () => {
        infrastructureAccesses += 1;
        throw new Error('OTP infrastructure must not be initialized');
      };

      await assert.rejects(
        requestOtpWithDependencies(invalidPhone, 'property-request-id', { getOtpService }),
        (error) => error.code === 'INVALID_PHONE',
      );
      await assert.rejects(
        resendOtpWithDependencies(invalidPhone, 'property-request-id', { getOtpService }),
        (error) => error.code === 'INVALID_PHONE',
      );
      await assert.rejects(
        verifyOtpWithDependencies(
          { phone: '9876543210', otp: invalidOtp },
          { getOtpService },
        ),
        (error) => error.code === 'INVALID_OTP',
      );
      assert.equal(infrastructureAccesses, 0);
    },
  ), { seed: 20260607, numRuns: 100 });
});
