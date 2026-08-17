import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const CALLBACK_READINESS_CHECKS = Object.freeze([
  'metaOriginatedReachability',
  'verificationChallenge',
  'messageEventSubscription',
  'validSignedCorrelatedStatus',
  'invalidSignatureRejectedWithoutMutation',
]);

export const CALLBACK_EVIDENCE_MAX_VALIDITY_MS = 10 * 60 * 1000;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_PHONE_PATTERN = /^\+91[6-9][0-9]{9}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALLBACK_PATH_PATTERN = /^\/api\/v[0-9]+\/webhooks\/whatsapp$/;
const ROOT_FIELDS = new Set([
  'version',
  'producerId',
  'environment',
  'deploymentId',
  'callbackUrl',
  'runId',
  'issuedAt',
  'expiresAt',
  'allowlistedTestNumberConfirmed',
  'checks',
  'signature',
]);

const CHECK_FIELDS = Object.freeze({
  metaOriginatedReachability: new Set(['passed', 'timestamp', 'origin']),
  verificationChallenge: new Set(['passed', 'timestamp', 'challengeReturned']),
  messageEventSubscription: new Set(['passed', 'timestamp', 'field', 'source']),
  validSignedCorrelatedStatus: new Set([
    'passed', 'timestamp', 'requestId', 'signatureScope',
  ]),
  invalidSignatureRejectedWithoutMutation: new Set([
    'passed', 'timestamp', 'httpStatus', 'stateChanged',
  ]),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyFields(value, allowedFields) {
  return Object.keys(value).every((field) => allowedFields.has(field));
}

function invalidEvidence() {
  return new TypeError('WhatsApp callback readiness evidence is invalid');
}

function isoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null;
}

function isPublicHttpsCallbackUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const privateIpv4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(hostname);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && hostname !== 'localhost'
      && hostname !== '[::1]'
      && !privateIpv4
      && CALLBACK_PATH_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

function requiredIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? value : null;
}

function readinessEvidencePublicKey(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const der = Buffer.from(value, 'base64');
    if (der.length === 0 || der.toString('base64') !== value) return null;
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

export function canonicalSerialize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`
    )).join(',')}}`;
  }
  throw new TypeError('Value cannot be canonically serialized');
}

function unsignedEvidence(evidence) {
  const unsigned = { ...evidence };
  delete unsigned.signature;
  return unsigned;
}

function signatureMatches(unsigned, signature, publicKey) {
  if (typeof signature !== 'string') return false;
  try {
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.length === 0 || signatureBytes.toString('base64') !== signature) return false;
    return crypto.verify(
      null,
      Buffer.from(canonicalSerialize(unsigned), 'utf8'),
      publicKey,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

export function parseReadinessConfiguration(source = process.env) {
  const environment = requiredIdentifier(source.WHATSAPP_CALLBACK_ENVIRONMENT);
  const deploymentId = requiredIdentifier(source.WHATSAPP_CALLBACK_DEPLOYMENT_ID);
  const callbackUrl = source.WHATSAPP_PUBLIC_CALLBACK_URL;
  const allowlistedTestNumber = source.WHATSAPP_SMOKE_TEST_ALLOWLISTED_PHONE;
  const runId = source.WHATSAPP_CALLBACK_READINESS_RUN_ID;
  const producerId = requiredIdentifier(source.WHATSAPP_CALLBACK_EVIDENCE_PRODUCER_ID);
  const evidencePublicKey = readinessEvidencePublicKey(
    source.WHATSAPP_CALLBACK_EVIDENCE_PUBLIC_KEY,
  );
  const replayDirectory = source.WHATSAPP_CALLBACK_EVIDENCE_REPLAY_DIRECTORY
    || '.whatsapp-callback-readiness-runs';

  if (!environment
    || !deploymentId
    || !isPublicHttpsCallbackUrl(callbackUrl)
    || !CANONICAL_PHONE_PATTERN.test(allowlistedTestNumber || '')
    || !RUN_ID_PATTERN.test(runId || '')
    || !producerId
    || !evidencePublicKey
    || typeof replayDirectory !== 'string'
    || replayDirectory.length === 0) {
    throw new TypeError('WhatsApp callback readiness configuration is invalid');
  }

  return Object.freeze({
    environment,
    deploymentId,
    callbackUrl,
    runId,
    producerId,
    replayDirectory,
    verifyEvidenceSignature(unsigned, signature) {
      return signatureMatches(unsigned, signature, evidencePublicKey);
    },
  });
}

function normalizedCheck(checkName, value, window) {
  if (value === undefined) return Object.freeze({ passed: false, timestamp: null });
  if (!isPlainObject(value) || !hasOnlyFields(value, CHECK_FIELDS[checkName])) {
    throw invalidEvidence();
  }

  const timestamp = isoTimestamp(value.timestamp);
  const timestampMs = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  if (!timestamp
    || timestampMs < window.issuedAtMs
    || timestampMs > window.expiresAtMs
    || timestampMs > window.nowMs) {
    throw invalidEvidence();
  }

  let passed = value.passed === true;
  if (checkName === 'metaOriginatedReachability') {
    passed &&= value.origin === 'META';
  } else if (checkName === 'verificationChallenge') {
    passed &&= value.challengeReturned === true;
  } else if (checkName === 'messageEventSubscription') {
    passed &&= value.field === 'messages'
      && (value.source === 'META_DASHBOARD' || value.source === 'META_API');
  } else if (checkName === 'validSignedCorrelatedStatus') {
    passed &&= value.signatureScope === 'EXACT_RAW_BODY'
      && typeof value.requestId === 'string'
      && REQUEST_ID_PATTERN.test(value.requestId);
  } else if (checkName === 'invalidSignatureRejectedWithoutMutation') {
    passed &&= value.httpStatus === 401 && value.stateChanged === false;
  }

  return Object.freeze({ passed, timestamp });
}

export function parseCallbackReadinessEvidence(rawEvidence, configuration, currentTimeMs = Date.now()) {
  let evidence;
  try {
    evidence = typeof rawEvidence === 'string' ? JSON.parse(rawEvidence) : rawEvidence;
  } catch {
    throw invalidEvidence();
  }

  if (!isPlainObject(evidence)
    || !hasOnlyFields(evidence, ROOT_FIELDS)
    || Object.keys(evidence).length !== ROOT_FIELDS.size
    || !isPlainObject(evidence.checks)
    || !hasOnlyFields(evidence.checks, new Set(CALLBACK_READINESS_CHECKS))
    || !configuration.verifyEvidenceSignature(unsignedEvidence(evidence), evidence.signature)) {
    throw invalidEvidence();
  }

  const issuedAt = isoTimestamp(evidence.issuedAt);
  const expiresAt = isoTimestamp(evidence.expiresAt);
  const issuedAtMs = issuedAt ? new Date(issuedAt).getTime() : Number.NaN;
  const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  if (!Number.isSafeInteger(currentTimeMs)
    || evidence.version !== 1
    || evidence.producerId !== configuration.producerId
    || evidence.environment !== configuration.environment
    || evidence.deploymentId !== configuration.deploymentId
    || evidence.callbackUrl !== configuration.callbackUrl
    || evidence.runId !== configuration.runId
    || !RUN_ID_PATTERN.test(evidence.runId || '')
    || !issuedAt
    || !expiresAt
    || issuedAtMs > currentTimeMs
    || expiresAtMs <= currentTimeMs
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > CALLBACK_EVIDENCE_MAX_VALIDITY_MS) {
    throw invalidEvidence();
  }

  const allowlistConfirmed = evidence.allowlistedTestNumberConfirmed === true;
  const window = { issuedAtMs, expiresAtMs, nowMs: currentTimeMs };
  const checks = Object.fromEntries(CALLBACK_READINESS_CHECKS.map((checkName) => {
    const check = normalizedCheck(checkName, evidence.checks[checkName], window);
    return [checkName, Object.freeze({
      passed: check.passed && allowlistConfirmed,
      timestamp: check.timestamp,
    })];
  }));

  return Object.freeze({
    environment: configuration.environment,
    deploymentId: configuration.deploymentId,
    runId: configuration.runId,
    checks: Object.freeze(checks),
  });
}

export function evaluateCallbackReadiness(input) {
  const checks = Array.isArray(input)
    ? Object.fromEntries(CALLBACK_READINESS_CHECKS.map((checkName, index) => [
      checkName,
      input.length === CALLBACK_READINESS_CHECKS.length && input[index] === true,
    ]))
    : Object.fromEntries(CALLBACK_READINESS_CHECKS.map((checkName) => [
      checkName,
      input?.checks?.[checkName]?.passed === true,
    ]));
  const failedChecks = CALLBACK_READINESS_CHECKS.filter((checkName) => !checks[checkName]);
  return Object.freeze({
    ready: failedChecks.length === 0,
    checks: Object.freeze(checks),
    failedChecks: Object.freeze(failedChecks),
  });
}

export async function claimCallbackEvidenceRun(configuration, evidence) {
  await mkdir(configuration.replayDirectory, { recursive: true });
  const markerName = `${configuration.environment}-${configuration.deploymentId}-${evidence.runId}.used`;
  const markerPath = path.join(configuration.replayDirectory, markerName);
  const fingerprint = crypto.createHash('sha256')
    .update(`${configuration.callbackUrl}:${evidence.runId}`)
    .digest('hex');
  try {
    await writeFile(markerPath, `${fingerprint}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw invalidEvidence();
    throw error;
  }
}

function evidencePathFrom(argv, environment) {
  if (argv.length === 2 && argv[0] === '--evidence' && argv[1]) return argv[1];
  if (argv.length === 0 && environment.WHATSAPP_CALLBACK_EVIDENCE_FILE) {
    return environment.WHATSAPP_CALLBACK_EVIDENCE_FILE;
  }
  throw new TypeError('WhatsApp callback readiness evidence file is required');
}

function safeIdentifier(value) {
  return requiredIdentifier(value) || 'UNAVAILABLE';
}

function safeRunId(value) {
  return RUN_ID_PATTERN.test(value || '') ? value : 'UNAVAILABLE';
}

function writeResult(stream, result) {
  stream.write(`${JSON.stringify(result)}\n`);
}

export async function runCallbackReadinessCommand({
  argv = process.argv.slice(2),
  environment = process.env,
  readFileImpl = readFile,
  claimRunImpl = claimCallbackEvidenceRun,
  now = Date.now,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const fallbackIdentifiers = {
    environment: safeIdentifier(environment.WHATSAPP_CALLBACK_ENVIRONMENT),
    deploymentId: safeIdentifier(environment.WHATSAPP_CALLBACK_DEPLOYMENT_ID),
    runId: safeRunId(environment.WHATSAPP_CALLBACK_READINESS_RUN_ID),
  };

  try {
    const configuration = parseReadinessConfiguration(environment);
    const evidencePath = evidencePathFrom(argv, environment);
    const rawEvidence = await readFileImpl(evidencePath, 'utf8');
    const evidence = parseCallbackReadinessEvidence(rawEvidence, configuration, now());
    await claimRunImpl(configuration, evidence);
    const result = evaluateCallbackReadiness(evidence);

    if (!result.ready) {
      writeResult(stderr, {
        ready: false,
        environment: configuration.environment,
        deploymentId: configuration.deploymentId,
        runId: configuration.runId,
        failedChecks: result.failedChecks,
      });
      return 1;
    }

    writeResult(stdout, {
      ready: true,
      environment: configuration.environment,
      deploymentId: configuration.deploymentId,
      runId: configuration.runId,
      checks: Object.fromEntries(CALLBACK_READINESS_CHECKS.map((checkName) => [
        checkName,
        evidence.checks[checkName].timestamp,
      ])),
    });
    return 0;
  } catch {
    writeResult(stderr, {
      ready: false,
      ...fallbackIdentifiers,
      failedChecks: CALLBACK_READINESS_CHECKS,
    });
    return 1;
  }
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  process.exitCode = await runCallbackReadinessCommand();
}
