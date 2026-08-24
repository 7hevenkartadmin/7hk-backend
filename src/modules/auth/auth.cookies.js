export const AUTH_CONTEXT_HEADER = 'x-auth-context';

export function normalizeAuthContext(value) {
  if (value === 'customer' || value === 'admin' || value === 'owner') return value;
  return null;
}

export function authContextForRole(role = 'customer') {
  if (role === 'customer') return 'customer';
  if (role === 'owner') return 'owner';
  return 'admin';
}

export function accessCookieName(context = 'customer') {
  const normalized = normalizeAuthContext(context);
  if (normalized === 'admin') return 'adminAccessToken';
  if (normalized === 'owner') return 'ownerAccessToken';
  return 'customerAccessToken';
}

export function refreshCookieName(context = 'customer') {
  const normalized = normalizeAuthContext(context);
  if (normalized === 'admin') return 'adminRefreshToken';
  if (normalized === 'owner') return 'ownerRefreshToken';
  return 'customerRefreshToken';
}
