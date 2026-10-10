export function formatStoreBrandName(value) {
  const name = String(value ?? '').trim();
  return /^7hevenkart$/i.test(name) ? '7Hevenkart' : name;
}
