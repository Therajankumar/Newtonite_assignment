import { MongoMemoryReplSet } from 'mongodb-memory-server-core';

// Transactions and change streams need a replica set, so tests use a single-node one.
export default async function setup({ provide }) {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  provide('mongoUri', rs.getUri());
  return async () => rs.stop();
}
