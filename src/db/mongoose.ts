import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from '../lib/logger';

// Flag that ensures connection event listeners are registered only once,
// even if connectDB() is called more than once (e.g., in tests).
let listenersRegistered = false;

function registerConnectionListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  mongoose.connection.on('connected', () =>
    logger.info({ uri: redactUri(config.MONGO_URI) }, 'MongoDB connected'),
  );
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
}

/**
 * Redacts the credentials portion of a MongoDB URI for safe logging.
 * mongodb://user:password@host/db → mongodb://[REDACTED]@host/db
 */
function redactUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.password) url.password = '[REDACTED]';
    if (url.username) url.username = '[REDACTED]';
    return url.toString();
  } catch {
    return '[invalid URI]';
  }
}

export async function connectDB(): Promise<void> {
  registerConnectionListeners();

  await mongoose.connect(config.MONGO_URI, {
    // Fail fast if MongoDB is not reachable at startup instead of hanging.
    serverSelectionTimeoutMS: 5_000,

    // Fail fast on socket-level timeouts for individual operations.
    socketTimeoutMS: 30_000,

    // Disable Mongoose's internal command buffering. Without this, operations
    // issued while the connection is down are silently queued and may execute
    // long after the caller has moved on, causing hard-to-trace bugs.
    // With bufferCommands: false, operations fail immediately if not connected.
    bufferCommands: false,
  });
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected gracefully');
}

/** Returns true if the Mongoose connection is currently established. */
export function isDBConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
