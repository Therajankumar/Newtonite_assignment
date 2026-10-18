import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const notificationSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    item: { type: ObjectId, ref: 'WorkItem', required: true },
    activity: { type: ObjectId, ref: 'Activity', required: true },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// One notification per (user, activity): makes the notification job idempotent, so a job
// that runs twice (e.g. a worker crashed after doing the work but before marking it done)
// does not notify anyone twice.
notificationSchema.index({ user: 1, activity: 1 }, { unique: true });
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
