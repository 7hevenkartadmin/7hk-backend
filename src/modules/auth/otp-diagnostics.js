const EVENT_TYPES = new Set([
  'ACCEPTED',
  'PERMANENTLY_REJECTED',
  'PERSISTENCE_FAILED',
  'SIGNED_WEBHOOK_STATUS',
]);

const INPUT_FIELDS = new Set([
  'eventType',
  'requestId',
  'timestamp',
  'providerCode',
  'deliveryState',
]);

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const DELIVERY_STATES = new Set(['SENT', 'DELIVERED', 'READ', 'FAILED']);
const FALLBACK_PROVIDER_CODE = 'UNKNOWN_PROVIDER_CODE';

export const OTP_DIAGNOSTIC_EVENT = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  PERMANENTLY_REJECTED: 'PERMANENTLY_REJECTED',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',
  SIGNED_WEBHOOK_STATUS: 'SIGNED_WEBHOOK_STATUS',
});

export function sanitizeProviderCode(providerCode) {
  return typeof providerCode === 'string' && PROVIDER_CODE_PATTERN.test(providerCode)
    ? providerCode
    : FALLBACK_PROVIDER_CODE;
}

function diagnosticTimestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Diagnostic timestamp is invalid');
  return date.toISOString();
}

export function createOtpDiagnostic(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('OTP diagnostic input must be an object');
  }
  const unknownField = Object.keys(input).find((field) => !INPUT_FIELDS.has(field));
  if (unknownField) throw new TypeError('OTP diagnostic input contains an unsupported field');
  if (!EVENT_TYPES.has(input.eventType)) throw new TypeError('OTP diagnostic event type is invalid');
  if (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new TypeError('OTP diagnostic request ID is invalid');
  }

  const diagnostic = {
    eventType: input.eventType,
    requestId: input.requestId,
    timestamp: diagnosticTimestamp(input.timestamp),
  };

  if (input.eventType === OTP_DIAGNOSTIC_EVENT.PERMANENTLY_REJECTED) {
    diagnostic.providerCode = sanitizeProviderCode(input.providerCode);
  }
  if (input.eventType === OTP_DIAGNOSTIC_EVENT.SIGNED_WEBHOOK_STATUS) {
    const deliveryState = typeof input.deliveryState === 'string'
      ? input.deliveryState.toUpperCase()
      : '';
    if (!DELIVERY_STATES.has(deliveryState)) {
      throw new TypeError('OTP diagnostic delivery state is invalid');
    }
    diagnostic.deliveryState = deliveryState;
  }

  return diagnostic;
}

function writeOtpDiagnostic(diagnostic) {
  console.info(JSON.stringify(diagnostic));
}

export function emitOtpDiagnostic(input, sink = writeOtpDiagnostic) {
  const diagnostic = createOtpDiagnostic(input);
  try {
    sink(diagnostic);
  } catch {
    // Diagnostic output must not alter OTP delivery or callback state transitions.
  }
  return diagnostic;
}
