import { Router } from 'express';
import { ah } from '../lib/asyncHandler.js';
import { isObjectId } from '../lib/ids.js';
import { Notification } from '../models/index.js';
import { dashboard } from '../services/queryService.js';
import { loadUserFromToken } from '../middleware/auth.js';
import { addClient } from '../services/realtime.js';

export const dashboardRouter = Router();
dashboardRouter.get('/', ah(async (req, res) => res.json(await dashboard(req.user))));

export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  ah(async (req, res) => {
    const filter = { user: req.user._id };
    if (req.query.unread === 'true') filter.read = false;
    if (req.query.before && isObjectId(req.query.before)) filter._id = { $lt: req.query.before };
    const limit = 30;
    const [rows, unread] = await Promise.all([
      Notification.find(filter).sort({ _id: -1 }).limit(limit + 1).populate('item', 'key title').lean(),
      Notification.countDocuments({ user: req.user._id, read: false }),
    ]);
    const page = rows.slice(0, limit);
    res.json({
      unread,
      notifications: page.map((n) => ({
        id: String(n._id),
        message: n.message,
        read: n.read,
        createdAt: n.createdAt,
        item: n.item ? { id: String(n.item._id), key: n.item.key, title: n.item.title } : null,
      })),
      nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null,
    });
  }),
);

notificationsRouter.post(
  '/read',
  ah(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isObjectId) : null;
    const filter = { user: req.user._id, read: false, ...(ids ? { _id: { $in: ids } } : {}) };
    const { modifiedCount } = await Notification.updateMany(filter, { $set: { read: true } });
    res.json({ updated: modifiedCount });
  }),
);

/**
 * Server-Sent Events stream of "item changed" hints. EventSource cannot send headers, so the
 * token comes in the query string (acceptable here because the stream carries no content;
 * a production system would exchange it for a short-lived stream ticket).
 */
export const eventsRouter = Router();
eventsRouter.get(
  '/',
  ah(async (req, res) => {
    const user = await loadUserFromToken(String(req.query.token ?? ''));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const remove = addClient({
      canSeeTeam: (teamId) => user.isAdmin || user.roles.has(teamId),
      send: (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      ping: () => res.write(': ping\n\n'),
    });
    req.on('close', remove);
  }),
);
