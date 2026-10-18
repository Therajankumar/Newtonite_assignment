import crypto from 'node:crypto';
import { AppError, badRequest } from '../errors.js';
import { IdempotencyKey } from '../models/index.js';

const LOCK_MS = 60_000;

/**
 * HTTP idempotency for unsafe requests, keyed by the client-generated `Idempotency-Key` header.
 *
 * - First request with a key: reserve it (unique index on user+key), run the handler, store
 *   the response.
 * - Same key again after completion: replay the stored response; the handler does not run.
 * - Same key while the first is still running: 409 REQUEST_IN_PROGRESS (client retries later).
 * - Same key with a different body: 422, since that is a client bug, not a retry.
 * - Handler failed with a 5xx: the reservation is released so the retry can run.
 *
 * The client keeps the same key when it retries after a timeout or network error, and
 * generates a new one for each new user intent.
 */
export function idempotency({ required = false } = {}) {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return required ? next(badRequest('Idempotency-Key header is required')) : next();
    if (key.length > 200) return next(badRequest('Idempotency-Key is too long'));

    const requestHash = crypto
      .createHash('sha256')
      .update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? {})}`)
      .digest('hex');
    const now = new Date();

    try {
      await IdempotencyKey.create({ user: req.user._id, key, requestHash, lockedUntil: new Date(now.getTime() + LOCK_MS) });
    } catch (err) {
      if (err.code !== 11000) return next(err);
      const existing = await IdempotencyKey.findOne({ user: req.user._id, key }).lean();
      if (!existing) return next(new AppError(409, 'REQUEST_IN_PROGRESS', 'Request is being processed, retry shortly'));
      if (existing.requestHash !== requestHash)
        return next(new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for a different request'));
      if (existing.state === 'completed') {
        res.set('Idempotent-Replayed', 'true');
        return res.status(existing.responseStatus).json(existing.responseBody);
      }
      // A previous attempt holds the key. If its lock expired, the process handling it died;
      // take over the reservation so the client is not stuck forever.
      const takeover = await IdempotencyKey.findOneAndUpdate(
        { _id: existing._id, state: 'processing', lockedUntil: { $lt: now } },
        { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
      );
      if (!takeover) return next(new AppError(409, 'REQUEST_IN_PROGRESS', 'An identical request is still being processed, retry shortly'));
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const done =
        status >= 500
          ? IdempotencyKey.deleteOne({ user: req.user._id, key })
          : IdempotencyKey.updateOne(
              { user: req.user._id, key },
              { $set: { state: 'completed', responseStatus: status, responseBody: body } },
            );
      // Record the outcome before replying, so a retry that arrives immediately sees it.
      done.catch(() => {}).finally(() => originalJson(body));
      return res;
    };
    next();
  };
}
