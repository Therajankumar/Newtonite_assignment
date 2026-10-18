import { WorkItem } from '../models/index.js';

/**
 * Pushes "item X changed (now at version N)" hints to connected browsers over Server-Sent
 * Events. The source is a MongoDB change stream, so updates made through *any* API instance
 * reach clients connected to *every* instance. Events carry no item content - clients refetch
 * through the normal authorized API - so a missed event only means slightly staler data,
 * never a security or consistency problem.
 */
const clients = new Set();
let stream = null;

export function addClient(client) {
  clients.add(client);
  return () => clients.delete(client);
}

export function broadcast(event) {
  for (const c of clients) {
    if (c.canSeeTeam(event.team)) c.send(event);
  }
}

export function startRealtime(log = console) {
  try {
    stream = WorkItem.watch(
      [{ $match: { operationType: { $in: ['insert', 'update', 'replace'] } } }],
      { fullDocument: 'updateLookup' },
    );
    stream.on('change', (change) => {
      const doc = change.fullDocument;
      if (!doc) return;
      broadcast({ type: 'item.changed', itemId: String(doc._id), team: String(doc.team), version: doc.version, key: doc.key });
    });
    stream.on('error', (err) => {
      log.warn?.(`[realtime] change stream error, live updates disabled: ${err.message}`);
      stream = null;
    });
  } catch (err) {
    log.warn?.(`[realtime] could not start change stream: ${err.message}`);
  }
  const heartbeat = setInterval(() => {
    for (const c of clients) c.ping();
  }, 25_000);
  return async () => {
    clearInterval(heartbeat);
    await stream?.close().catch(() => {});
  };
}
