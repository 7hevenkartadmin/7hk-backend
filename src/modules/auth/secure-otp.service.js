import crypto from 'crypto';
import { AppError } from '../../shared/utils/AppError.js';
import { OTP_DELIVERY_STATUS } from './otp.constants.js';
import { emitOtpDiagnostic, OTP_DIAGNOSTIC_EVENT } from './otp-diagnostics.js';

const CONSUME_RATE_LIMIT_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return { count, redis.call('TTL', KEYS[1]) }
`;

const CREATE_CHALLENGE_SCRIPT = `
  local cooldownTtl = redis.call('TTL', KEYS[2])
  if cooldownTtl > 0 then return { 'COOLDOWN', cooldownTtl } end
  redis.call('HSET', KEYS[1],
    'otpId', ARGV[1], 'otpHash', ARGV[2], 'attempts', '0',
    'maxAttempts', ARGV[3], 'deliveryStatus', 'QUEUED',
    'deliveryUpdatedAt', ARGV[4])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[6])
  return { 'CREATED' }
`;

const CLEANUP_FAILED_ENQUEUE_SCRIPT = `
  if redis.call('HGET', KEYS[1], 'otpId') == ARGV[1] then
    redis.call('DEL', KEYS[1], KEYS[2])
    return 1
  end
  return 0
`;

const VERIFY_TO_PROOF_SCRIPT = `
  if redis.call('EXISTS', KEYS[1]) == 1 then
    local remainingTtl = redis.call('PTTL', KEYS[1])
    if remainingTtl <= 0 then
      redis.call('DEL', KEYS[1])
      return { 'NOT_FOUND' }
    end
    local storedHash = redis.call('HGET', KEYS[1], 'otpHash')
    local maxAttempts = tonumber(redis.call('HGET', KEYS[1], 'maxAttempts'))
    if storedHash ~= ARGV[1] then
      local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
      if attempts >= maxAttempts then
        redis.call('DEL', KEYS[1])
        return { 'BLOCKED' }
      end
      return { 'INVALID' }
    end
    redis.call('HSET', KEYS[2],
      'proofId', ARGV[2], 'otpHash', storedHash, 'state', 'VERIFIED')
    redis.call('PEXPIRE', KEYS[2], remainingTtl)
    redis.call('DEL', KEYS[1])
    return { 'VERIFIED', ARGV[2], remainingTtl }
  end

  if redis.call('EXISTS', KEYS[2]) == 0 then return { 'NOT_FOUND' } end
  local state = redis.call('HGET', KEYS[2], 'state')
  if state == 'DENIED' then return { 'NOT_FOUND' } end
  if redis.call('HGET', KEYS[2], 'otpHash') ~= ARGV[1] then return { 'INVALID' } end
  return {
    'VERIFIED',
    redis.call('HGET', KEYS[2], 'proofId'),
    redis.call('PTTL', KEYS[2])
  }
`;

const TRANSITION_VERIFIED_PROOF_SCRIPT = `
  if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
  if redis.call('HGET', KEYS[1], 'proofId') ~= ARGV[1] then return 0 end
  local current = redis.call('HGET', KEYS[1], 'state')
  local target = ARGV[2]
  if target == 'DENIED' then
    if current == 'DENIED' then return 1 end
    if current ~= 'VERIFIED' and current ~= 'COMPLETED' then return 0 end
    redis.call('HSET', KEYS[1], 'state', target)
    redis.call('HDEL', KEYS[1], 'otpHash')
    return 1
  elseif target == 'COMPLETED' then
    if current == 'DENIED' then return 0 end
    if current == 'COMPLETED' then return 1 end
    if current ~= 'VERIFIED' then return 0 end
  else
    return 0
  end
  redis.call('HSET', KEYS[1], 'state', target)
  return 1
`;

const RECORD_ACCEPTED_SCRIPT = `
  redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
  local pendingStatus = redis.call('GET', KEYS[3])
  local challengeMatches = redis.call('HGET', KEYS[1], 'otpId') == ARGV[1]
  if challengeMatches then
    if pendingStatus then
      redis.call('HSET', KEYS[1], 'deliveryStatus', pendingStatus, 'deliveryUpdatedAt', ARGV[4])
    else
      redis.call('HSET', KEYS[1], 'deliveryStatus', 'ACCEPTED', 'deliveryUpdatedAt', ARGV[4])
    end
  end
  if pendingStatus then redis.call('DEL', KEYS[3]) end
  return { 1, pendingStatus or '', challengeMatches and 1 or 0 }
`;

const UPDATE_STATUS_SCRIPT = `
  if redis.call('HGET', KEYS[1], 'otpId') ~= ARGV[1] then return 0 end
  local current = redis.call('HGET', KEYS[1], 'deliveryStatus') or 'QUEUED'
  local incoming = ARGV[2]
  local ranks = { QUEUED = 0, ACCEPTED = 1, SENT = 2, DELIVERED = 3, READ = 4 }
  if current == 'FAILED' then return 0 end
  if incoming == 'FAILED' then
    if current == 'DELIVERED' or current == 'READ' then return 0 end
    redis.call('HSET', KEYS[1], 'deliveryStatus', incoming, 'deliveryUpdatedAt', ARGV[3])
    return 1
  end
  if ranks[incoming] and ranks[incoming] > (ranks[current] or -1) then
    redis.call('HSET', KEYS[1], 'deliveryStatus', incoming, 'deliveryUpdatedAt', ARGV[3])
    return 1
  end
  return 0
`;

const RECORD_PENDING_STATUS_SCRIPT = `
  local current = redis.call('GET', KEYS[1])
  local incoming = ARGV[1]
  local ranks = { SENT = 2, DELIVERED = 3, READ = 4 }
  if current == 'FAILED' then return 0 end
  if incoming == 'FAILED' and (current == 'DELIVERED' or current == 'READ') then return 0 end
  if incoming == 'FAILED' or not current or (ranks[incoming] and ranks[incoming] > (ranks[current] or -1)) then
    redis.call('SET', KEYS[1], incoming, 'EX', ARGV[2])
    return 1
  end
  return 0
`;

const PUBLIC_PROVIDER_STATUSES = new Set(['SENT', 'DELIVERED', 'READ', 'FAILED']);

export class SecureOtpService {
  constructor({ redisClient, notificationQueue, tokenService, ttlSeconds = 300, maxAttempts = 5,
    requestLimit = 5, requestWindowSeconds = 60, resendCooldownSeconds = 30,
    correlationTtlSeconds = 24 * 60 * 60, diagnosticSink }) {
    this.redisClient = redisClient;
    this.notificationQueue = notificationQueue;
    this.tokenService = tokenService;
    this.ttlSeconds = ttlSeconds;
    this.maxAttempts = maxAttempts;
    this.requestLimit = requestLimit;
    this.requestWindowSeconds = requestWindowSeconds;
    this.resendCooldownSeconds = resendCooldownSeconds;
    this.correlationTtlSeconds = Math.max(correlationTtlSeconds, ttlSeconds * 2);
    this.diagnosticSink = diagnosticSink;
  }

  async requestOtp(payload) {
    const identity = this.#identity(payload);
    await this.#consumeRequestLimit(identity);
    const otp = this.tokenService.generate(6);
    const otpId = crypto.randomUUID();
    const challengeKey = this.#challengeKey(identity);
    const cooldownKey = this.#cooldownKey(identity);
    const created = await this.redisClient.eval(
      CREATE_CHALLENGE_SCRIPT, 2, challengeKey, cooldownKey,
      otpId, this.tokenService.hash(otp, identity), this.maxAttempts,
      Date.now(), this.ttlSeconds, this.resendCooldownSeconds,
    );
    if (created?.[0] === 'COOLDOWN') {
      throw new AppError('Please wait before requesting another OTP', 429, 'OTP_RESEND_COOLDOWN', {
        retryAfterSeconds: Math.max(Number(created[1]) || 0, 1),
      });
    }

    try {
      await this.notificationQueue.enqueueOtp({
        otpId, userId: identity, channel: payload.channel, recipient: payload.recipient,
        purpose: payload.purpose, requestId: payload.requestId, otp,
      });
    } catch (error) {
      await this.redisClient.eval(
        CLEANUP_FAILED_ENQUEUE_SCRIPT, 2, challengeKey, cooldownKey, otpId,
      );
      throw error;
    }

    return {
      expiresIn: this.ttlSeconds,
      resendAfterSeconds: this.resendCooldownSeconds,
    };
  }

  async resendOtp(payload) {
    return this.requestOtp(payload);
  }

  async verifyOtp(payload) {
    const identity = this.#identity(payload);
    const result = await this.redisClient.eval(
      VERIFY_TO_PROOF_SCRIPT, 2, this.#challengeKey(identity), this.#verifiedProofKey(identity),
      this.tokenService.hash(payload.otp, identity), crypto.randomUUID(),
    );
    if (result?.[0] !== 'VERIFIED' || !result[1]) {
      throw new AppError('Invalid or expired OTP', 401, 'OTP_INVALID');
    }
    return { status: 'OTP_VERIFIED', proofId: String(result[1]) };
  }

  async denyVerifiedProof(payload, proofId) {
    const identity = this.#identity(payload);
    return Number(await this.redisClient.eval(
      TRANSITION_VERIFIED_PROOF_SCRIPT,
      1,
      this.#verifiedProofKey(identity),
      proofId,
      'DENIED',
    )) === 1;
  }

  async markVerifiedProofCompleted(payload, proofId) {
    const identity = this.#identity(payload);
    return Number(await this.redisClient.eval(
      TRANSITION_VERIFIED_PROOF_SCRIPT,
      1,
      this.#verifiedProofKey(identity),
      proofId,
      'COMPLETED',
    )) === 1;
  }

  async recordDeliveryAccepted({ identity, otpId, providerMessageId, requestId }) {
    const challengeKey = this.#challengeKey(identity);
    const mapping = JSON.stringify({ challengeKey, otpId, requestId });
    let result;
    try {
      result = await this.redisClient.eval(
        RECORD_ACCEPTED_SCRIPT, 3, challengeKey, this.#messageKey(providerMessageId),
        this.#pendingStatusKey(providerMessageId), otpId, mapping,
        this.correlationTtlSeconds, Date.now(),
      );
    } catch (error) {
      this.#emit({ eventType: OTP_DIAGNOSTIC_EVENT.PERSISTENCE_FAILED, requestId });
      throw error;
    }

    this.#emit({ eventType: OTP_DIAGNOSTIC_EVENT.ACCEPTED, requestId });
    const reconciledStatus = String(result?.[1] || '').toUpperCase();
    if (PUBLIC_PROVIDER_STATUSES.has(reconciledStatus)) {
      this.#emit({
        eventType: OTP_DIAGNOSTIC_EVENT.SIGNED_WEBHOOK_STATUS,
        requestId,
        deliveryState: reconciledStatus,
      });
    }
    return Number(result?.[2]) === 1;
  }

  async recordDeliveryFailed({ identity, otpId, requestId, providerCode, permanent = false }) {
    if (permanent) {
      this.#emit({
        eventType: OTP_DIAGNOSTIC_EVENT.PERMANENTLY_REJECTED,
        requestId,
        providerCode,
      });
    }

    try {
      const updated = await this.redisClient.eval(
        UPDATE_STATUS_SCRIPT, 1, this.#challengeKey(identity), otpId,
        OTP_DELIVERY_STATUS.FAILED, Date.now(),
      );
      return Number(updated) === 1;
    } catch (error) {
      this.#emit({ eventType: OTP_DIAGNOSTIC_EVENT.PERSISTENCE_FAILED, requestId });
      throw error;
    }
  }

  async recordProviderStatus(providerMessageId, status) {
    const normalizedStatus = String(status || '').toUpperCase();
    if (!PUBLIC_PROVIDER_STATUSES.has(normalizedStatus)) return false;
    const mapping = await this.redisClient.get(this.#messageKey(providerMessageId));
    if (!mapping) {
      await this.redisClient.eval(
        RECORD_PENDING_STATUS_SCRIPT,
        1,
        this.#pendingStatusKey(providerMessageId),
        normalizedStatus,
        this.correlationTtlSeconds,
      );
      return false;
    }

    let correlation;
    try {
      correlation = JSON.parse(mapping);
    } catch {
      return false;
    }
    if (!correlation?.challengeKey || !correlation?.otpId || !correlation?.requestId) return false;

    try {
      const updated = await this.redisClient.eval(
        UPDATE_STATUS_SCRIPT, 1, correlation.challengeKey, correlation.otpId,
        normalizedStatus, Date.now(),
      );
      this.#emit({
        eventType: OTP_DIAGNOSTIC_EVENT.SIGNED_WEBHOOK_STATUS,
        requestId: correlation.requestId,
        deliveryState: normalizedStatus,
      });
      return Number(updated) === 1;
    } catch (error) {
      this.#emit({
        eventType: OTP_DIAGNOSTIC_EVENT.PERSISTENCE_FAILED,
        requestId: correlation.requestId,
      });
      throw error;
    }
  }

  async close() {
    await Promise.allSettled([this.notificationQueue.close(), this.redisClient.quit()]);
  }

  async #consumeRequestLimit(identity) {
    const [count] = await this.redisClient.eval(
      CONSUME_RATE_LIMIT_SCRIPT, 1, `otp:rate:${identity}:request`, this.requestWindowSeconds,
    );
    if (Number(count) > this.requestLimit) {
      throw new AppError('Too many OTP requests. Please try again later.', 429, 'OTP_RATE_LIMITED');
    }
  }

  #emit(input) {
    return emitOtpDiagnostic(input, this.diagnosticSink);
  }

  #identity(payload) {
    return this.tokenService.identity(`${payload.userId}:${payload.purpose}:${payload.recipient}`);
  }

  #challengeKey(identity) { return `otp:challenge:${identity}`; }
  #cooldownKey(identity) { return `otp:cooldown:${identity}`; }
  #verifiedProofKey(identity) { return `otp:verified:${identity}`; }
  #messageKey(messageId) {
    return `otp:message:${this.tokenService.identity(`meta-message:${messageId}`)}`;
  }
  #pendingStatusKey(messageId) {
    return `otp:message-status:${this.tokenService.identity(`meta-message:${messageId}`)}`;
  }
}
