import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../lib/asyncHandler.js';
import { idempotency } from '../middleware/idempotency.js';
import { parse } from '../middleware/validate.js';
import { PRIORITIES, TYPES } from '../models/index.js';
import { TRANSITION_NAMES } from '../domain/workflow.js';
import * as items from '../services/workItemService.js';
import { listItems } from '../services/queryService.js';

const router = Router();

const version = z.number({ required_error: 'version is required (the version of the item you are changing)' }).int().positive();
const dueAt = z.coerce.date().nullable();

const createSchema = z.object({
  team: z.string(),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(20_000).optional(),
  type: z.enum(TYPES).default('task'),
  priority: z.enum(PRIORITIES).default('medium'),
  dueAt: dueAt.optional(),
  nextAction: z.string().max(500).optional(),
  requiresApproval: z.boolean().optional(),
});

const patchSchema = z
  .object({
    version,
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().max(20_000).optional(),
    type: z.enum(TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueAt: dueAt.optional(),
    nextAction: z.string().max(500).optional(),
    requiresApproval: z.boolean().optional(),
  })
  .strict();

const assignSchema = z.object({ version, assigneeId: z.string().nullable() });
const transitionSchema = z.object({
  version,
  note: z.string().max(2000).optional(),
  resolution: z.string().max(5000).optional(),
});
const commentSchema = z.object({ body: z.string().trim().min(1).max(10_000) });

router.get('/', ah(async (req, res) => res.json(await listItems(req.user, req.query))));

router.post(
  '/',
  idempotency(),
  ah(async (req, res) => {
    const input = parse(createSchema, req.body);
    const { item, replayed } = await items.createItem(req.user, input, { createKey: req.get('idempotency-key') });
    res.status(replayed ? 200 : 201).json({ item });
  }),
);

router.get('/:id', ah(async (req, res) => res.json({ item: await items.getItem(req.user, req.params.id) })));

router.patch(
  '/:id',
  idempotency(),
  ah(async (req, res) => {
    const { version: v, ...patch } = parse(patchSchema, req.body);
    res.json({ item: await items.updateItem(req.user, req.params.id, v, patch) });
  }),
);

router.post('/:id/claim', idempotency(), ah(async (req, res) => res.json({ item: await items.claimItem(req.user, req.params.id) })));
router.post('/:id/release', idempotency(), ah(async (req, res) => res.json({ item: await items.releaseItem(req.user, req.params.id) })));

router.post(
  '/:id/assign',
  idempotency(),
  ah(async (req, res) => {
    const { version: v, assigneeId } = parse(assignSchema, req.body);
    res.json({ item: await items.assignItem(req.user, req.params.id, v, assigneeId) });
  }),
);

router.post(
  '/:id/transitions/:name',
  idempotency(),
  ah(async (req, res) => {
    const name = parse(z.enum(TRANSITION_NAMES), req.params.name);
    const { version: v, ...input } = parse(transitionSchema, req.body);
    res.json({ item: await items.transitionItem(req.user, req.params.id, v, name, input) });
  }),
);

router.get(
  '/:id/activity',
  ah(async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit ?? '30', 10) || 30, 100);
    res.json(await items.listActivity(req.user, req.params.id, { before: req.query.before, limit }));
  }),
);

router.post(
  '/:id/comments',
  idempotency(),
  ah(async (req, res) => {
    const { body } = parse(commentSchema, req.body);
    const { activity, replayed } = await items.addComment(req.user, req.params.id, body, { clientKey: req.get('idempotency-key') });
    res.status(replayed ? 200 : 201).json({ activity });
  }),
);

export default router;
