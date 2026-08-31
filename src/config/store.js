import { env } from './env.js';

export const storeBusiness = Object.freeze({
  tradeName: env.STORE_TRADE_NAME,
  legalName: env.STORE_LEGAL_NAME,
  supportEmail: env.STORE_SUPPORT_EMAIL,
  gstin: env.STORE_GSTIN,
  address: env.STORE_BUSINESS_ADDRESS,
});
