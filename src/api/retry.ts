const TOO_MANY_REQUESTS_STATUS = 429;

const DEFAULT_MAX_429_RETRIES = 10;
const DEFAULT_RETRY_WINDOW_MS = 60_000;

type Retry429Options = {
  requestDescription: string;
  onWarning: (message: string) => void;
  maxRetries?: number;
  retryWindowMs?: number;
};

function parseRetryAfterMs(response: Response): number | null {
  const retryAfterHeader = response.headers.get('retry-after');
  if (!retryAfterHeader) {
    return null;
  }

  const retryAfterSeconds = Number.parseFloat(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.ceil(retryAfterSeconds * 1000);
  }

  const retryAt = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.max(0, retryAt - Date.now());
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // Ignore cancellation issues because retry logic should continue.
  }
}

export async function fetchWith429Retries(
  runRequest: () => Promise<Response>,
  options: Retry429Options,
): Promise<Response> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_429_RETRIES;
  const retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  let retryCount = 0;

  for (;;) {
    const response = await runRequest();
    if (response.status !== TOO_MANY_REQUESTS_STATUS) {
      return response;
    }

    if (retryCount >= maxRetries) {
      return response;
    }

    const fallbackDelayMs = Math.max(1, retryWindowMs);
    const retryAfterMs = parseRetryAfterMs(response);
    const waitMs = retryAfterMs ?? fallbackDelayMs;
    const retryIndex = retryCount + 1;

    options.onWarning(
      `Warning: ${options.requestDescription} returned 429 Too Many Requests; retry ${retryIndex}/${maxRetries} in ${Math.ceil(waitMs / 1000)}s`,
    );

    await cancelResponseBody(response);
    await sleep(waitMs);
    retryCount += 1;
  }
}
