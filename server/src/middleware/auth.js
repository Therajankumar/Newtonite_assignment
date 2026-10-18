import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { unauthenticated } from '../errors.js';
import { Membership, User } from '../models/index.js';

export function signToken(user) {
  return jwt.sign({ sub: String(user._id) }, config.jwtSecret, { expiresIn: config.jwtTtl });
}

/**
 * Load the caller and their team roles from the database on every request. Roles are
 * deliberately not baked into the JWT, so revoking a membership takes effect immediately
 * rather than when the token expires.
 */
export async function loadUserFromToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw unauthenticated('Invalid or expired session');
  }
  const user = await User.findById(payload.sub).lean();
  if (!user) throw unauthenticated('Invalid or expired session');
  const memberships = await Membership.find({ user: user._id }).lean();
  user.roles = new Map(memberships.map((m) => [String(m.team), m.role]));
  return user;
}

export function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthenticated());
  loadUserFromToken(token)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(next);
}
