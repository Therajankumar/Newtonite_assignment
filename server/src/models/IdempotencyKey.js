import mongoose from 'mongoose';
import { config } from '../config.js';

const idempotencyKeySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['processing', 'completed'], default: 'processing' },
    responseStatus: { type: Number, default: null },
    responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
    lockedUntil: { type: Date, required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

idempotencyKeySchema.index({ user: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: config.idempotencyTtlSeconds });

export const IdempotencyKey = mongoose.model('IdempotencyKey', idempotencyKeySchema);
