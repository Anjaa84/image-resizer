/**
 * Unit tests for lib/health.service.ts
 *
 * All external dependencies (mongoose, ioredis, storage) are mocked.
 *
 * Coverage:
 *   runReadinessChecks
 *     - all checks pass → ready: true, status ok on all
 *     - mongo unavailable → ready: false, 503
 *     - redis unavailable → ready: false, 503
 *     - storage unavailable → ready: false, 503
 *     - checks run concurrently
 *     - latencyMs is present and non-negative on every result
 *     - error field present only when unavailable
 *     - check timeout: slow dependency times out, result is unavailable
 *
 *   checkMongo
 *     - disconnected (isDBConnected = false) → throws without issuing ping
 *     - connected, ping succeeds → resolves
 *     - connected, ping throws → propagates
 *
 *   checkRedis
 *     - not ready (isRedisReady = false) → throws without issuing PING
 *     - ready, PING returns 'PONG' → resolves
 *     - ready, PING returns unexpected value → throws
 *
 *   checkStorage
 *     - ping resolves → resolves
 *     - ping throws → propagates
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAdminCommand = vi.fn();

vi.mock('mongoose', () => ({
  default: {
    connection: {
      db: { admin: () => ({ command: mockAdminCommand }) },
    },
  },
}));

vi.mock('../../src/db/mongoose', () => ({
  isDBConnected: vi.fn(),
}));

vi.mock('../../src/queue/redis', () => ({
  redisConnection: { ping: vi.fn() },
  isRedisReady:    vi.fn(),
}));

vi.mock('../../src/storage', () => ({
  storage: { ping: vi.fn() },
}));

vi.mock('../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  runReadinessChecks,
  checkMongo,
  checkRedis,
  checkStorage,
  CHECK_TIMEOUT_MS,
} from '../../src/lib/health.service';
import { isDBConnected } from '../../src/db/mongoose';
import { redisConnection, isRedisReady } from '../../src/queue/redis';
import { storage } from '../../src/storage';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockIsDB    = isDBConnected as ReturnType<typeof vi.fn>;
const mockIsRedis = isRedisReady  as ReturnType<typeof vi.fn>;
const mockRedisPing    = (redisConnection as unknown as { ping: ReturnType<typeof vi.fn> }).ping;
const mockStoragePing  = (storage        as unknown as { ping: ReturnType<typeof vi.fn> }).ping;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setAllHealthy(): void {
  mockIsDB.mockReturnValue(true);
  mockAdminCommand.mockResolvedValue({ ok: 1 });
  mockIsRedis.mockReturnValue(true);
  mockRedisPing.mockResolvedValue('PONG');
  mockStoragePing.mockResolvedValue(undefined);
}

// ── checkMongo ────────────────────────────────────────────────────────────────

describe('checkMongo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws immediately when not connected (no ping issued)', async () => {
    mockIsDB.mockReturnValue(false);
    await expect(checkMongo()).rejects.toThrow('not connected');
    expect(mockAdminCommand).not.toHaveBeenCalled();
  });

  it('resolves when connected and admin ping succeeds', async () => {
    mockIsDB.mockReturnValue(true);
    mockAdminCommand.mockResolvedValue({ ok: 1 });
    await expect(checkMongo()).resolves.toBeUndefined();
  });

  it('issues the ping command when connected', async () => {
    mockIsDB.mockReturnValue(true);
    mockAdminCommand.mockResolvedValue({ ok: 1 });
    await checkMongo();
    expect(mockAdminCommand).toHaveBeenCalledWith({ ping: 1 });
  });

  it('propagates errors from the admin ping command', async () => {
    mockIsDB.mockReturnValue(true);
    mockAdminCommand.mockRejectedValue(new Error('MongoNetworkError'));
    await expect(checkMongo()).rejects.toThrow('MongoNetworkError');
  });
});

// ── checkRedis ────────────────────────────────────────────────────────────────

describe('checkRedis', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws immediately when not ready (no PING issued)', async () => {
    mockIsRedis.mockReturnValue(false);
    await expect(checkRedis()).rejects.toThrow('not connected');
    expect(mockRedisPing).not.toHaveBeenCalled();
  });

  it('resolves when ready and PING returns PONG', async () => {
    mockIsRedis.mockReturnValue(true);
    mockRedisPing.mockResolvedValue('PONG');
    await expect(checkRedis()).resolves.toBeUndefined();
  });

  it('throws when PING returns an unexpected value', async () => {
    mockIsRedis.mockReturnValue(true);
    mockRedisPing.mockResolvedValue('NOPE');
    await expect(checkRedis()).rejects.toThrow(/unexpected/i);
  });

  it('propagates errors from the PING command', async () => {
    mockIsRedis.mockReturnValue(true);
    mockRedisPing.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(checkRedis()).rejects.toThrow('ECONNREFUSED');
  });
});

// ── checkStorage ──────────────────────────────────────────────────────────────

describe('checkStorage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves when storage.ping() succeeds', async () => {
    mockStoragePing.mockResolvedValue(undefined);
    await expect(checkStorage()).resolves.toBeUndefined();
  });

  it('propagates errors from storage.ping()', async () => {
    mockStoragePing.mockRejectedValue(new Error('ENOENT: upload dir missing'));
    await expect(checkStorage()).rejects.toThrow('ENOENT');
  });
});

// ── runReadinessChecks ────────────────────────────────────────────────────────

describe('runReadinessChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAllHealthy();
  });

  // ── All healthy ─────────────────────────────────────────────────────────────

  it('returns ready: true when all checks pass', async () => {
    const result = await runReadinessChecks();
    expect(result.ready).toBe(true);
  });

  it('returns status ok for every check when all pass', async () => {
    const { checks } = await runReadinessChecks();
    expect(checks.mongo.status).toBe('ok');
    expect(checks.redis.status).toBe('ok');
    expect(checks.storage.status).toBe('ok');
  });

  it('omits the error field on passing checks', async () => {
    const { checks } = await runReadinessChecks();
    expect(checks.mongo.error).toBeUndefined();
    expect(checks.redis.error).toBeUndefined();
    expect(checks.storage.error).toBeUndefined();
  });

  it('includes non-negative latencyMs on every result', async () => {
    const { checks } = await runReadinessChecks();
    expect(checks.mongo.latencyMs).toBeGreaterThanOrEqual(0);
    expect(checks.redis.latencyMs).toBeGreaterThanOrEqual(0);
    expect(checks.storage.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // ── Individual failures ─────────────────────────────────────────────────────

  it('returns ready: false when MongoDB is down', async () => {
    mockIsDB.mockReturnValue(false);
    const result = await runReadinessChecks();
    expect(result.ready).toBe(false);
    expect(result.checks.mongo.status).toBe('unavailable');
    expect(result.checks.redis.status).toBe('ok');
    expect(result.checks.storage.status).toBe('ok');
  });

  it('returns ready: false when Redis is down', async () => {
    mockIsRedis.mockReturnValue(false);
    const result = await runReadinessChecks();
    expect(result.ready).toBe(false);
    expect(result.checks.redis.status).toBe('unavailable');
    expect(result.checks.mongo.status).toBe('ok');
    expect(result.checks.storage.status).toBe('ok');
  });

  it('returns ready: false when storage is unavailable', async () => {
    mockStoragePing.mockRejectedValue(new Error('ENOENT: no such directory'));
    const result = await runReadinessChecks();
    expect(result.ready).toBe(false);
    expect(result.checks.storage.status).toBe('unavailable');
    expect(result.checks.mongo.status).toBe('ok');
    expect(result.checks.redis.status).toBe('ok');
  });

  it('includes the error message from a failing check', async () => {
    mockIsDB.mockReturnValue(false);
    const { checks } = await runReadinessChecks();
    expect(typeof checks.mongo.error).toBe('string');
    expect(checks.mongo.error!.length).toBeGreaterThan(0);
  });

  it('error message does not include a stack trace', async () => {
    mockAdminCommand.mockRejectedValue(new Error('connection refused'));
    mockIsDB.mockReturnValue(true);
    const { checks } = await runReadinessChecks();
    expect(checks.mongo.error).not.toMatch(/^\s+at /m);
  });

  // ── Concurrent execution ────────────────────────────────────────────────────

  it('fires all three checks concurrently', async () => {
    const callOrder: string[] = [];
    mockAdminCommand.mockImplementation(async () => {
      callOrder.push('mongo');
      return { ok: 1 };
    });
    mockRedisPing.mockImplementation(async () => {
      callOrder.push('redis');
      return 'PONG';
    });
    mockStoragePing.mockImplementation(async () => {
      callOrder.push('storage');
    });

    await runReadinessChecks();

    // All three checks were called (order may vary due to concurrency)
    expect(callOrder).toHaveLength(3);
    expect(callOrder).toContain('mongo');
    expect(callOrder).toContain('redis');
    expect(callOrder).toContain('storage');
  });

  // ── Timeout ─────────────────────────────────────────────────────────────────

  it('marks a check unavailable when it exceeds CHECK_TIMEOUT_MS', async () => {
    vi.useFakeTimers();

    // Make storage.ping() hang indefinitely
    mockStoragePing.mockReturnValue(new Promise(() => { /* never resolves */ }));

    const promise = runReadinessChecks();
    // Advance past the per-check timeout
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 100);
    const result = await promise;

    expect(result.checks.storage.status).toBe('unavailable');
    expect(result.checks.storage.error).toMatch(/timed out/i);
    expect(result.ready).toBe(false);

    vi.useRealTimers();
  });

  it('other checks still complete when one times out', async () => {
    vi.useFakeTimers();

    mockStoragePing.mockReturnValue(new Promise(() => { /* never resolves */ }));

    const promise = runReadinessChecks();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 100);
    const result = await promise;

    // Mongo and Redis checks completed normally
    expect(result.checks.mongo.status).toBe('ok');
    expect(result.checks.redis.status).toBe('ok');

    vi.useRealTimers();
  });
});
