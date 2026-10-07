/** A path that the storage backend has confirmed does not exist. */
export class NotFoundError extends Error {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(`File not found: ${path}`, options);
    this.name = "NotFoundError";
    this.path = path;
  }
}

/** Also recognizes errors from another loaded copy of StaticQL. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof NotFoundError || (
    typeof error === "object" && error !== null &&
    "name" in error && error.name === "NotFoundError"
  );
}
