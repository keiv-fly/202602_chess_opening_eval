import { describe, expect, it, vi } from 'vitest';
import { SessionCache } from '../src/cache.js';

describe('SessionCache', () => {
  it('memoizes async calls by key', async () => {
    const cache = new SessionCache();
    const factory = vi.fn(async () => 42);

    const first = await cache.getOrSet('k', factory);
    const second = await cache.getOrSet('k', factory);

    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
