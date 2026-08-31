const { db } = require('./firebase_admin');
const razorpayClient = require('./razorpay_client');
const { RAZORPAY_PLANS, getRazorpayPlanId } = require('../config/razorpay_plans');

class WebhookService {
  /**
   * Processes an incoming Razorpay Webhook event.
   */
  async processWebhookEvent({ rawBody, signature, eventPayload }) {
    // 1. Verify Webhook Signature using RAW Body
    const isValid = razorpayClient.verifyWebhookSignature({
      rawBody,
      signature,
    });

    if (!isValid) {
      console.error('[WEBHOOK] Invalid X-Razorpay-Signature header.');
      throw new Error('Invalid webhook signature');
    }

    const event = typeof eventPayload === 'string' ? JSON.parse(eventPayload) : eventPayload;
    const eventId = event.event_id || event.id || `evt_${Date.now()}`;
    const eventType = event.event;

    console.log(`[WEBHOOK] Received event: ${eventType} (ID: ${eventId})`);

    // 2. Idempotency Check
    if (db) {
      const eventDocRef = db.doc(`webhook_events/${eventId}`);
      const eventDoc = await eventDocRef.get();
      if (eventDoc.exists) {
        console.log(`[WEBHOOK] Event ${eventId} was already processed. Skipping for idempotency.`);
        return { success: true, duplicate: true, eventId };
      }
    }

    // 3. Extract Subscription Entity & Resolve User UID
    const subEntity = event.payload && event.payload.subscription ? event.payload.subscription.entity : null;
    const paymentEntity = event.payload && event.payload.payment ? event.payload.payment.entity : null;

    if (!subEntity) {
      console.log(`[WEBHOOK] Event ${eventType} has no subscription entity. Acknowledged.`);
      await this._recordProcessedEvent(eventId, eventType, null, 'no_subscription_entity');
      return { success: true, eventId };
    }

    const subscriptionId = subEntity.id;
    let uid = subEntity.notes && subEntity.notes.uid;

    // Fallback: Look up user in Firestore subscriptions mapping
    if (!uid && db) {
      const mappingDoc = await db.doc(`subscriptions/${subscriptionId}`).get();
      if (mappingDoc.exists) {
        uid = mappingDoc.data().uid;
      }
    }

    if (!uid) {
      console.warn(`[WEBHOOK] Could not find user UID for subscription: ${subscriptionId}.`);
      await this._recordProcessedEvent(eventId, eventType, subscriptionId, 'missing_uid');
      return { success: true, eventId, note: 'unmapped_subscription' };
    }

    // 4. Handle Lifecycle Events
    await this._handleSubscriptionLifecycle(uid, eventType, subEntity, paymentEntity);

    // 5. Mark Event Processed for Idempotency
    await this._recordProcessedEvent(eventId, eventType, subscriptionId, 'processed');

    return { success: true, eventId, eventType, uid, subscriptionId };
  }

  async _handleSubscriptionLifecycle(uid, eventType, subEntity, paymentEntity) {
    if (!db) return;

    const subscriptionId = subEntity.id;
    const currentStart = subEntity.current_start ? new Date(subEntity.current_start * 1000) : new Date();
    const currentEnd = subEntity.current_end ? new Date(subEntity.current_end * 1000) : new Date(Date.now() + 30 * 86400000);
    const nextChargeAt = subEntity.charge_at ? new Date(subEntity.charge_at * 1000) : currentEnd;

    // Resolve planId
    let planId = subEntity.notes && subEntity.notes.planId;
    if (!planId) {
      for (const [key] of Object.entries(RAZORPAY_PLANS)) {
        if (getRazorpayPlanId(key) === subEntity.plan_id) {
          planId = key;
          break;
        }
      }
    }

    const batch = db.batch();
    const userSubRef = db.doc(`users/${uid}/subscription/current`);
    const subMappingRef = db.doc(`subscriptions/${subscriptionId}`);

    let status = subEntity.status || 'active';
    let isPremium = true;

    switch (eventType) {
      case 'subscription.authenticated':
      case 'subscription.activated':
      case 'subscription.resumed':
        status = 'active';
        isPremium = true;
        break;

      case 'subscription.charged':
        status = 'active';
        isPremium = true;
        console.log(`[WEBHOOK] Recurring subscription charged successfully: ${subscriptionId} for ${uid}`);
        break;

      case 'subscription.pending':
        status = 'pending';
        // Keep active while retrying during grace period
        isPremium = new Date() < currentEnd;
        break;

      case 'subscription.halted':
        status = 'halted';
        isPremium = false;
        console.log(`[WEBHOOK] Subscription halted (retries exhausted): ${subscriptionId}`);
        break;

      case 'subscription.paused':
        status = 'paused';
        isPremium = false;
        break;

      case 'subscription.cancelled':
        status = 'cancelled';
        // Active until end of current paid cycle
        isPremium = new Date() < currentEnd;
        break;

      case 'subscription.completed':
        status = 'completed';
        isPremium = new Date() < currentEnd;
        break;

      default:
        console.log(`[WEBHOOK] Event ${eventType} recorded for subscription: ${subscriptionId}`);
        break;
    }

    const updateData = {
      provider: 'razorpay',
      subscriptionId,
      planId: planId || 'plan_1_month',
      razorpayPlanId: subEntity.plan_id || '',
      status,
      isPremium,
      currentPeriodStart: currentStart,
      currentPeriodEnd: currentEnd,
      nextChargeAt,
      lastPaymentId: (paymentEntity && paymentEntity.id) || subEntity.payment_id || '',
      lastEvent: eventType,
      updatedAt: new Date(),
    };

    batch.set(userSubRef, updateData, { merge: true });
    batch.set(subMappingRef, {
      uid,
      status,
      lastEvent: eventType,
      updatedAt: new Date(),
    }, { merge: true });

    await batch.commit();
    console.log(`[WEBHOOK] Updated Firestore for ${uid}: status=${status}, isPremium=${isPremium}`);
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
