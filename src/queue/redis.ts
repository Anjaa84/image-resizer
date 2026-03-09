import IORedis from 'ioredis';
import { config } from '../config';
import { logger } from '../lib/logger';

/**
 * Shared IORedis connection used by:
 *   - @fastify/rate-limit (API process)
 *   - BullMQ Queue (API process — enqueueing)
 *   - BullMQ Worker (worker process — dequeueing)
 *
 * `maxRetriesPerRequest: null` is mandatory for BullMQ. It tells IORedis to
 * retry a command indefinitely on connection failure rather than rejecting
 * after N attempts. BullMQ manages its own retry logic on top of this.
 *
 * This module is imported at the top level of both the API and worker entry
 * points, so the connection is established when the process starts.
 */
export const redisConnection = new IORedis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  connectTimeout: 5_000,
  // Keep the connection alive across idle periods. Without this, a TCP
  // firewall or load balancer may silently drop the connection, causing the
  // next command to fail with a misleading ECONNRESET error.
  keepAlive: 10_000,
  // Reconnect with an exponential backoff capped at 30 seconds.
  retryStrategy: (times: number) => Math.min(times * 200, 30_000),
});

redisConnection.on('connect', () => logger.info('Redis connecting'));
redisConnection.on('ready', () => logger.info({ host: config.REDIS_HOST, port: config.REDIS_PORT }, 'Redis ready'));
redisConnection.on('reconnecting', (ms: number) => logger.warn({ ms }, 'Redis reconnecting'));
redisConnection.on('error', (err: Error) => logger.error({ err }, 'Redis error'));
redisConnection.on('close', () => logger.warn('Redis connection closed'));

/** Returns true when the Redis connection is established and ready. */
export function isRedisReady(): boolean {
  return redisConnection.status === 'ready';
}

/**
 * Plain connection options for BullMQ.
 *
 * BullMQ bundles its own copy of ioredis internally, so passing the
 * `redisConnection` instance above (from the top-level `ioredis` package)
 * causes a structural type mismatch — the two `Redis` classes are nominally
 * different even though they are functionally identical.
 *
 * Passing a plain options object instead lets BullMQ create its own IORedis
 * connection, avoiding the conflict entirely. BullMQ's connection is used
 * only for queue operations; the `redisConnection` above is used for rate
 * limiting and health checks.
 */
export const bullMQConnectionOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null as null, // required by BullMQ
} as const;
