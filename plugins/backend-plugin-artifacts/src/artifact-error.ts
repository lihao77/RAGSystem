export class ArtifactServiceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ArtifactServiceError";
    this.statusCode = statusCode;
  }
}
