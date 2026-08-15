const STORE_UTC_OFFSET = '+05:30';

export function storeDateKey(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
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

export function todayStoreRange() {
  return parseStoreDate(storeDateKey());
}
