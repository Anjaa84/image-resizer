/**
 * Explicit index creation script for production deployments.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Mongoose's `autoIndex: true` (the default) creates indexes automatically
 * when a model is first loaded. This is fine for development — you get indexes
 * without thinking about it. It is dangerous in production for two reasons:
 *
 *   1. Index builds on large collections hold a write lock (pre-MongoDB 4.2)
 *      or consume significant I/O (background builds in 4.2+). Running them
 *      implicitly during application startup can cause latency spikes in
 *      production traffic.
 *
 *   2. `autoIndex` calls `createIndex`, which is idempotent for unchanged
 *      indexes but will error if an index definition changed (e.g., you added
 *      a `unique` constraint to an existing non-unique index that has duplicate
 *      values). You want to see that error explicitly in a migration step, not
 *      buried in application startup logs.
 *
 * This script is run once as a migration step (e.g., in CI before deployment
 * or as a Kubernetes init container) with `autoIndex: false` on all models.
 * It calls `syncIndexes()`, which creates missing indexes and drops indexes
 * that are no longer defined in the schema.
 *
 * USAGE
 * ─────
 *   npx ts-node src/db/indexes.ts
 *   # or after build:
 *   node dist/db/indexes.js
 */

import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from '../lib/logger';

// Import models to register their schemas with Mongoose before syncing.
// syncIndexes() operates on all registered models.
import { AssetModel } from '../modules/images/asset.model';
import { JobModel } from '../modules/jobs/job.model';

async function syncIndexes(): Promise<void> {
  logger.info('Connecting to MongoDB for index sync...');
  await mongoose.connect(config.MONGO_URI);

  const models = [
    { name: 'Asset', model: AssetModel },
    { name: 'Job', model: JobModel },
  ];

  for (const { name, model } of models) {
    logger.info(`Syncing indexes for collection: ${name}`);
    try {
      await model.syncIndexes();
      logger.info(`Indexes synced for: ${name}`);
    } catch (err) {
      logger.error({ err }, `Failed to sync indexes for: ${name}`);
      throw err;
    }
  }

  await mongoose.disconnect();
  logger.info('Index sync complete. Disconnected from MongoDB.');
}

syncIndexes().catch((err) => {
  logger.fatal({ err }, 'Index sync failed');
  process.exit(1);
});
