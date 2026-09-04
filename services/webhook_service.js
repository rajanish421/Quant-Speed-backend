const { db } = require('./firebase_admin');
const razorpayClient = require('./razorpay_client');
const { RAZORPAY_PLANS, getRazorpayPlanId } = require('../config/razorpay_plans');
const { calculateIsPremium } = require('./subscription_service');

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

    // 1. DEDICATED HANDLING FOR PAYMENT FAILURE
    if (eventType === 'payment.failed') {
      const paymentId = (paymentEntity && paymentEntity.id) || '';
      const errorDesc = (paymentEntity && (paymentEntity.error_description || paymentEntity.error_reason)) || 'Payment was declined or failed.';
      console.warn(`[WEBHOOK] Payment ${paymentId} failed for subscription: ${subscriptionId}. Error: ${errorDesc}`);

      // Fetch subscription from Razorpay to check actual paid_count
      let rzpSub = subEntity;
      if (!rzpSub && subscriptionId) {
        try {
          rzpSub = await razorpayClient.fetchSubscription(subscriptionId);
        } catch (e) {
          console.warn(`[WEBHOOK] Fetch sub notice on payment.failed: ${e.message}`);
        }
      }

      const paidCount = (rzpSub && rzpSub.paid_count) || 0;

      // Update mapping document for audit/debugging
      await db.doc(`subscriptions/${subscriptionId}`).set({
        uid,
        status: paidCount === 0 ? 'failed' : ((rzpSub && rzpSub.status) || 'pending'),
        razorpayStatus: paidCount === 0 ? 'failed' : ((rzpSub && rzpSub.status) || 'pending'),
        isPremium: false,
        lastPaymentId: paymentId,
        lastPaymentError: errorDesc,
        lastWebhookEvent: eventType,
        lastWebhookEventId: eventId,
        updatedAt: new Date(),
      }, { merge: true });

      // If initial subscription checkout failed (paidCount === 0):
      if (paidCount === 0) {
        const userSubDoc = await db.doc(`users/${uid}/subscription/current`).get();
        if (userSubDoc.exists) {
          const currentData = userSubDoc.data();
          if (currentData.subscriptionId === subscriptionId || currentData.razorpaySubscriptionId === subscriptionId) {
            await db.doc(`users/${uid}/subscription/current`).set({
              status: 'failed',
              razorpayStatus: 'failed',
              isPremium: false,
              lastPaymentId: paymentId,
              lastPaymentError: errorDesc,
              lastWebhookEvent: eventType,
              lastWebhookEventId: eventId,
              updatedAt: new Date(),
            }, { merge: true });
          }
        }
        console.log(`[WEBHOOK] Initial payment failed for user ${uid}, sub ${subscriptionId}. isPremium marked FALSE.`);
        return;
      }

      // If recurring renewal failed on an existing paid subscription (paidCount > 0):
      const userSubDoc = await db.doc(`users/${uid}/subscription/current`).get();
      if (userSubDoc.exists) {
        const currentData = userSubDoc.data();
        const existingEnd = currentData.currentPeriodEnd;
        const isStillValid = calculateIsPremium({
          status: 'pending',
          currentEnd: existingEnd,
          endedAt: null,
          paidCount,
        });

        await db.doc(`users/${uid}/subscription/current`).set({
          status: 'pending',
          razorpayStatus: 'pending',
          isPremium: isStillValid,
          lastPaymentId: paymentId,
          lastPaymentError: errorDesc,
          lastWebhookEvent: eventType,
          lastWebhookEventId: eventId,
          updatedAt: new Date(),
        }, { merge: true });
        console.log(`[WEBHOOK] Renewal payment failed for user ${uid}, sub ${subscriptionId}. Grace isPremium: ${isStillValid}`);
      }
      return;
    }

    // 2. SUBSCRIPTION LIFECYCLE FOR OTHER EVENTS
    let rzpSub = subEntity;
    if (!rzpSub && subscriptionId) {
      try {
        rzpSub = await razorpayClient.fetchSubscription(subscriptionId);
      } catch (e) {
        console.warn(`[WEBHOOK] Fetch sub notice: ${e.message}`);
      }
    }

    const paidCount = typeof (rzpSub && rzpSub.paid_count) === 'number'
      ? rzpSub.paid_count
      : (eventType === 'subscription.charged' ? 1 : 0);

    // Resolve planId
    let planId = (rzpSub && rzpSub.notes && rzpSub.notes.planId);
    if (!planId && rzpSub && rzpSub.plan_id) {
      for (const [key] of Object.entries(RAZORPAY_PLANS)) {
        if (getRazorpayPlanId(key) === rzpSub.plan_id) {
          planId = key;
          break;
        }
      }
    }
    planId = planId || 'plan_1_month';

    const planConfig = RAZORPAY_PLANS[planId] || { durationDays: 30 };
    const durationDays = planConfig.durationDays || 30;

    const currentStart = (rzpSub && rzpSub.current_start) ? new Date(rzpSub.current_start * 1000) : (paidCount > 0 ? new Date() : null);
    let currentEnd = (rzpSub && rzpSub.current_end) ? new Date(rzpSub.current_end * 1000) : null;
    if (!currentEnd && paidCount > 0 && ['subscription.charged', 'subscription.activated'].includes(eventType)) {
      currentEnd = new Date(Date.now() + durationDays * 86400000);
    }
    const nextChargeAt = (rzpSub && rzpSub.charge_at) ? new Date(rzpSub.charge_at * 1000) : currentEnd;
    const endedAt = (rzpSub && rzpSub.ended_at) ? new Date(rzpSub.ended_at * 1000) : null;

    let status = (rzpSub && rzpSub.status) || 'created';

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

      default:
        console.log(`[WEBHOOK] Event ${eventType} received for subscription: ${subscriptionId}`);
        break;
    }

    // Authoritatively calculate isPremium from Razorpay state
    const isPremium = calculateIsPremium({
      status,
      currentEnd,
      endedAt,
      paidCount,
    });

    const updateData = {
      provider: 'razorpay',
      subscriptionId,
      razorpaySubscriptionId: subscriptionId,
      planId,
      razorpayPlanId: (rzpSub && rzpSub.plan_id) || getRazorpayPlanId(planId) || '',
      status,
      razorpayStatus: status,
      isPremium,
      currentPeriodStart: currentStart,
      currentPeriodEnd: currentEnd,
      nextChargeAt,
      endedAt,
      lastPaymentId: (paymentEntity && paymentEntity.id) || (rzpSub && rzpSub.payment_id) || '',
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
