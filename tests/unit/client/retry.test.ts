import { describe, expect, it } from 'vitest';
import {
  classifyNetworkError,
  computeBackoffMs,
  describeTarget,
  fetchWithRetry,
  isZendeskNetworkError,
  parseRetryAfter,
  type ZendeskNetworkError,
} from '../../../src/client/retry';

const TARGET = 'https://testsubdomain.zendesk.com/api/v2/tickets';

// A network failure as `fetch` throws it: a generic outer error whose `cause`
// carries the syscall/undici code.
const netError = (code?: string): Error =>
  new TypeError('fetch failed', {
    cause: code === undefined ? new Error('boom') : Object.assign(new Error('boom'), { code }),
  });

/** Records the delays a run asks for, and pins jitter to its lower bound. */
const recordingDeps = (random = 0) => {
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
      random: () => random,
    },
  };
};

/** Plays the given outcomes in order, one per attempt, and counts the attempts. */
const attempts = (...outcomes: (Error | (() => Response))[]) => {
  const calls = { count: 0 };
  const attempt = async (): Promise<Response> => {
    const outcome = outcomes[calls.count] ?? outcomes.at(-1);
    calls.count += 1;
    if (outcome instanceof Error) throw outcome;
    // A factory, not a Response: every attempt needs an unconsumed body.
    return (outcome as () => Response)();
  };
  return { attempt, calls };
};

const status = (code: number, headers?: Record<string, string>) => () =>
  new Response('payload', { status: code, ...(headers && { headers }) });

describe('describeTarget', () => {
  it('keeps origin and path', () => {
    expect(describeTarget('https://acme.zendesk.com/api/v2/tickets/1')).toBe(
      'https://acme.zendesk.com/api/v2/tickets/1',
    );
  });

  it('drops the query string, which can carry an upload token', () => {
    expect(
      describeTarget('https://acme.zendesk.com/api/v2/uploads?filename=a.png&token=secret'),
    ).toBe('https://acme.zendesk.com/api/v2/uploads');
  });

  it('drops the fragment', () => {
    expect(describeTarget('https://acme.zendesk.com/api/v2/tickets#frag')).toBe(
      'https://acme.zendesk.com/api/v2/tickets',
    );
  });
});

describe('classifyNetworkError', () => {
  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])(
    'treats %s as pre-send',
    (code) => {
      expect(classifyNetworkError(netError(code))).toBe('pre-send');
    },
  );

  it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'])(
    'treats %s as unknown, since the request may have been sent',
    (code) => {
      expect(classifyNetworkError(netError(code))).toBe('unknown');
    },
  );

  it('treats a code-less error as unknown', () => {
    expect(classifyNetworkError(netError())).toBe('unknown');
  });

  it('finds a code on a plain-object cause', () => {
    expect(
      classifyNetworkError(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })),
    ).toBe('pre-send');
  });

  it('does not hang on a cyclic cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(classifyNetworkError(err)).toBe('unknown');
  });

  it('treats a non-error value as unknown', () => {
    expect(classifyNetworkError('nope')).toBe('unknown');
  });
});

describe('parseRetryAfter', () => {
  it('reads delay-seconds', () => {
    expect(parseRetryAfter('2')).toBe(2000);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRetryAfter(' 2 ')).toBe(2000);
  });

  it('reads an HTTP-date as a delta from now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(3000);
  });

  it('clamps a past HTTP-date to zero', () => {
    const now = Date.parse('2026-01-01T00:00:10Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(0);
  });

  it.each([null, '', '   ', 'soon', '-1'])('returns undefined for %j', (header) => {
    expect(parseRetryAfter(header)).toBeUndefined();
  });
});

describe('computeBackoffMs', () => {
  // Equal jitter over a 250 ms base: half the window is fixed, half is random,
  // so a retry never fires instantly and never lands on a fixed grid.
  it.each([
    [1, 0, 125],
    [1, 1, 250],
    [2, 0, 250],
    [2, 1, 500],
    [3, 0, 500],
    [3, 1, 1000],
  ])('attempt %i with random %i waits %i ms', (attempt, random, expected) => {
    expect(computeBackoffMs(attempt, () => random)).toBe(expected);
  });

  it('caps the exponential growth at 4 s', () => {
    expect(computeBackoffMs(9, () => 1)).toBe(4000);
    expect(computeBackoffMs(9, () => 0)).toBe(2000);
  });

  it('grows monotonically until the cap', () => {
    const delays = [1, 2, 3, 4].map((n) => computeBackoffMs(n, () => 1));
    expect(delays).toStrictEqual([250, 500, 1000, 2000]);
  });
});

describe('fetchWithRetry — network failures', () => {
  it('retries a GET through transient failures and returns the success', async () => {
    const { attempt, calls } = attempts(
      netError('ECONNRESET'),
      netError('ECONNRESET'),
      status(200),
    );
    const { sleeps, deps } = recordingDeps();

    const response = await fetchWithRetry(attempt, 'GET', TARGET, deps);

    expect(response.status).toBe(200);
    expect(calls.count).toBe(3);
    expect(sleeps).toStrictEqual([125, 250]);
  });

  it('gives up after 3 attempts and wraps the failure with context', async () => {
    const { attempt, calls } = attempts(netError('ECONNRESET'));
    const { deps } = recordingDeps();

    const error = await fetchWithRetry(attempt, 'GET', TARGET, deps).catch((e: unknown) => e);

    expect(isZendeskNetworkError(error)).toBe(true);
    const wrapped = error as ZendeskNetworkError;
    expect(calls.count).toBe(3);
    expect(wrapped.attempts).toBe(3);
    expect(wrapped.method).toBe('GET');
    expect(wrapped.target).toBe(TARGET);
    expect(wrapped.message).toBe(
      `Network error on GET ${TARGET} after 3 attempts: ECONNRESET: fetch failed`,
    );
  });

  it('does not retry a POST whose request may already have been sent', async () => {
    const { attempt, calls } = attempts(netError('ECONNRESET'));
    const { sleeps, deps } = recordingDeps();

    const error = await fetchWithRetry(attempt, 'POST', TARGET, deps).catch((e: unknown) => e);

    expect(isZendeskNetworkError(error)).toBe(true);
    expect((error as ZendeskNetworkError).attempts).toBe(1);
    expect((error as ZendeskNetworkError).message).toContain('after 1 attempt:');
    expect(calls.count).toBe(1);
    expect(sleeps).toStrictEqual([]);
  });

  it.each(['POST', 'PUT', 'DELETE'] as const)(
    'retries a %s when the connection provably never opened',
    async (method) => {
      const { attempt, calls } = attempts(
        netError('ENOTFOUND'),
        netError('ENOTFOUND'),
        status(201),
      );
      const { deps } = recordingDeps();

      const response = await fetchWithRetry(attempt, method, TARGET, deps);

      expect(response.status).toBe(201);
      expect(calls.count).toBe(3);
    },
  );

  it('keeps the original failure as the cause', async () => {
    const cause = netError('ENOTFOUND');
    const { attempt } = attempts(cause);
    const { deps } = recordingDeps();

    const error = await fetchWithRetry(attempt, 'POST', TARGET, deps).catch((e: unknown) => e);

    expect((error as ZendeskNetworkError).cause).toBe(cause);
  });

  it('describes a non-error rejection', async () => {
    const attempt = () => Promise.reject('socket gone');
    const { deps } = recordingDeps();

    const error = await fetchWithRetry(attempt, 'POST', TARGET, deps).catch((e: unknown) => e);

    expect((error as ZendeskNetworkError).message).toBe(
      `Network error on POST ${TARGET} after 1 attempt: socket gone`,
    );
  });

  it('strips non-ASCII bytes, which node:http rejects in headers', async () => {
    const attempt = () => Promise.reject(new Error('échec réseau'));
    const { deps } = recordingDeps();

    const error = await fetchWithRetry(attempt, 'POST', TARGET, deps).catch((e: unknown) => e);

    expect((error as ZendeskNetworkError).message).toBe(
      `Network error on POST ${TARGET} after 1 attempt: ?chec r?seau`,
    );
  });

  it('reports a code-less failure without an empty prefix', async () => {
    const { attempt } = attempts(netError());
    const { deps } = recordingDeps();

    const error = await fetchWithRetry(attempt, 'GET', TARGET, deps).catch((e: unknown) => e);

    expect((error as ZendeskNetworkError).message).toBe(
      `Network error on GET ${TARGET} after 3 attempts: fetch failed`,
    );
  });
});

describe('fetchWithRetry — server errors', () => {
  it.each(['GET', 'DELETE'] as const)('retries a 500 on %s', async (method) => {
    const { attempt, calls } = attempts(status(500), status(200));
    const { sleeps, deps } = recordingDeps();

    const response = await fetchWithRetry(attempt, method, TARGET, deps);

    expect(response.status).toBe(200);
    expect(calls.count).toBe(2);
    expect(sleeps).toStrictEqual([125]);
  });

  it.each(['POST', 'PUT'] as const)(
    'never retries a 500 on %s, which may already have applied',
    async (method) => {
      const { attempt, calls } = attempts(status(500), status(200));
      const { sleeps, deps } = recordingDeps();

      const response = await fetchWithRetry(attempt, method, TARGET, deps);

      expect(response.status).toBe(500);
      expect(calls.count).toBe(1);
      expect(sleeps).toStrictEqual([]);
      // The caller still needs the body for its ZendeskApiError message.
      await expect(response.text()).resolves.toBe('payload');
    },
  );

  it('returns the last response instead of retrying forever', async () => {
    const { attempt, calls } = attempts(status(503));
    const { sleeps, deps } = recordingDeps();

    const response = await fetchWithRetry(attempt, 'GET', TARGET, deps);

    expect(response.status).toBe(503);
    expect(calls.count).toBe(3);
    expect(sleeps).toStrictEqual([125, 250]);
    await expect(response.text()).resolves.toBe('payload');
  });

  it.each([400, 401, 403, 404, 422])('returns a terminal %i unretried', async (code) => {
    const { attempt, calls } = attempts(status(code));
    const { deps } = recordingDeps();

    const response = await fetchWithRetry(attempt, 'GET', TARGET, deps);

    expect(response.status).toBe(code);
    expect(calls.count).toBe(1);
  });
});

describe('fetchWithRetry — 429', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE'] as const)(
    'retries a throttled %s, since Zendesk refused the request',
    async (method) => {
      const { attempt, calls } = attempts(status(429, { 'Retry-After': '2' }), status(200));
      const { sleeps, deps } = recordingDeps();

      const response = await fetchWithRetry(attempt, method, TARGET, deps);

      expect(response.status).toBe(200);
      expect(calls.count).toBe(2);
      expect(sleeps).toStrictEqual([2000]);
    },
  );

  it('falls back to backoff when Retry-After is absent', async () => {
    const { attempt } = attempts(status(429), status(200));
    const { sleeps, deps } = recordingDeps();

    await fetchWithRetry(attempt, 'GET', TARGET, deps);

    expect(sleeps).toStrictEqual([125]);
  });

  it('surfaces the 429 instead of parking the call on a long Retry-After', async () => {
    const { attempt, calls } = attempts(status(429, { 'Retry-After': '6' }), status(200));
    const { sleeps, deps } = recordingDeps();

    const response = await fetchWithRetry(attempt, 'GET', TARGET, deps);

    expect(response.status).toBe(429);
    expect(calls.count).toBe(1);
    expect(sleeps).toStrictEqual([]);
  });

  it('still waits a Retry-After sitting exactly on the cap', async () => {
    const { attempt } = attempts(status(429, { 'Retry-After': '5' }), status(200));
    const { sleeps, deps } = recordingDeps();

    const response = await fetchWithRetry(attempt, 'GET', TARGET, deps);

    expect(response.status).toBe(200);
    expect(sleeps).toStrictEqual([5000]);
  });
});
