import { GhuriError, HttpError } from '@ghuri/core'

/** Base class of billing errors. */
export class BillingError extends GhuriError {}

/** The payment provider refused a request or could not be reached. */
export class ProviderError extends BillingError {
  /** HTTP status of the provider's response (0 when the request did not complete). */
  readonly status: number
  /** The provider's error code (`resource_missing`, `card_declined`, …), if any. */
  readonly code?: string
  /** The provider's error type (`invalid_request_error`, …), if any. */
  readonly type?: string

  constructor(
    message: string,
    opts: { status?: number; code?: string; type?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause })
    this.status = opts.status ?? 0
    this.code = opts.code
    this.type = opts.type
  }
}

/** A webhook's signature is missing, malformed, wrong or too old (400). */
export class SignatureVerificationError extends HttpError {
  override status = 400
  constructor(message = 'Invalid webhook signature.') {
    super(message)
  }
}

/** The request has no subscriber (`BILLING.SUBSCRIBER` returned nothing): not logged in, no tenant. */
export class NoSubscriber extends BillingError {}
