export const STORE_TIMEZONE = 'Asia/Kolkata';
export const STORE_UTC_OFFSET = '+05:30';

export function storeDateKey(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function parseStoreDate(value) {
  const clean = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return null;
  const start = new Date(`${clean}T00:00:00.000${STORE_UTC_OFFSET}`);
  if (Number.isNaN(start.getTime()) || storeDateKey(start) !== clean) return null;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function parseStoreDateTime(value, { endOfDay = false } = {}) {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    return Number.isNaN(copy.getTime()) ? null : copy;
  }
  const clean = String(value || '').trim();
  if (!clean) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const range = parseStoreDate(clean);
    return range ? new Date((endOfDay ? range.end : range.start).getTime() - (endOfDay ? 1 : 0)) : null;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(clean)
    ? `${clean}${STORE_UTC_OFFSET}`
    : clean;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatStoreDate(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: STORE_TIMEZONE, ...options }).format(date);
}

export function todayStoreRange() {
  return parseStoreDate(storeDateKey());
}
