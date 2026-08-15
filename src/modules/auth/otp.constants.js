export const OTP_PURPOSE = Object.freeze({ LOGIN: 'LOGIN', DELIVERY: 'DELIVERY' });

export const OTP_CHANNEL = Object.freeze({ WHATSAPP: 'WHATSAPP', IN_APP: 'IN_APP' });

export const OTP_DELIVERY_STATUS = Object.freeze({
  QUEUED: 'QUEUED',
  ACCEPTED: 'ACCEPTED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
});
