/**
 * Application entry point.
 *
 * Responsibilities:
 *   1. Guard against process-level errors before any application code runs.
 *   2. Execute the startup sequence in dependency order.
 *   3. Register graceful shutdown handlers with a hard timeout fallback.
 *
 * This file is intentionally thin. It delegates everything to focused modules:
 *   - config     → validates environment
 *   - db/mongoose → manages the MongoDB connection lifecycle
 *   - app        → builds and configures the Fastify instance
 *   - logger     → structured logging
 */

import { config } from './config';
import { buildApp } from './app';
import { connectDB, disconnectDB } from './db/mongoose';
import { redisConnection } from './queue/redis';
import { closeImageQueue } from './queue/image.queue';
import { logger } from './lib/logger';

// ─── Process-Level Error Guards ───────────────────────────────────────────────
// Register these before any async code runs so no error can escape silently.

process.on('uncaughtException', (err: Error) => {
  // An uncaught exception means the process is in an unknown state.
  // Log and exit immediately — do not attempt recovery.
  logger.fatal({ err }, 'Uncaught exception — exiting');
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  // Treat unhandled promise rejections the same as uncaught exceptions.
  // Node.js will make this the default behaviour in a future major version.
  logger.fatal({ reason }, 'Unhandled promise rejection — exiting');
  process.exit(1);
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  logger.info(
    {
      env: config.NODE_ENV,
      port: config.PORT,
      logLevel: config.LOG_LEVEL,
    },
    'Starting image-resizer API',
  );

  // ── Step 1: Database connection ─────────────────────────────────────────
  // Connect before binding the HTTP port. The /ready endpoint reports the
  // DB state, so the server should not declare itself ready until the initial
  // connection attempt has been made (success or failure is both valid state).
  await connectDB();

  // ── Step 2: Redis connection ─────────────────────────────────────────────
  // The IORedis connection is established at module-import time (queue/redis.ts
  // instantiates the client when imported). By the time we reach this point the
  // connection handshake is in progress. We do not await it explicitly because:
  //   a) @fastify/rate-limit handles a non-ready Redis gracefully (in-memory fallback)
  //   b) BullMQ retries indefinitely (maxRetriesPerRequest: null)
  //   c) The /ready endpoint reflects the true Redis state to the orchestrator
  //
  // Logging the status here provides visibility into the startup timeline.
  logger.info({ status: redisConnection.status }, 'Redis connection status at startup');

  // ── Step 3: Build Fastify app ─────────────────────────────────────────────
  const app = await buildApp();

  // ── Step 4: Bind to port ──────────────────────────────────────────────────
  await app.listen({ port: config.PORT, host: config.HOST });

  // Fastify logs the listen address via req.log.info internally.
  // Log our own line with structured fields for dashboards.
  logger.info({ host: config.HOST, port: config.PORT }, 'HTTP server listening');

  // ── Graceful Shutdown ─────────────────────────────────────────────────────
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    // Guard against double-shutdown if multiple signals arrive in quick
    // succession (e.g., two SIGTERMs or SIGTERM + SIGINT from Docker Compose).
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received — starting graceful shutdown');

    // Set a hard timeout. If the graceful shutdown takes longer than
    // SHUTDOWN_TIMEOUT_MS (e.g., a stuck in-flight request that never
    // resolves), force-exit to avoid the process hanging indefinitely.
    // This is critical in container environments where the orchestrator
    // sends SIGKILL after a fixed period anyway.
    const forceExitTimer = setTimeout(() => {
      logger.fatal(
        { timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
        'Graceful shutdown timed out — forcing exit',
      );
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);

    // Ensure this timer does not keep the event loop alive by itself.
    // If shutdown completes before the timeout, we clearTimeout and exit cleanly.
    forceExitTimer.unref();

    try {
      // Stop accepting new HTTP connections and wait for in-flight requests
      // to complete. Fastify internally sets a close hook on the server.
      await app.close();
      logger.info('HTTP server closed');

      // Drain in-flight enqueue operations before closing Redis.
      // Any queue.add() calls triggered by the last batch of HTTP requests
      // must complete before the connection drops.
      await closeImageQueue();
      logger.info('Image queue closed');

      // Close the MongoDB connection after the HTTP server is closed.
      // This order ensures no in-flight request attempts a DB operation
      // after the connection is gone.
      await disconnectDB();
      logger.info('MongoDB connection closed');

      // Close the Redis connection last — after the queue has flushed and
      // the rate-limit plugin has no more pending commands.
      await redisConnection.quit();
      logger.info('Redis connection closed');

      clearTimeout(forceExitTimer);
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.fatal({ err }, 'Error during graceful shutdown — forcing exit');
      process.exit(1);
    }
  }

  // Use .once() — if the signal fires again during shutdown, ignore it.
  // The double-shutdown guard above handles the case where a different
  // signal arrives before shutdown completes.
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

start().catch((err: unknown) => {
  // If the startup sequence itself throws (e.g., DB unreachable at boot,
  // port already in use), log the reason and exit with a non-zero code.
  // The orchestrator will restart the container after the backoff period.
  logger.fatal({ err }, 'Server failed to start');
  process.exit(1);
});
