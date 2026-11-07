import { describe, expect, it } from 'vitest';

import {
  generateWebhookSecret,
  hashWebhookSecret,
  hashesEqual,
  isPlausibleSecret,
} from './secret';

describe('webhook secret', () => {
  it('generates distinct url-safe 256-bit secrets', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isPlausibleSecret(a)).toBe(true);
  });

  it('hashes deterministically to 64 hex chars', () => {
    const h = hashWebhookSecret('abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWebhookSecret('abc')).toBe(h);
    expect(hashWebhookSecret('abd')).not.toBe(h);
  });

  it('compares hashes in constant time, false on mismatch or length difference', () => {
    const h = hashWebhookSecret('abc');
    expect(hashesEqual(h, hashWebhookSecret('abc'))).toBe(true);
    expect(hashesEqual(h, hashWebhookSecret('abd'))).toBe(false);
    expect(hashesEqual(h, h.slice(1))).toBe(false);
  });

  it('rejects implausible secrets before hashing', () => {
    expect(isPlausibleSecret('short')).toBe(false);
    expect(isPlausibleSecret('has spaces and symbols !!!!!!!!!!!!')).toBe(false);
    expect(isPlausibleSecret('a'.repeat(500))).toBe(false);
  });
});
