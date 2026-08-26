import { createHash } from 'node:crypto';

const IMAGE_FIELDS = new Set(['image', 'gallery', 'images']);

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

export function normalizeSourceHosts(values = []) {
  const entries = values.flatMap((value) => String(value || '').split(','));
  const hosts = entries.map(normalizeHost).filter(Boolean);
  if (!hosts.length) throw new Error('At least one source image host is required');
  return new Set(hosts);
}

export function canonicalSourceImageUrl(value, sourceHosts) {
  if (typeof value !== 'string' || !value.trim()) return null;

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== '443')
    || !sourceHosts.has(normalizeHost(parsed.hostname))) {
    return null;
  }

  parsed.hash = '';
  return parsed.href;
}

export function sourceDownloadCandidates(sourceUrl) {
  const parsed = new URL(sourceUrl);
  const marker = '/cdn-cgi/image/';
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex === -1) return [parsed.href];

  const transformedTail = parsed.pathname.slice(markerIndex + marker.length);
  const firstSlash = transformedTail.indexOf('/');
  if (firstSlash === -1 || firstSlash === transformedTail.length - 1) return [parsed.href];

  const originPath = `/${transformedTail.slice(firstSlash + 1)}`;
  const originUrl = new URL(originPath, parsed.origin).href;
  return originUrl === parsed.href ? [parsed.href] : [originUrl, parsed.href];
}

export function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  const isoBaseMediaHeader = buffer.toString('ascii', 4, Math.min(buffer.length, 32));
  if (isoBaseMediaHeader.startsWith('ftyp') && /avif|avis/.test(isoBaseMediaHeader)) return 'image/avif';
  return null;
}

function visitImageValue(value, visitor) {
  if (typeof value === 'string') return visitor(value);
  if (Array.isArray(value)) return value.map((entry) => visitImageValue(entry, visitor));
  return value;
}

function walkCatalogImageFields(value, visitor) {
  if (Array.isArray(value)) {
    return value.map((entry) => walkCatalogImageFields(entry, visitor));
  }
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    IMAGE_FIELDS.has(key)
      ? visitImageValue(entry, visitor)
      : walkCatalogImageFields(entry, visitor),
  ]));
}

export function collectCatalogImageUrls(value, sourceHosts) {
  const urls = new Set();
  walkCatalogImageFields(value, (candidate) => {
    const canonical = canonicalSourceImageUrl(candidate, sourceHosts);
    if (canonical) urls.add(canonical);
    return candidate;
  });
  return urls;
}

export function replaceCatalogImageUrls(value, replacements, sourceHosts) {
  return walkCatalogImageFields(value, (candidate) => {
    const canonical = sourceHosts ? canonicalSourceImageUrl(candidate, sourceHosts) : candidate;
    return (canonical && replacements.get(canonical)) || candidate;
  });
}

function safeAssetName(url) {
  let name = 'catalog-image';
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    name = pathname.split('/').filter(Boolean).at(-1) || name;
  } catch {
    // The caller validates URLs. This fallback keeps the helper deterministic.
  }
  return name
    .replace(/\.[a-zA-Z0-9]{2,5}$/u, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'catalog-image';
}

export function migratedPublicId(sourceUrl, cloudinaryFolder) {
  const parsed = new URL(sourceUrl);
  const host = normalizeHost(parsed.hostname).replace(/[^a-z0-9]+/g, '-');
  const digest = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 20);
  const root = String(cloudinaryFolder || '7heven/catalog').replace(/^\/+|\/+$/g, '');
  return `${root}/migrated/${host}/${safeAssetName(sourceUrl)}-${digest}`;
}
