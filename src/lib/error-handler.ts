import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Maps HTTP status codes to their standard reason phrases.
 * Kept local to avoid pulling in an http-status-codes dependency.
 */
function reasonPhrase(statusCode: number): string {
  const phrases: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return phrases[statusCode] ?? 'Unknown Error';
}

// ─── Error Response Shape ─────────────────────────────────────────────────────

/**
 * Every error response from this API has this shape. Clients should switch on
 * `code` (machine-readable) rather than `message` (human-readable, may change).
 */
interface ErrorResponse {
  statusCode: number;
  error: string;    // HTTP reason phrase
  message: string;  // human-readable description
  code: string;     // machine-readable, stable identifier
  requestId: string;
  details?: unknown; // validation error details, present only on 422
}

// ─── Fastify Error Handler ────────────────────────────────────────────────────

/**
 * Centralized Fastify error handler. Registered via `app.setErrorHandler()`.
 *
 * Handles four categories:
 *
 * 1. AppError subclasses  — our own typed errors from service/controller code.
 *    These are operational: use their statusCode and code directly.
 *
 * 2. Fastify validation errors (err.validation)  — produced by Fastify's
 *    JSON Schema validation on route schemas. Mapped to 422 with AJV details.
 *
 * 3. Fastify/plugin HTTP errors (err.statusCode < 500)  — errors from
 *    @fastify/rate-limit (429), @fastify/multipart (400/413), etc.
 *    Safe to forward to the client in our standard shape.
 *
 * 4. Unknown/unexpected errors (everything else)  — 500. The original error
 *    is logged with its full stack but the client receives a generic message.
 *    This prevents leaking internal implementation details.
 */
export function errorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = req.id;

  // ── 1. Our own AppError subclasses ─────────────────────────────────────────
  if (err instanceof AppError) {
    // Operational errors (4xx) are expected; no need to log stack traces.
    // 5xx AppErrors are programmer mistakes and should be investigated.
    if (!err.isOperational) {
      req.log.error({ err }, 'Operational 5xx error');
    }

    const body: ErrorResponse = {
      statusCode: err.statusCode,
      error: reasonPhrase(err.statusCode),
      message: err.message,
      code: err.code,
      requestId,
    };

    if ('details' in err && err.details !== undefined) {
      body.details = (err as { details: unknown }).details;
    }

    reply.code(err.statusCode).send(body);
    return;
  }

  // ── 2. Fastify schema validation errors ────────────────────────────────────
  if (err.validation) {
    reply.code(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'Request validation failed',
      code: 'VALIDATION_ERROR',
      requestId,
      details: err.validation,
    } satisfies ErrorResponse);
    return;
  }

  // ── 3. Known HTTP errors from Fastify plugins (4xx) ────────────────────────
  const statusCode = err.statusCode ?? 500;
  if (statusCode < 500) {
    reply.code(statusCode).send({
      statusCode,
      error: reasonPhrase(statusCode),
      message: err.message,
      code: (err as FastifyError & { code?: string }).code ?? 'HTTP_ERROR',
      requestId,
    } satisfies ErrorResponse);
    return;
  }

  // ── 4. Unexpected errors — log full details, return safe generic response ───
  req.log.error({ err }, 'Unhandled error');
  reply.code(500).send({
    statusCode: 500,
    error: 'Internal Server Error',
    message: 'An unexpected error occurred. Please try again later.',
    code: 'INTERNAL_ERROR',
    requestId,
  } satisfies ErrorResponse);
}

// ─── Not Found Handler ────────────────────────────────────────────────────────

/**
 * Handles requests that match no registered route.
 * Registered via `app.setNotFoundHandler()`.
 *
 * Returns the same error shape as the error handler so clients have a single
 * consistent format to parse regardless of the failure mode.
 */
export function notFoundHandler(req: FastifyRequest, reply: FastifyReply): void {
  reply.code(404).send({
    statusCode: 404,
    error: 'Not Found',
    message: `Route ${req.method} ${req.url} not found`,
    code: 'ROUTE_NOT_FOUND',
    requestId: req.id,
  } satisfies ErrorResponse);
}
