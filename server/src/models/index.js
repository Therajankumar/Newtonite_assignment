export { User } from './User.js';
export { Team } from './Team.js';
export { Membership, ROLES } from './Membership.js';
export { Counter, nextSequence } from './Counter.js';
export * from './WorkItem.js';
export { Activity, ACTIVITY_TYPES } from './Activity.js';
export { Job } from './Job.js';
export { Notification } from './Notification.js';
export { IdempotencyKey } from './IdempotencyKey.js';

import { User } from './User.js';
import { Team } from './Team.js';
import { Membership } from './Membership.js';
import { Counter } from './Counter.js';
import { WorkItem } from './WorkItem.js';
import { Activity } from './Activity.js';
import { Job } from './Job.js';
import { Notification } from './Notification.js';
import { IdempotencyKey } from './IdempotencyKey.js';

export const allModels = [User, Team, Membership, Counter, WorkItem, Activity, Job, Notification, IdempotencyKey];

/** Create collections and indexes up front (collections cannot be created lazily inside every transaction). */
export async function ensureIndexes() {
  for (const m of allModels) {
    await m.createCollection().catch(() => {});
    await m.syncIndexes();
  }
}
