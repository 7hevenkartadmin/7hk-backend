import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import {
  CALLBACK_EVIDENCE_MAX_VALIDITY_MS,
  CALLBACK_READINESS_CHECKS,
  canonicalSerialize,
  claimCallbackEvidenceRun,
  evaluateCallbackReadiness,
  parseCallbackReadinessEvidence,
  parseReadinessConfiguration,
  runCallbackReadinessCommand,
} from '../scripts/verify-whatsapp-callback-readiness.js';

const root = new URL('../', import.meta.url);
const issuedAt = '2026-06-07T12:00:00.000Z';
const timestamp = '2026-06-07T12:01:00.000Z';
const expiresAt = '2026-06-07T12:10:00.000Z';
const nowMs = new Date('2026-06-07T12:05:00.000Z').getTime();
const requestId = '00000000-0000-4000-8000-000000000001';
const runId = '10000000-0000-4000-8000-000000000001';
const phoneCanary = '+919876543210';
const producerId = 'trusted-deployment-collector';
const { privateKey: evidencePrivateKey, publicKey: evidencePublicKey } = crypto.generateKeyPairSync('ed25519');
const evidencePublicKeyBase64 = evidencePublicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const readinessEnvironment = Object.freeze({
  WHATSAPP_CALLBACK_ENVIRONMENT: 'production',
  WHATSAPP_CALLBACK_DEPLOYMENT_ID: 'release-2026-06-07',
  WHATSAPP_PUBLIC_CALLBACK_URL: 'https://api.example.com/api/v1/webhooks/whatsapp',
  WHATSAPP_SMOKE_TEST_ALLOWLISTED_PHONE: phoneCanary,
  WHATSAPP_CALLBACK_READINESS_RUN_ID: runId,
  WHATSAPP_CALLBACK_EVIDENCE_PRODUCER_ID: producerId,
  WHATSAPP_CALLBACK_EVIDENCE_PUBLIC_KEY: evidencePublicKeyBase64,
  WHATSAPP_CALLBACK_EVIDENCE_REPLAY_DIRECTORY: 'synthetic-replay-directory',
});

function evidenceInput() {
  return {
    producerId,
    environment: 'production',
    deploymentId: 'release-2026-06-07',
    callbackUrl: 'https://api.example.com/api/v1/webhooks/whatsapp',
    runId,
    issuedAt,
    expiresAt,
    allowlistedTestNumberConfirmed: true,
    checks: {
      metaOriginatedReachability: { passed: true, timestamp, origin: 'META' },
      verificationChallenge: { passed: true, timestamp, challengeReturned: true },
      messageEventSubscription: {
        passed: true,
        timestamp,
        field: 'messages',
        source: 'META_DASHBOARD',
      },
      validSignedCorrelatedStatus: {
        passed: true,
        timestamp,
        requestId,
        signatureScope: 'EXACT_RAW_BODY',
      },
      invalidSignatureRejectedWithoutMutation: {
        passed: true,
        timestamp,
        httpStatus: 401,
        stateChanged: false,
      },
    },
  };
}

function completeEvidence(mutator = () => {}, privateKey = evidencePrivateKey) {
  const input = evidenceInput();
  mutator(input);
  const unsigned = {
    version: 1,
    ...input,
    allowlistedTestNumberConfirmed: input.allowlistedTestNumberConfirmed === true,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(canonicalSerialize(unsigned), 'utf8'),
    privateKey,
  ).toString('base64');
  return Object.freeze({ ...unsigned, signature });
}

function captureStream() {
  let output = '';
  return {
    stream: { write(value) { output += value; } },
    output: () => output,
  };
}

test('WhatsApp OTP documentation matches timing, authenticated evidence, and callback contracts', async () => {
  const documentation = await readFile(new URL('docs/whatsapp-login-otp.md', root), 'utf8');
  assert.match(documentation, /response `data` contains only\s+`expiresInSeconds` and `resendAfterSeconds`/);
  assert.doesNotMatch(documentation, /opaque token/i);
  assert.match(documentation, /exact public HTTPS callback URL from\s+`WHATSAPP_PUBLIC_CALLBACK_URL`/);
  assert.match(documentation, /GET verification challenge/);
  assert.match(documentation, /`messages` webhook field/);
  assert.match(documentation, /exact raw request bytes/);
  assert.match(documentation, /exactly one operator-approved, allow-listed test number/);
  assert.match(documentation, /unique UUID `WHATSAPP_CALLBACK_READINESS_RUN_ID`/);
  assert.match(documentation, /trusted deployment collector/);
  assert.match(documentation, /`WHATSAPP_CALLBACK_EVIDENCE_PUBLIC_KEY`/);
  assert.match(documentation, /private signing key\s+must not be available to the gate or operator process/i);
  assert.match(documentation, /signed\s+evidence is valid for at most ten minutes/i);
  assert.match(documentation, /Production login completion requires a transaction-capable MongoDB deployment/);
  assert.match(documentation, /REQUIRE_INTEGRATION_FIXTURES=true/);
});

test('checked-in Meta authentication template matches documented environment defaults', async () => {
  const [templateText, environmentExample] = await Promise.all([
    readFile(new URL('docs/meta-whatsapp-auth-template.json', root), 'utf8'),
    readFile(new URL('.env.example', root), 'utf8'),
  ]);
  const template = JSON.parse(templateText);
  const setting = (name) => environmentExample.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];

  assert.equal(template.name, setting('META_WHATSAPP_TEMPLATE_NAME'));
  assert.equal(template.language, setting('META_WHATSAPP_TEMPLATE_LANGUAGE'));
  assert.equal(template.category, 'AUTHENTICATION');
  assert.equal(template.components.find((component) => component.type === 'BUTTONS')
    ?.buttons?.[0]?.otp_type, 'COPY_CODE');
  assert.equal(setting('WHATSAPP_CALLBACK_EVIDENCE_PRODUCER_ID'), '');
  assert.equal(setting('WHATSAPP_CALLBACK_EVIDENCE_PUBLIC_KEY'), '');
});

test('callback readiness truth table is closed for 31 incomplete combinations', () => {
  for (let mask = 0; mask < 32; mask += 1) {
    const checks = CALLBACK_READINESS_CHECKS.map((_, index) => Boolean(mask & (1 << index)));
    const result = evaluateCallbackReadiness(checks);
    assert.equal(result.ready, mask === 31, `mask=${mask}`);
    assert.deepEqual(result.failedChecks, CALLBACK_READINESS_CHECKS.filter((_, index) => !checks[index]));
  }
});

// **Validates: Requirements 2.10**
test('Property: readiness equals the conjunction of exactly five evidence checks', () => {
  fc.assert(fc.property(
    fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
    (checks) => {
      const result = evaluateCallbackReadiness(checks);
      assert.equal(result.ready, checks.every(Boolean));
      assert.equal(Object.keys(result.checks).length, 5);
    },
  ), { seed: 20260607, numRuns: 100 });
});

test('canonical serialization is stable across object insertion order', () => {
  assert.equal(
    canonicalSerialize({ z: 1, a: { y: true, b: 'value' } }),
    canonicalSerialize({ a: { b: 'value', y: true }, z: 1 }),
  );
});

test('signed evidence parsing accepts fresh bound facts without retaining key or phone', () => {
  const configuration = parseReadinessConfiguration(readinessEnvironment);
  const raw = JSON.stringify(completeEvidence());
  const evidence = parseCallbackReadinessEvidence(raw, configuration, nowMs);
  assert.equal(evaluateCallbackReadiness(evidence).ready, true);
  assert.equal(raw.includes(phoneCanary), false);
  assert.equal(raw.includes(evidencePublicKeyBase64), false);
  assert.equal(JSON.stringify(configuration).includes(evidencePublicKeyBase64), false);
});

test('unsigned, tampered, stale, future, overlong, and incorrectly bound evidence is rejected', () => {
  const configuration = parseReadinessConfiguration(readinessEnvironment);
  const unsigned = { ...evidenceInput(), signature: undefined };
  const tampered = structuredClone(completeEvidence());
  tampered.checks.messageEventSubscription.source = 'META_API';
  const stale = completeEvidence((input) => {
    input.issuedAt = '2026-06-07T11:40:00.000Z';
    input.expiresAt = '2026-06-07T11:50:00.000Z';
    Object.values(input.checks).forEach((check) => { check.timestamp = '2026-06-07T11:45:00.000Z'; });
  });
  const future = completeEvidence((input) => {
    input.issuedAt = '2026-06-07T12:06:00.000Z';
    input.expiresAt = '2026-06-07T12:10:00.000Z';
    Object.values(input.checks).forEach((check) => { check.timestamp = '2026-06-07T12:07:00.000Z'; });
  });
  const overlong = completeEvidence((input) => {
    input.expiresAt = new Date(new Date(input.issuedAt).getTime()
      + CALLBACK_EVIDENCE_MAX_VALIDITY_MS + 1000).toISOString();
  });
  const wrongRun = completeEvidence((input) => { input.runId = crypto.randomUUID(); });
  const wrongProducer = completeEvidence((input) => { input.producerId = 'untrusted-collector'; });
  const { privateKey: untrustedPrivateKey } = crypto.generateKeyPairSync('ed25519');
  const untrustedSignature = completeEvidence(() => {}, untrustedPrivateKey);

  for (const evidence of [
    unsigned,
    tampered,
    stale,
    future,
    overlong,
    wrongRun,
    wrongProducer,
    untrustedSignature,
  ]) {
    assert.throws(
      () => parseCallbackReadinessEvidence(evidence, configuration, nowMs),
      /readiness evidence is invalid/,
    );
  }
});

test('check timestamps must be inside the signed run window', () => {
  const configuration = parseReadinessConfiguration(readinessEnvironment);
  const evidence = completeEvidence((input) => {
    input.checks.verificationChallenge.timestamp = '2026-06-07T11:59:59.000Z';
  });
  assert.throws(() => parseCallbackReadinessEvidence(evidence, configuration, nowMs));
});

test('invalid-signature fact passes only for HTTP 401 with no state mutation', () => {
  const configuration = parseReadinessConfiguration(readinessEnvironment);
  for (const invalidFact of [
    { httpStatus: 200, stateChanged: false },
    { httpStatus: 401, stateChanged: true },
  ]) {
    const evidence = completeEvidence((input) => {
      Object.assign(input.checks.invalidSignatureRejectedWithoutMutation, invalidFact);
    });
    const parsed = parseCallbackReadinessEvidence(evidence, configuration, nowMs);
    assert.deepEqual(evaluateCallbackReadiness(parsed).failedChecks, [
      'invalidSignatureRejectedWithoutMutation',
    ]);
  }
});

test('readiness command fails closed with only sanitized failed-check output', async () => {
  const evidence = completeEvidence((input) => {
    input.checks.messageEventSubscription.passed = false;
  });
  const stdout = captureStream();
  const stderr = captureStream();
  let claims = 0;

  const exitCode = await runCallbackReadinessCommand({
    argv: ['--evidence', 'synthetic-evidence.json'],
    environment: readinessEnvironment,
    readFileImpl: async () => JSON.stringify(evidence),
    claimRunImpl: async () => { claims += 1; },
    now: () => nowMs,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 1);
  assert.equal(claims, 1);
  assert.equal(stdout.output(), '');
  assert.deepEqual(JSON.parse(stderr.output()), {
    ready: false,
    environment: 'production',
    deploymentId: 'release-2026-06-07',
    runId,
    failedChecks: ['messageEventSubscription'],
  });
  assert.equal(stderr.output().includes(phoneCanary), false);
  assert.equal(stderr.output().includes(requestId), false);
  assert.equal(stderr.output().includes(evidencePublicKeyBase64), false);
  assert.equal(stderr.output().includes('api.example.com'), false);
});

test('readiness command rejects target-number arguments and performs no evidence read', async () => {
  const stderr = captureStream();
  let readCount = 0;
  const exitCode = await runCallbackReadinessCommand({
    argv: ['--phone', phoneCanary],
    environment: readinessEnvironment,
    readFileImpl: async () => { readCount += 1; return JSON.stringify(completeEvidence()); },
    claimRunImpl: async () => assert.fail('invalid arguments cannot claim a run'),
    now: () => nowMs,
    stdout: captureStream().stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 1);
  assert.equal(readCount, 0);
  assert.equal(stderr.output().includes(phoneCanary), false);
  assert.deepEqual(JSON.parse(stderr.output()).failedChecks, CALLBACK_READINESS_CHECKS);
});

test('filesystem replay claim is atomic under a concurrent race', async (t) => {
  const replayDirectory = await mkdtemp(path.join(tmpdir(), 'whatsapp-readiness-race-'));
  t.after(() => rm(replayDirectory, { recursive: true, force: true }));
  const configuration = parseReadinessConfiguration({
    ...readinessEnvironment,
    WHATSAPP_CALLBACK_EVIDENCE_REPLAY_DIRECTORY: replayDirectory,
  });
  const evidence = parseCallbackReadinessEvidence(
    JSON.stringify(completeEvidence()),
    configuration,
    nowMs,
  );

  const attempts = await Promise.allSettled(
    Array.from({ length: 16 }, () => claimCallbackEvidenceRun(configuration, evidence)),
  );
  const accepted = attempts.filter(({ status }) => status === 'fulfilled');
  const rejected = attempts.filter(({ status }) => status === 'rejected');

  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 15);
  rejected.forEach(({ reason }) => {
    assert.match(reason.message, /readiness evidence is invalid/);
  });

  const markerNames = await readdir(replayDirectory);
  assert.deepEqual(markerNames, [`production-release-2026-06-07-${runId}.used`]);
  const marker = await readFile(path.join(replayDirectory, markerNames[0]), 'utf8');
  assert.match(marker, /^[0-9a-f]{64}\n$/);
  assert.equal(marker.includes(phoneCanary), false);
  assert.equal(marker.includes(evidencePublicKeyBase64), false);
  assert.equal(marker.includes(requestId), false);
});

test('readiness command accepts a fresh signed run once and rejects its replay', async (t) => {
  const replayDirectory = await mkdtemp(path.join(tmpdir(), 'whatsapp-readiness-'));
  t.after(() => rm(replayDirectory, { recursive: true, force: true }));
  const environment = { ...readinessEnvironment, WHATSAPP_CALLBACK_EVIDENCE_REPLAY_DIRECTORY: replayDirectory };
  const execute = async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const exitCode = await runCallbackReadinessCommand({
      argv: ['--evidence', 'synthetic-evidence.json'],
      environment,
      readFileImpl: async () => JSON.stringify(completeEvidence()),
      now: () => nowMs,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    return { exitCode, stdout: stdout.output(), stderr: stderr.output() };
  };

  const first = await execute();
  assert.equal(first.exitCode, 0);
  assert.equal(first.stderr, '');
  const result = JSON.parse(first.stdout);
  assert.equal(result.ready, true);
  assert.equal(result.runId, runId);
  assert.deepEqual(Object.keys(result.checks), CALLBACK_READINESS_CHECKS);
  assert.equal(first.stdout.includes(phoneCanary), false);
  assert.equal(first.stdout.includes(requestId), false);
  assert.equal(first.stdout.includes(evidencePublicKeyBase64), false);

  const replay = await execute();
  assert.equal(replay.exitCode, 1);
  assert.equal(replay.stdout, '');
  assert.deepEqual(JSON.parse(replay.stderr).failedChecks, CALLBACK_READINESS_CHECKS);
});
