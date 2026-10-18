import mongoose from 'mongoose';

export const STATUSES = ['open', 'in_progress', 'blocked', 'awaiting_approval', 'resolved', 'closed', 'cancelled'];
export const ACTIVE_STATUSES = ['open', 'in_progress', 'blocked', 'awaiting_approval'];
export const TERMINAL_STATUSES = ['closed', 'cancelled'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const PRIORITY_RANK = { low: 1, medium: 2, high: 3, urgent: 4 };
export const TYPES = ['incident', 'customer_issue', 'engineering', 'payment', 'compliance', 'task'];
export const APPROVAL_STATES = ['none', 'pending', 'approved', 'rejected'];

const { ObjectId } = mongoose.Schema.Types;

const workItemSchema = new mongoose.Schema(
  {
    team: { type: ObjectId, ref: 'Team', required: true },
    number: { type: Number, required: true },
    key: { type: String, required: true }, // "PAY-142"
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 20_000 },
    type: { type: String, enum: TYPES, default: 'task' },
    priority: { type: String, enum: PRIORITIES, default: 'medium' },
    // Numeric copy of priority so we can sort and range-query by importance with an index.
    priorityRank: { type: Number, required: true },
    status: { type: String, enum: STATUSES, default: 'open' },
    assignee: { type: ObjectId, ref: 'User', default: null },
    reporter: { type: ObjectId, ref: 'User', required: true },
    // "What requires attention next" - a short free-text pointer kept up to date by the owner.
    nextAction: { type: String, default: '', maxlength: 500 },
    dueAt: { type: Date, default: null },
    requiresApproval: { type: Boolean, default: false },
    approval: {
      state: { type: String, enum: APPROVAL_STATES, default: 'none' },
      by: { type: ObjectId, ref: 'User', default: null },
      at: { type: Date, default: null },
      note: { type: String, default: '' },
    },
    resolution: { type: String, default: '' },
    watchers: [{ type: ObjectId, ref: 'User' }],
    // Optimistic concurrency token. Every write that changes the item's content
    // increments it; writes must name the version they were based on.
    version: { type: Number, default: 1 },
    // Bumped by any activity (including comments) so "going stale" can be detected.
    lastActivityAt: { type: Date, default: () => new Date() },
    // Client-supplied idempotency key for creation (unique per reporter). A second layer of
    // duplicate protection underneath the HTTP idempotency middleware.
    createKey: { type: String, default: undefined },
  },
  { timestamps: true, versionKey: false },
);

workItemSchema.index({ team: 1, number: 1 }, { unique: true });
workItemSchema.index({ key: 1 });
workItemSchema.index({ reporter: 1, createKey: 1 }, { unique: true, partialFilterExpression: { createKey: { $type: 'string' } } });
// List / dashboard access paths. Every query is scoped by team (or assignee) first.
workItemSchema.index({ team: 1, updatedAt: -1, _id: -1 });
workItemSchema.index({ team: 1, status: 1, priorityRank: -1, updatedAt: -1 });
workItemSchema.index({ team: 1, status: 1, lastActivityAt: 1 });
workItemSchema.index({ assignee: 1, status: 1, priorityRank: -1 });
workItemSchema.index({ status: 1, dueAt: 1 }, { partialFilterExpression: { dueAt: { $type: 'date' } } });
workItemSchema.index({ title: 'text', description: 'text', key: 'text' }, { weights: { key: 10, title: 5, description: 1 } });

export const WorkItem = mongoose.model('WorkItem', workItemSchema);
