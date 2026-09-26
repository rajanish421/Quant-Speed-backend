const { db } = require('./firebase_admin');
const razorpayClient = require('./razorpay_client');
const { RAZORPAY_PLANS, getRazorpayPlanId } = require('../config/razorpay_plans');
const { calculateIsPremium, getPlanDurationDays } = require('./subscription_service');

class WebhookService {
  /**
   * Processes an incoming Razorpay Webhook event.
   */
  async processWebhookEvent({ rawBody, signature, eventPayload, eventIdHeader }) {
    // 1. Verify Webhook Signature using RAW Body and Secret
    const isValid = razorpayClient.verifyWebhookSignature({
      rawBody,
      signature,
    });

    if (!isValid) {
      console.error('[WEBHOOK] Invalid X-Razorpay-Signature header.');
      throw new Error('Invalid webhook signature');
    }

    const event = typeof eventPayload === 'string' ? JSON.parse(eventPayload) : eventPayload;
    const eventId = eventIdHeader || event.event_id || event.id || `evt_${Date.now()}`;
    const eventType = event.event;

    console.log(`[WEBHOOK] Received event: ${eventType} (ID: ${eventId})`);

    // 2. Idempotency Check using eventId
    if (db) {
      try {
        const eventDocRef = db.doc(`webhook_events/${eventId}`);
        const eventDoc = await eventDocRef.get();
        if (eventDoc.exists) {
          console.log(`[WEBHOOK] Event ${eventId} was already processed. Skipping for idempotency.`);
          return { success: true, duplicate: true, eventId, eventType };
        }
      } catch (err) {
        console.warn('[WEBHOOK] Idempotency read warning:', err.message);
      }
    }

    // 3. Extract Subscription & Payment Entities
    const subEntity = event.payload && event.payload.subscription ? event.payload.subscription.entity : null;
    const paymentEntity = event.payload && event.payload.payment ? event.payload.payment.entity : null;

    if (!subEntity && !paymentEntity) {
      console.log(`[WEBHOOK] Event ${eventType} has no subscription or payment entity. Acknowledged.`);
      await this._recordProcessedEvent(eventId, eventType, null, 'no_entity');
      return { success: true, eventId };
    }

    const subscriptionId = subEntity ? subEntity.id : (paymentEntity && paymentEntity.subscription_id);

    if (!subscriptionId) {
      console.log(`[WEBHOOK] Event ${eventType} is not linked to a subscription ID.`);
      await this._recordProcessedEvent(eventId, eventType, null, 'non_subscription_payment');
      return { success: true, eventId };
    }

    let uid = subEntity && subEntity.notes && subEntity.notes.uid;

    // Fallback 1: Look up user UID in Firestore subscriptions mapping
    if (!uid && db) {
      try {
        const mappingDoc = await db.doc(`subscriptions/${subscriptionId}`).get();
        if (mappingDoc.exists) {
          uid = mappingDoc.data().uid;
        }
      } catch (err) {
        console.warn('[WEBHOOK] UID mapping lookup warning:', err.message);
      }
    }

    // Fallback 2: Search by user's current subscriptionId in users collection
    if (!uid && db) {
      try {
        const subGroupSnap = await db.collectionGroup('subscription')
          .where('subscriptionId', '==', subscriptionId)
          .limit(1)
          .get();

        if (!subGroupSnap.empty) {
          const docRef = subGroupSnap.docs[0].ref;
          // Path: users/{uid}/subscription/current -> parent.parent.id is uid
          if (docRef.parent && docRef.parent.parent) {
            uid = docRef.parent.parent.id;
            console.log(`[WEBHOOK] Resolved UID ${uid} via collectionGroup search for ${subscriptionId}`);
          }
        }
      } catch (err) {
        console.warn('[WEBHOOK] CollectionGroup search notice:', err.message);
      }
    }

    // Fallback 3: Search users collection by customer email
    if (!uid && db) {
      try {
        const email = (subEntity && (subEntity.customer_email || subEntity.email)) || (paymentEntity && paymentEntity.email);
        if (email) {
          const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
          if (!userSnap.empty) {
            uid = userSnap.docs[0].id;
            console.log(`[WEBHOOK] Resolved UID ${uid} via email (${email}) for subscription ${subscriptionId}`);
          }
        }
      } catch (err) {
        console.warn('[WEBHOOK] Email search lookup notice:', err.message);
      }
    }

    if (!uid) {
      console.warn(`[WEBHOOK] Could not find user UID for subscription: ${subscriptionId}.`);
      await this._recordProcessedEvent(eventId, eventType, subscriptionId, 'missing_uid');
      return { success: true, eventId, note: 'unmapped_subscription' };
    }

    // 4. Handle Subscription Lifecycle Events
    await this._handleSubscriptionLifecycle({
      uid,
      eventId,
      eventType,
      subscriptionId,
      subEntity,
      paymentEntity,
    });

    // 5. Mark Event Processed for Idempotency
    await this._recordProcessedEvent(eventId, eventType, subscriptionId, 'processed');

    return { success: true, eventId, eventType, uid, subscriptionId };
  }

  async _handleSubscriptionLifecycle({ uid, eventId, eventType, subscriptionId, subEntity, paymentEntity }) {
    if (!db) return;

    // Resolve planId
    let planId = subEntity && subEntity.notes && subEntity.notes.planId;
    if (!planId && subEntity && subEntity.plan_id) {
      for (const [key] of Object.entries(RAZORPAY_PLANS)) {
        if (getRazorpayPlanId(key) === subEntity.plan_id) {
          planId = key;
          break;
        }
      }
    }

    const durationDays = getPlanDurationDays(planId);
    const currentStart = (subEntity && subEntity.current_start) ? new Date(subEntity.current_start * 1000) : new Date();
    const currentEnd = (subEntity && subEntity.current_end)
      ? new Date(subEntity.current_end * 1000)
      : new Date(currentStart.getTime() + durationDays * 86400000);
    const nextChargeAt = (subEntity && subEntity.charge_at) ? new Date(subEntity.charge_at * 1000) : currentEnd;
    const endedAt = (subEntity && subEntity.ended_at) ? new Date(subEntity.ended_at * 1000) : null;

    let status = (subEntity && subEntity.status) || 'active';

    switch (eventType) {
      case 'subscription.authenticated':
        status = 'authenticated';
        console.log(`[WEBHOOK] Subscription authenticated: ${subscriptionId} for ${uid}`);
        break;

      case 'subscription.activated':
      case 'subscription.resumed':
        status = 'active';
        console.log(`[WEBHOOK] Subscription active/resumed: ${subscriptionId} for ${uid}`);
        break;

      case 'subscription.charged':
        status = 'active';
        console.log(`[WEBHOOK] Recurring subscription charged: ${subscriptionId} for ${uid}`);
        break;

      case 'subscription.pending':
        status = 'pending';
        console.log(`[WEBHOOK] Subscription pending payment retry: ${subscriptionId}`);
        break;

      case 'subscription.halted':
        status = 'halted';
        console.log(`[WEBHOOK] Subscription halted (retries exhausted): ${subscriptionId}`);
        break;

      case 'subscription.paused':
        status = 'paused';
        console.log(`[WEBHOOK] Subscription paused from Dashboard: ${subscriptionId}`);
        break;

      case 'subscription.cancelled':
        status = 'cancelled';
        console.log(`[WEBHOOK] Subscription cancelled: ${subscriptionId}`);
        break;

      case 'subscription.completed':
        status = 'completed';
        console.log(`[WEBHOOK] Subscription completed all cycles: ${subscriptionId}`);
        break;

      case 'subscription.updated':
        console.log(`[WEBHOOK] Subscription updated: ${subscriptionId}`);
        break;

      case 'payment.failed':
        console.warn(`[WEBHOOK] Payment failed for subscription: ${subscriptionId}`);
        break;

      default:
        console.log(`[WEBHOOK] Event ${eventType} received for subscription: ${subscriptionId}`);
        break;
    }

    // Authoritatively calculate isPremium from Razorpay state
    const isPremium = calculateIsPremium({
      status,
      currentEnd,
      endedAt,
    });

    const updateData = {
      provider: 'razorpay',
      subscriptionId,
      razorpaySubscriptionId: subscriptionId,
      planId: planId || 'plan_1_month',
      razorpayPlanId: (subEntity && subEntity.plan_id) || '',
      status,
      razorpayStatus: status,
      isPremium,
      currentPeriodStart: currentStart,
      currentPeriodEnd: currentEnd,
      nextChargeAt,
      endedAt,
      lastPaymentId: (paymentEntity && paymentEntity.id) || (subEntity && subEntity.payment_id) || '',
      lastWebhookEvent: eventType,
      lastWebhookEventId: eventId,
      updatedAt: new Date(),
    };

    const batch = db.batch();
    const userSubRef = db.doc(`users/${uid}/subscription/current`);
    const subMappingRef = db.doc(`subscriptions/${subscriptionId}`);

    batch.set(userSubRef, updateData, { merge: true });
    batch.set(subMappingRef, {
      uid,
      status,
      razorpayStatus: status,
      isPremium,
      lastWebhookEvent: eventType,
      lastWebhookEventId: eventId,
      updatedAt: new Date(),
    }, { merge: true });

    await batch.commit();
    console.log(`[WEBHOOK] Synced Firestore for ${uid}: status=${status}, isPremium=${isPremium}, event=${eventType}`);
  }

  async _recordProcessedEvent(eventId, eventType, subscriptionId, result) {
    if (!db) return;
    try {
      await db.doc(`webhook_events/${eventId}`).set({
        eventId,
        eventType,
        subscriptionId: subscriptionId || null,
        result,
        processedAt: new Date(),
      });
    } catch (e) {
      console.warn('[WEBHOOK] Failed to record event audit:', e.message);
    }
  }
}

module.exports = new WebhookService();
