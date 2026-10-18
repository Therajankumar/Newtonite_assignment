import mongoose from 'mongoose';

export const isObjectId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v) && /^[a-f0-9]{24}$/i.test(v);
export const toObjectId = (v) => new mongoose.Types.ObjectId(String(v));
export const sameId = (a, b) => a != null && b != null && String(a._id ?? a) === String(b._id ?? b);
