// @ghuri/billing/rest — DRF permission classes for subscriptions.
import { type APIRequest, BasePermission, type PermissionClass } from '@ghuri/rest'
import { hasActiveSubscription, hasFeature } from './access'
import { requestSubscriber, type Subject } from './subscriber'

async function subscriberOf(request: APIRequest): Promise<unknown> {
  return requestSubscriber(request.c, request.user)
}

/**
 * Allows requests whose subscriber (`BILLING.SUBSCRIBER`, default the request user) has an active subscription.
 * `view.requiredPlans` (or the view class's static `requiredPlans`) narrows it to those plans.
 *
 *   class ExportView extends APIView { permissionClasses = [IsAuthenticated, HasActiveSubscription] }
 */
export class HasActiveSubscription extends BasePermission {
  override message = 'An active subscription is required.'
  override code = 'subscription_required'

  override async hasPermission(request: APIRequest, view: any): Promise<boolean> {
    const subscriber = await subscriberOf(request)
    if (!subscriber) return false
    const plans: string[] | undefined = view?.requiredPlans ?? view?.constructor?.requiredPlans
    return hasActiveSubscription(subscriber as Subject, { plans })
  }
}

/** A permission class allowing subscribers whose plan lists `feature`: `permissionClasses = [HasFeature('export')]`. */
export function HasFeature(feature: string): PermissionClass {
  const cls = class extends BasePermission {
    override message = `Your plan does not include '${feature}'.`
    override code = 'feature_not_in_plan'

    override async hasPermission(request: APIRequest): Promise<boolean> {
      const subscriber = await subscriberOf(request)
      return !!subscriber && hasFeature(subscriber as Subject, feature)
    }
  }
  Object.defineProperty(cls, 'name', { value: `HasFeature(${feature})` })
  return cls
}
