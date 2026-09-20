export const MAX_PARTNER_NAME_LENGTH = 80;

export function validatePartnerNames(values, requiredCount = 2) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
    throw new TypeError('Partner names must be strings');
  }
  const normalized = values.map(value => value.trim());
  if (normalized.slice(0, requiredCount).some(name => !name)) {
    throw new Error(`The first ${requiredCount} partner names cannot be empty`);
  }
  const partners = normalized.filter(Boolean);
  if (partners.some(name => name.length > MAX_PARTNER_NAME_LENGTH)) {
    throw new RangeError(`Partner names must be ${MAX_PARTNER_NAME_LENGTH} characters or fewer`);
  }
  if (new Set(partners).size !== partners.length) {
    throw new Error('Partner names must be distinct');
  }
  return partners;
}

export function configuredPartners(config = {}) {
  const partners = [];
  for (const value of [config.PARTNER_1, config.PARTNER_2, config.PARTNER_3]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new TypeError('Partner names must be strings');
    const name = value.trim();
    if (!name || partners.includes(name)) continue;
    if (name.length > MAX_PARTNER_NAME_LENGTH) {
      throw new RangeError(`Partner names must be ${MAX_PARTNER_NAME_LENGTH} characters or fewer`);
    }
    partners.push(name);
  }
  return partners;
}

export function formatPartnerList(partners) {
  if (partners.length < 2) return partners[0] || '';
  if (partners.length === 2) return `${partners[0]} and ${partners[1]}`;
  return `${partners.slice(0, -1).join(', ')} and ${partners.at(-1)}`;
}
