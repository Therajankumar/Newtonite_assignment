import mongoose from 'mongoose';

const teamSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, uppercase: true, trim: true }, // e.g. "PAY", used in item keys
    name: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

teamSchema.index({ key: 1 }, { unique: true });

export const Team = mongoose.model('Team', teamSchema);
