import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWith429Retries } from '../src/api/retry.js';

describe('fetchWith429Retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a 60 second fallback delay when Retry-After is missing', async () => {
    vi.useFakeTimers();
    const onWarning = vi.fn();
    const runRequest = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responsePromise = fetchWith429Retries(runRequest, {
      requestDescription: 'GET https://example.test/resource',
      onWarning,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(runRequest).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Warning: GET https://example.test/resource returned 429 Too Many Requests; retry 1/2 in 60s',
      ),
    );
  });
});
