import mongoose from 'mongoose';

export const ACTIVITY_TYPES = ['created', 'updated', 'claimed', 'released', 'assigned', 'transitioned', 'commented'];

const { ObjectId } = mongoose.Schema.Types;

// Append-only history of everything that happened to an item. Comments live here too, so the
// timeline is one indexed, paginated query. Documents are never updated or deleted by the app.
const activitySchema = new mongoose.Schema(
  {
    item: { type: ObjectId, ref: 'WorkItem', required: true },
    team: { type: ObjectId, ref: 'Team', required: true },
    actor: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    // Type-specific payload, e.g. { changes: { priority: { from, to } } } or { body } for comments.
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Item version produced by this activity (null for comments, which do not change the item).
    itemVersion: { type: Number, default: null },
    clientKey: { type: String, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

activitySchema.index({ item: 1, createdAt: -1, _id: -1 });
activitySchema.index({ actor: 1, clientKey: 1 }, { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } });

export const Activity = mongoose.model('Activity', activitySchema);
