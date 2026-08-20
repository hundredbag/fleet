export type PublicOperationErrorCode =
  'TARGET_UNAVAILABLE' | 'UNSUPPORTED_OPERATION' | 'INVALID_ARGUMENT' | 'REQUEST_REJECTED';

/** A core error whose public classification is part of the API contract. */
export class FleetOperationError extends Error {
  override name = 'FleetOperationError';

  constructor(
    readonly publicCode: PublicOperationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
