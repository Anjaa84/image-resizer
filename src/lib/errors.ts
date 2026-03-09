/**
 * Typed application error hierarchy.
 *
 * Rules:
 * - All intentional errors thrown by service/controller code extend AppError.
 * - AppError carries a machine-readable `code` so API clients can switch on it
 *   without parsing the human-readable `message`.
 * - The error handler in src/lib/error-handler.ts maps AppError subclasses to
 *   the appropriate HTTP response without any knowledge of individual subtypes.
 * - Never throw raw Error objects from service code — always throw a subclass.
 */

// ─── Base ─────────────────────────────────────────────────────────────────────

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    // Operational errors are expected, recoverable, and safe to expose to the
    // client. Non-operational errors (programmer mistakes, unexpected states)
    // are caught by the error handler and returned as generic 500s.
    this.isOperational = statusCode < 500;

    // Maintain proper prototype chain in transpiled ES5 output.
    Object.setPrototypeOf(this, new.target.prototype);
    // captureStackTrace is V8-only; guard for non-V8 environments (e.g., tests).
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ─── 4xx Client Errors ────────────────────────────────────────────────────────

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400, 'BAD_REQUEST');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

/**
 * Use when a resource already exists and cannot be created again.
 * Returned by the deduplication layer when a derived asset with the same
 * (sourceAssetId, transformSignature) pair already exists and is processing.
 * In practice the existing asset is returned directly, so this error is
 * reserved for cases where returning the existing resource is not possible.
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

/**
 * Use for failed Zod/business-rule validation that reaches the service layer.
 * HTTP layer (Fastify schema) validation failures are handled separately by
 * the error handler before they reach service code.
 */
export class ValidationError extends AppError {
  constructor(message: string, public readonly details?: unknown) {
    super(message, 422, 'VALIDATION_ERROR');
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super(
      `Payload exceeds the maximum allowed size of ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
      413,
      'PAYLOAD_TOO_LARGE',
    );
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(received: string, supported: string[]) {
    super(
      `Unsupported media type "${received}". Supported types: ${supported.join(', ')}`,
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  }
}

// ─── 5xx Server Errors ────────────────────────────────────────────────────────

export class InternalError extends AppError {
  constructor(message = 'An unexpected error occurred') {
    super(message, 500, 'INTERNAL_ERROR');
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(service: string) {
    super(`Service temporarily unavailable: ${service}`, 503, 'SERVICE_UNAVAILABLE');
  }
}

// ─── Type Guard ───────────────────────────────────────────────────────────────

/**
 * Narrows an unknown thrown value to AppError.
 * Use in catch blocks: `if (isAppError(err)) { ... }`
 */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
