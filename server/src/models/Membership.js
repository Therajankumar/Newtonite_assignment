import mongoose from 'mongoose';

export const ROLES = ['viewer', 'member', 'lead'];

// Separate collection (rather than an array on User) so that "members of team X" and
// "teams of user Y" are both cheap indexed queries and a role change is a single-document write.
const membershipSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
    role: { type: String, enum: ROLES, required: true },
  },
  { timestamps: true },
);

membershipSchema.index({ user: 1, team: 1 }, { unique: true });
membershipSchema.index({ team: 1, role: 1 });

export const Membership = mongoose.model('Membership', membershipSchema);
