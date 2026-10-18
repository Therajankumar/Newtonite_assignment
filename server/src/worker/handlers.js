import { Activity, Membership, Notification, User, WorkItem } from '../models/index.js';
import { sameId } from '../lib/ids.js';

function describe(activity, actorName, item) {
  const d = activity.data ?? {};
  switch (activity.type) {
    case 'created':
      return `${actorName} created ${item.key}: ${item.title}`;
    case 'claimed':
      return `${actorName} took ownership of ${item.key}`;
    case 'released':
      return `${actorName} released ${item.key} back to the queue`;
    case 'assigned':
      return d.to ? `${actorName} assigned ${item.key} to ${d.to.name}` : `${actorName} unassigned ${item.key}`;
    case 'updated':
      return `${actorName} updated ${Object.keys(d.changes ?? {}).join(', ')} on ${item.key}`;
    case 'transitioned':
      return `${actorName} moved ${item.key} from ${d.from.replace('_', ' ')} to ${d.to.replace('_', ' ')}`;
    case 'commented':
      return `${actorName} commented on ${item.key}: "${String(d.body).slice(0, 80)}"`;
    default:
      return `${actorName} changed ${item.key}`;
  }
}

/**
 * Fan out in-app notifications for one activity. Idempotent: notifications are upserted on
 * (user, activity), so re-running this job after a partial failure or a duplicate delivery
 * creates no duplicates.
 */
async function notify({ activityId, recipients: snapshot }) {
  const activity = await Activity.findById(activityId).lean();
  if (!activity) return; // nothing to do - never retry forever on missing data
  const [item, actor] = await Promise.all([
    WorkItem.findById(activity.item).select('key title team assignee reporter watchers').lean(),
    User.findById(activity.actor).select('name').lean(),
  ]);
  if (!item) return;

  const recipients = new Set(snapshot ?? [...(item.watchers ?? []), item.assignee, item.reporter].filter(Boolean).map(String));
  if (activity.type === 'assigned' && activity.data?.from?.id) recipients.add(activity.data.from.id);
  if (activity.type === 'transitioned' && activity.data?.transition === 'request_approval') {
    const leads = await Membership.find({ team: item.team, role: 'lead' }).select('user').lean();
    for (const l of leads) if (!sameId(l.user, item.assignee) && !sameId(l.user, item.reporter)) recipients.add(String(l.user));
  }
  recipients.delete(String(activity.actor));
  if (!recipients.size) return;

  const message = describe(activity, actor?.name ?? 'Someone', item);
  await Notification.bulkWrite(
    [...recipients].map((userId) => ({
      updateOne: {
        filter: { user: userId, activity: activity._id },
        update: { $setOnInsert: { user: userId, activity: activity._id, item: item._id, message, read: false, createdAt: activity.createdAt } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

export const handlers = { notify };
