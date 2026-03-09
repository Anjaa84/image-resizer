import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { pinoOptions } from './lib/logger';
import { errorHandler, notFoundHandler } from './lib/error-handler';
import { healthRoutes } from './api/v1/health.routes';
import { imageRoutes } from './api/v1/images.routes';
import { redisConnection } from './queue/redis';

/**
 * Builds and configures the Fastify application instance.
 *
 * Separated from the server entry point (server.ts) so the app can be
 * imported and tested in isolation without binding to a port.
 *
 * Composition order matters:
 *   1. Create instance (genReqId, logger, options)
 *   2. Register plugins  ← plugins may depend on each other; order is scoped
 *   3. Register hooks    ← run on every request/response
 *   4. Register handlers ← error + not-found
 *   5. Register routes   ← business routes added in future phases
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Pass Pino options (not a pre-built instance) so Fastify creates its own
    // logger typed as FastifyBaseLogger. Passing a pino.Logger instance directly
    // widens the FastifyInstance generic to Logger<CustomMixins>, causing type
    // mismatches with plugins and helper types throughout the codebase.
    // Both loggers (root and Fastify's) share the same pinoOptions, so output
    // format, level, redaction, and serializers are identical.
    logger: pinoOptions,

    // Trust the X-Forwarded-For header from the reverse proxy for accurate
    // client IP logging and rate limiting. Set to the number of trusted
    // proxy hops in production (e.g., 1 for a single ALB/nginx layer).
    trustProxy: true,

    // Generate a UUID v4 for every request. If the caller supplies an
    // X-Request-Id header (e.g., set by a load balancer or API gateway), use
    // that value instead so the same ID flows through the entire request chain.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && incoming.length > 0) return incoming;
      return crypto.randomUUID();
    },

    // Disable automatic HEAD routes — opt-in only where GET endpoints exist.
    exposeHeadRoutes: false,

    // Return the exact Fastify version in error responses from plugins.
    // Disable in production to avoid leaking implementation details.
    return503OnClosing: true,
  });

  // ── Plugins ──────────────────────────────────────────────────────────────
  // Plugins registered here are available globally (no encapsulation scope).

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB hard cap; enforced before Sharp sees the file
      files: 1,                    // one file per upload request
      fields: 0,                   // no non-file form fields expected on upload routes
    },
    // Attach file to req.file() rather than consuming the stream eagerly.
    // This allows the handler to decide whether to process or reject the file
    // before writing anything to disk.
    attachFieldsToBody: false,
  });

  await app.register(rateLimit, {
    // Backed by Redis so limits are shared across all API replicas.
    // Falls back to in-memory if Redis is unavailable (soft degradation).
    redis: redisConnection,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,

    // Rate limit by client IP. In production behind a proxy, Fastify resolves
    // the real IP from X-Forwarded-For because trustProxy: true is set above.
    keyGenerator: (req) => req.ip,

    // Return a consistent error shape matching the rest of the API.
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${context.after}.`,
      code: 'RATE_LIMIT_EXCEEDED',
    }),
  });

  // ── Hooks ────────────────────────────────────────────────────────────────

  /**
   * Echo the request ID back to the client on every response.
   * This allows clients (and support engineers) to correlate a failed response
   * with a specific log line by submitting the header value.
   */
  app.addHook('onSend', async (req, reply) => {
    void reply.header('X-Request-Id', req.id);
  });

  /**
   * Log a structured completion line for every request.
   *
   * Fastify's default access log (logged at request start by the logger
   * integration) does not include response time or status code. This hook
   * provides a single log line per request with all the fields needed for
   * dashboards and alerting — without duplicating the per-request start log.
   *
   * req.log is a Pino child logger already bound to { reqId } so the request
   * ID is included automatically without explicit passing.
   */
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        method: req.method,
        url: req.routeOptions?.url ?? req.url,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime.toFixed(2),
        contentLength: reply.getHeader('content-length'),
        ip: req.ip,
      },
      'request completed',
    );
  });

  // ── Error Handlers ───────────────────────────────────────────────────────

  // Central error handler — maps AppError subclasses, Fastify errors, and
  // unexpected errors to the standard error response shape.
  app.setErrorHandler(errorHandler);

  // 404 handler — called when no route matches. Must be registered after
  // setErrorHandler so it participates in the same encapsulation scope.
  app.setNotFoundHandler(notFoundHandler);

  // ── Routes ───────────────────────────────────────────────────────────────

  // Infrastructure routes — unversioned, at root level.
  await app.register(healthRoutes);

  // Business module routes
  await app.register(imageRoutes, { prefix: `/api/${config.API_VERSION}/images` });
  // await app.register(jobRoutes, { prefix: `/api/${config.API_VERSION}/jobs` });

  return app;
}
