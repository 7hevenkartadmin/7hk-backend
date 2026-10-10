import { env } from './env.js';
import { formatStoreBrandName } from '../shared/utils/brandName.js';

export const storeBusiness = Object.freeze({
  tradeName: formatStoreBrandName(env.STORE_TRADE_NAME),
  legalName: env.STORE_LEGAL_NAME,
  supportEmail: env.STORE_SUPPORT_EMAIL,
  gstin: env.STORE_GSTIN,
  address: env.STORE_BUSINESS_ADDRESS,
});
