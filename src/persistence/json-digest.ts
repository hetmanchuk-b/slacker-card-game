import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Non-JSON stored value');
  return encoded;
}

/** JSONB-order-independent corruption detection, not authentication of untrusted input. */
export function jsonDigest(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  return createHash('sha256').update(canonical(normalized)).digest('hex');
}
