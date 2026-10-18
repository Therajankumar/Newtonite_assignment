import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundRoute } from './middleware/errorHandler.js';
import authRouter, { teamsRouter } from './routes/auth.js';
import itemsRouter from './routes/items.js';
import { dashboardRouter, eventsRouter, notificationsRouter } from './routes/misc.js';

export function createApp({ logRequests = config.env !== 'test' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ exposedHeaders: ['Idempotent-Replayed'] }));
  app.use(express.json({ limit: '200kb' }));
  if (logRequests) app.use(morgan('dev'));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/teams', requireAuth, teamsRouter);
  app.use('/api/items', requireAuth, itemsRouter);
  app.use('/api/dashboard', requireAuth, dashboardRouter);
  app.use('/api/notifications', requireAuth, notificationsRouter);
  app.use('/api', notFoundRoute);

  // In the Docker image the built React app is served by the API process.
  if (config.clientDist && fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist));
    app.get('*', (req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
