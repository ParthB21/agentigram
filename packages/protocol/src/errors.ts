/** Thrown by stubs owned by a later part. Convert to a protocol ERROR at process boundaries. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

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
