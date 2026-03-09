import pino from 'pino';
import { config, isDev } from '../config';

/**
 * Pino logger options shared between the root logger and Fastify's logger.
 *
 * Exported so app.ts can pass this directly to `Fastify({ logger: pinoOptions })`.
 * Fastify then creates its own Pino instance internally — typed correctly as
 * FastifyBaseLogger — avoiding the structural type mismatch that occurs when
 * a pre-built pino.Logger instance is passed to the Fastify constructor.
 *
 * The root `logger` below uses the same options for non-request-scoped events
 * (startup, shutdown, DB connection, worker events). Both loggers produce
 * identically formatted output.
 */
export const pinoOptions: pino.LoggerOptions = {
  level: config.LOG_LEVEL,

  // Every log line carries these fields regardless of where the logger is used.
  base: {
    service: 'image-resizer',
    env: config.NODE_ENV,
  },

  timestamp: pino.stdTimeFunctions.isoTime,

  // Redact sensitive fields before the log line is written to stdout.
  // Fastify logs request headers on every request — Authorization and Cookie
  // are the highest-risk headers. Additional paths use wildcard patterns to
  // catch nested occurrences regardless of object depth.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      '*.password',
      '*.token',
      '*.secret',
      '*.accessKey',
      '*.secretKey',
    ],
    censor: '[REDACTED]',
  },

  serializers: {
    // Standard Pino serializers produce consistent, safe shapes for errors,
    // request objects, and response objects. errWithCause includes the full
    // cause chain so wrapped errors are not silently swallowed.
    err: pino.stdSerializers.errWithCause,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },

  // In development: use pino-pretty transport for human-readable output.
  // Declared inline so the same config is used by both the root logger and
  // Fastify's internal logger.
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
        singleLine: false,
      },
    },
  }),
};

/**
 * Root application logger — for process-level events outside the request
 * lifecycle: startup, shutdown, DB/Redis connection events, worker events.
 *
 * For request-scoped logging inside Fastify routes, always use `req.log`
 * instead — it is a Pino child logger already bound to the request ID.
 */
export const logger = pino(pinoOptions);

/**
 * Creates a child logger pre-bound to a fixed set of context fields.
 * Use at module level in long-lived services (e.g. the worker) so every log
 * line from that module carries the context without repeating it at each site.
 *
 * Example:
 *   const log = childLogger({ module: 'image-worker' });
 *   log.info({ jobId }, 'Job started');
 */
export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
