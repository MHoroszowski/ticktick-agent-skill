/**
 * errors.ts — error taxonomy + exit code mapping for the CLI.
 *
 * Re-exports the adapter's error primitives so every command can import
 * from one place, and adds `UsageError` for CLI arg-level failures.
 */

import { AdapterError, mapLibraryError } from './adapter.ts';
import type { AdapterErrorCode } from './adapter.ts';

export { AdapterError, mapLibraryError };
export type { AdapterErrorCode };

/**
 * Thrown for CLI arg-parsing / missing-flag failures, before any adapter call.
 * Exit code 2 — usage error.
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Map an error (of any kind) to the CLI exit code.
 *
 *   1  UNEXPECTED or any non-typed error
 *   2  UsageError
 *   3  AUTH_MISSING_CREDS / AUTH_FAILED / AUTH_EXPIRED
 *   4  NOT_FOUND
 *   5  NETWORK / RATE_LIMITED
 *   6  VALIDATION
 */
export function getExitCode(err: unknown): number {
  if (err instanceof UsageError) return 2;
  if (err instanceof AdapterError) {
    switch (err.code) {
      case 'AUTH_MISSING_CREDS':
      case 'AUTH_FAILED':
      case 'AUTH_EXPIRED':
        return 3;
      case 'NOT_FOUND':
        return 4;
      case 'NETWORK':
      case 'RATE_LIMITED':
        return 5;
      case 'VALIDATION':
        return 6;
      case 'UNEXPECTED':
      default:
        return 1;
    }
  }
  return 1;
}
