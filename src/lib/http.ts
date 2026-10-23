/**
 * Minimal fetch wrapper for third-party catalog APIs.
 *
 * Every external call gets a timeout and a typed failure. Providers must be
 * able to fail without taking the app down -- an unreachable price source is
 * a labelled "unavailable", never a crash and never a silently invented value.
 */

export class HttpError extends Error {
  // Declared as fields rather than constructor parameter properties, which
  // this project's `erasableSyntaxOnly` setting disallows -- that flag keeps
  // every file runnable by Node's type-stripping loader with no compile step.
  readonly status: number | null;
  readonly url: string;

  constructor(message: string, status: number | null, url: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export interface GetJsonOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function getJson<T>(url: string, opts: GetJsonOptions = {}): Promise<T> {
  const { timeoutMs = 12_000, signal, headers = {} } = opts;

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Combine the caller's cancellation (e.g. the user typed another letter)
  // with our timeout, so whichever fires first wins.
  const signals: AbortSignal[] = [timeoutController.signal];
  if (signal) signals.push(signal);
  const combined =
    typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : timeoutController.signal;

  try {
    const res = await fetch(url, {
      signal: combined,
      headers: { Accept: 'application/json', ...headers },
    });
    if (!res.ok) {
      throw new HttpError(`${res.status} ${res.statusText}`, res.status, url);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (signal?.aborted) throw err; // caller cancelled; let it propagate
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new HttpError(`Timed out after ${timeoutMs}ms`, null, url);
    }
    throw new HttpError(err instanceof Error ? err.message : 'Network error', null, url);
  } finally {
    clearTimeout(timer);
  }
}

/** Cache a promise-returning function's single result for the session. */
export function memoizeOnce<T>(fn: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      cached = fn().catch((e) => {
        cached = null; // allow a retry after a failure
        throw e;
      });
    }
    return cached;
  };
}
