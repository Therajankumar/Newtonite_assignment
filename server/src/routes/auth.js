import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { unauthenticated } from '../errors.js';
import { ah } from '../lib/asyncHandler.js';
import { Membership, Team, User } from '../models/index.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { parse } from '../middleware/validate.js';

const router = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function profile(user) {
  const memberships = await Membership.find({ user: user._id }).populate('team', 'key name').lean();
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    isAdmin: user.isAdmin,
    teams: memberships
      .filter((m) => m.team)
      .map((m) => ({ id: String(m.team._id), key: m.team.key, name: m.team.name, role: m.role })),
  };
}

router.post(
  '/login',
  ah(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash').lean();
    // Same error for unknown email and wrong password, to avoid account enumeration.
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw unauthenticated('Invalid email or password');
    res.json({ token: signToken(user), user: await profile(user) });
  }),
);

router.get(
  '/me',
  requireAuth,
  ah(async (req, res) => res.json({ user: await profile(req.user) })),
);

// Convenience for the demo login screen. Off by default in production (DEMO_LOGIN).
router.get(
  '/demo-users',
  ah(async (req, res) => {
    if (!config.demoLogin) return res.json({ users: [] });
    const users = await User.find().sort({ isAdmin: -1, name: 1 }).limit(20).lean();
    const memberships = await Membership.find({ user: { $in: users.map((u) => u._id) } }).populate('team', 'key').lean();
    res.json({
      users: users.map((u) => ({
        email: u.email,
        name: u.name,
        isAdmin: u.isAdmin,
        roles: memberships.filter((m) => String(m.user) === String(u._id)).map((m) => `${m.team?.key}:${m.role}`),
      })),
    });
  }),
);

export default router;

export const teamsRouter = Router();

teamsRouter.get(
  '/',
  ah(async (req, res) => {
    if (req.user.isAdmin) {
      const teams = await Team.find().sort({ key: 1 }).lean();
      return res.json({ teams: teams.map((t) => ({ id: String(t._id), key: t.key, name: t.name, role: req.user.roles.get(String(t._id)) ?? 'lead' })) });
    }
    res.json({ teams: (await profile(req.user)).teams });
  }),
);

teamsRouter.get(
  '/:id/members',
  ah(async (req, res) => {
    const teamId = req.params.id;
    if (!req.user.isAdmin && !req.user.roles.has(teamId)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Team not found' } });
    const members = await Membership.find({ team: teamId }).populate('user', 'name email').lean();
    res.json({
      members: members
        .filter((m) => m.user)
        .map((m) => ({ id: String(m.user._id), name: m.user.name, email: m.user.email, role: m.role }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }),
);
