export class HttpError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = options.details;
  }
}

export function asHttpError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(
    500,
    "internal_error",
    "Une erreur interne est survenue.",
    { cause: error },
  );
}
