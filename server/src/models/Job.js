import mongoose from 'mongoose';

// Durable job queue ("transactional outbox"). Jobs are inserted in the same transaction as
// the change that caused them, so a committed change always has its follow-up work recorded,
// and a rolled-back change never does.
const jobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['pending', 'running', 'done', 'dead'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    runAt: { type: Date, default: () => new Date() },
    lockedBy: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, lockedUntil: 1 });
// Completed jobs are garbage-collected after a week.
jobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const Job = mongoose.model('Job', jobSchema);
