const TOKEN_KEY = 'newtonite.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t) => {
    try {
      t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: session lasts until reload */
    }
  },
};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** True when the server definitely processed and rejected the request (safe to change the key). */
  get isClientError() {
    return this.status >= 400 && this.status < 500;
  }
}

export function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE_STATUS = new Set([502, 503, 504]);
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

/**
 * fetch wrapper. GETs, and writes that carry an Idempotency-Key, are retried automatically
 * on network failures and gateway errors - always with the *same* key, so the server can
 * recognise the retry and never applies the change twice. Writes without a key are never
 * retried automatically.
 */
export async function api(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { Accept: 'application/json' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const retryable = method === 'GET' || !!idempotencyKey;
  const maxAttempts = retryable ? 4 : 1;

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      if (attempt < maxAttempts) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
    }
    const payload = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.ok) return payload;

    const err = payload?.error ?? {};
    const inProgress = res.status === 409 && err.code === 'REQUEST_IN_PROGRESS';
    if ((RETRYABLE_STATUS.has(res.status) || inProgress) && attempt < maxAttempts) {
      await sleep(300 * 2 ** attempt);
      continue;
    }
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `Request failed (${res.status})`, err.details);
  }
}
