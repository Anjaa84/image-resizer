import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { runReadinessChecks } from '../../lib/health.service';

/**
 * Liveness and readiness probe routes.
 *
 * These two endpoints serve distinct purposes in a containerised deployment
 * and must not be conflated:
 *
 * GET /health — LIVENESS
 *   "Is this process alive and able to respond to HTTP requests?"
 *   If this returns a non-200, the orchestrator (Kubernetes, ECS) restarts
 *   the container. It must NEVER check external dependencies — if MongoDB
 *   goes down, we do not want every API pod restarted in a cascade.
 *   Returns 200 unconditionally as long as the event loop is running.
 *
 * GET /ready — READINESS
 *   "Is this process ready to serve production traffic?"
 *   If this returns non-200, the load balancer stops routing traffic to this
 *   instance (but does NOT restart it). Checks all critical dependencies.
 *   Returns 503 if any required dependency is unreachable.
 *
 * Both routes are intentionally outside the /api/v1 prefix — health probes
 * are an infrastructure concern, not a versioned API concern. Load balancers
 * and orchestrators expect them at well-known root paths.
 */

// ─── Response JSON schemas ────────────────────────────────────────────────────
// Declared as Fastify route schemas so fast-json-stringify serialises the
// response without reflection — a free throughput gain on frequently-polled
// endpoints.

const livenessResponseSchema = {
  200: {
    type: 'object',
    required: ['status', 'uptime', 'timestamp'],
    properties: {
      status:    { type: 'string' },
      uptime:    { type: 'number' },
      timestamp: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const;

// Shared shape for each dependency check result
const checkResultSchema = {
  type: 'object',
  required: ['status', 'latencyMs'],
  properties: {
    status:    { type: 'string', enum: ['ok', 'unavailable'] },
    latencyMs: { type: 'number' },
    error:     { type: 'string' }, // omitted when status is 'ok'
  },
  additionalProperties: false,
} as const;

const readinessBody = {
  type: 'object',
  required: ['status', 'checks', 'timestamp'],
  properties: {
    status: { type: 'string' },
    checks: {
      type: 'object',
      required: ['mongo', 'redis', 'storage'],
      properties: {
        mongo:   checkResultSchema,
        redis:   checkResultSchema,
        storage: checkResultSchema,
      },
      additionalProperties: false,
    },
    timestamp: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const readinessResponseSchema = { 200: readinessBody, 503: readinessBody } as const;

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function livenessHandler(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // No dependency checks — if this executes, the process is alive.
  await reply.send({
    status:    'ok',
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

async function readinessHandler(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { ready, checks } = await runReadinessChecks();

  await reply.code(ready ? 200 : 503).send({
    status:    ready ? 'ready' : 'not ready',
    checks,
    timestamp: new Date().toISOString(),
  });
}

// ─── Route registration ───────────────────────────────────────────────────────

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/health',
    { schema: { response: livenessResponseSchema } },
    livenessHandler,
  );

  fastify.get(
    '/ready',
    { schema: { response: readinessResponseSchema } },
    readinessHandler,
  );
}
