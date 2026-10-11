/** Thrown when untrusted input fails schema validation. */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}
