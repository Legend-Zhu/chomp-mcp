/**
 * Shared error infrastructure — AppError base class.
 *
 * All module-specific errors extend AppError so that callers can catch a
 * single base type and inspect the `category` field for classification
 * (e.g. logging, retry decisions, user-facing messages).
 */

/**
 * Categories used throughout the application to classify errors.
 */
export type ErrorCategory =
  | 'config'
  | 'http_error'
  | 'timeout'
  | 'network'
  | 'parse_error'
  | 'validation'
  | 'unknown';

/**
 * Base application error.
 *
 * Extends the native `Error` and adds a `category` discriminator so that
 * upstream handlers can branch on error type without instanceof chains.
 */
export class AppError extends Error {
  /** Classification of the error for handling/logging. */
  readonly category: ErrorCategory;

  constructor(message: string, category: ErrorCategory = 'unknown') {
    super(message);
    this.name = 'AppError';
    this.category = category;

    // Maintain a proper prototype chain when targeting ES5/ES2015.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
