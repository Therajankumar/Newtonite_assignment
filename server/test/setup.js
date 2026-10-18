import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import mongoose from 'mongoose';
import { ensureIndexes } from '../src/models/index.js';

process.env.NODE_ENV = 'test';

beforeAll(async () => {
  const dbName = `test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  await mongoose.connect(inject('mongoUri'), { dbName });
  await ensureIndexes();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});
