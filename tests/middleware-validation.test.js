import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validate } from '../src/shared/validation/validate.js';

test('validation middleware replaces request source with parsed data', () => {
  const schema = z.object({
    limit: z.coerce.number().int().positive().default(20),
    includeInactive: z.coerce.boolean().default(false),
  });
  const req = { query: { limit: '50', includeInactive: 'true' } };
  let nextError = null;

  validate(schema, 'query')(req, {}, (error) => {
    nextError = error || null;
  });

  assert.equal(nextError, null);
  assert.deepEqual(req.query, { limit: 50, includeInactive: true });
});

test('validation middleware forwards AppError with flattened zod details', () => {
  const schema = z.object({ phone: z.string().min(10) });
  const req = { body: { phone: '123' } };
  let nextError = null;

  validate(schema)(req, {}, (error) => {
    nextError = error;
  });

  assert.equal(nextError.statusCode, 422);
  assert.equal(nextError.code, 'VALIDATION_ERROR');
  assert.ok(nextError.details.fieldErrors.phone.length > 0);
});
