const { db } = require('./firebase_admin');
const razorpayClient = require('./razorpay_client');
const { RAZORPAY_PLANS, getRazorpayPlanId } = require('../config/razorpay_plans');

/**
 * Calculates authoritative isPremium status based on Razorpay subscription status and valid billing period.
 */
function calculateIsPremium({ status, currentEnd, endedAt }) {
  const now = new Date();
  const periodEnd = currentEnd ? (currentEnd.toDate ? currentEnd.toDate() : new Date(currentEnd)) : null;

  // 1. Fully active, authenticated, or resumed subscriptions
  if (['active', 'authenticated', 'resumed'].includes(status)) {
    if (periodEnd && now > periodEnd) {
      return false; // Period expired
    }
    return true;
  }

  // 2. Cancelled subscriptions: retain benefits until the end of paid cycle
  if (status === 'cancelled') {
    if (periodEnd && now <= periodEnd) {
      return true;
    }
    return false;
  }

  // 3. Pending subscriptions: in grace period while charge retry is underway
  if (status === 'pending') {
    if (periodEnd && now <= periodEnd) {
      return true;
    }
    return false;
  }

  // 4. Paused, halted, completed, expired, or created states
  return false;
}

class BackendSubscriptionService {
  /**
   * Creates a new Razorpay recurring subscription for an authenticated user.
   */
  async createSubscription({ uid, planId, userEmail, userPhone }) {
    const planConfig = RAZORPAY_PLANS[planId];
    if (!planConfig) {
      throw new Error(`Invalid planId: ${planId}. Allowed plans: ${Object.keys(RAZORPAY_PLANS).join(', ')}`);
    }

    const razorpayPlanId = getRazorpayPlanId(planId);
    if (!razorpayPlanId) {
      throw new Error(`Razorpay Plan ID not configured for plan: ${planId}`);
    }

    const rzpSubscription = await razorpayClient.createSubscription({
      plan_id: razorpayPlanId,
      total_count: planConfig.totalBillingCycles,
      quantity: 1,
      customer_notify: 1,
      notes: {
        uid,
        planId,
        appName: 'QuantSpeed',
      },
    });

    const subscriptionId = rzpSubscription.id;

    // Persist pending subscription state in Firestore
    if (db) {
      try {
        const batch = db.batch();

        const userSubRef = db.doc(`users/${uid}/subscription/current`);
        batch.set(userSubRef, {
          provider: 'razorpay',
          subscriptionId,
          razorpaySubscriptionId: subscriptionId,
          planId,
          razorpayPlanId,
          status: 'created',
          razorpayStatus: 'created',
          isPremium: false,
          userEmail: userEmail || '',
          userPhone: userPhone || '',
          createdAt: new Date(),
          updatedAt: new Date(),
        }, { merge: true });

        const subMappingRef = db.doc(`subscriptions/${subscriptionId}`);
        batch.set(subMappingRef, {
          uid,
          planId,
          razorpayPlanId,
          status: 'created',
          razorpayStatus: 'created',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await batch.commit();
        console.log(`[SUBSCRIPTION] Created pending subscription: ${subscriptionId} for user: ${uid}`);
      } catch (err) {
        console.warn('[SUBSCRIPTION] Firestore storage warning:', err.message);
      }
    }

    return {
      success: true,
      subscriptionId,
      razorpaySubscriptionId: subscriptionId,
      planId,
      razorpayPlanId,
      keyId: razorpayClient.keyId,
    };
  }

  /**
   * Verifies Razorpay Checkout subscription authorization and immediately activates Premium.
   */
  async verifySubscription({ uid, subscriptionId, paymentId, signature }) {
    if (!subscriptionId || !paymentId || !signature) {
      throw new Error('subscriptionId, paymentId, and signature are required for verification.');
    }

    // 1. Fast Synchronous Signature Verification (< 1ms)
    const isValidSignature = razorpayClient.verifySubscriptionSignature({
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subscriptionId,
      razorpay_signature: signature,
    });

    if (!isValidSignature) {
      throw new Error('Invalid Razorpay signature. Authorization verification failed.');
    }

    // 2. Fetch Subscription from Razorpay API with 4s timeout fallback
    let rzpSub = null;
    try {
      const fetchPromise = razorpayClient.fetchSubscription(subscriptionId);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), 4000));
      rzpSub = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (fetchErr) {
      console.warn('[SUBSCRIPTION] Fetch from Razorpay notice:', fetchErr.message || fetchErr);
    }

    const now = Date.now();
    const currentStart = (rzpSub && rzpSub.current_start) ? new Date(rzpSub.current_start * 1000) : new Date();
    const currentEnd = (rzpSub && rzpSub.current_end) ? new Date(rzpSub.current_end * 1000) : new Date(now + 30 * 86400000);
    const nextChargeAt = (rzpSub && rzpSub.charge_at) ? new Date(rzpSub.charge_at * 1000) : currentEnd;

    // 3. Resolve planId
    let planId = (rzpSub && rzpSub.notes && rzpSub.notes.planId) || 'plan_1_month';
    if (!RAZORPAY_PLANS[planId]) {
      for (const [key, val] of Object.entries(RAZORPAY_PLANS)) {
        if (rzpSub && getRazorpayPlanId(key) === rzpSub.plan_id) {
          planId = key;
          break;
        }
      }
    }

    let status = (rzpSub && rzpSub.status) || 'active';
    if (status === 'created') {
      status = 'authenticated';
    }
    const isPremium = calculateIsPremium({ status, currentEnd, endedAt: null });

    const subscriptionData = {
      provider: 'razorpay',
      subscriptionId,
      razorpaySubscriptionId: subscriptionId,
      planId,
      razorpayPlanId: (rzpSub && rzpSub.plan_id) || getRazorpayPlanId(planId),
      status,
      razorpayStatus: status,
      isPremium,
      currentPeriodStart: currentStart,
      currentPeriodEnd: currentEnd,
      nextChargeAt,
      lastPaymentId: paymentId,
      updatedAt: new Date(),
    };

    // 4. Update Firestore as Single Source of Truth
    if (db) {
      try {
        const batch = db.batch();

        const userSubRef = db.doc(`users/${uid}/subscription/current`);
        batch.set(userSubRef, subscriptionData, { merge: true });

        const subMappingRef = db.doc(`subscriptions/${subscriptionId}`);
        batch.set(subMappingRef, {
          uid,
          status,
          razorpayStatus: status,
          lastPaymentId: paymentId,
          updatedAt: new Date(),
        }, { merge: true });

        await batch.commit();
        console.log(`[SUBSCRIPTION] Verified & Activated Premium for user: ${uid}, sub: ${subscriptionId}, isPremium: ${isPremium}`);
      } catch (err) {
        console.warn('[SUBSCRIPTION] Firestore update warning:', err.message);
      }
    }

    return {
      success: true,
      subscription: subscriptionData,
    };
  }

  /**
   * Cancels a recurring subscription.
   */
  async cancelSubscription({ uid, subscriptionId, cancelAtCycleEnd = true }) {
    if (!subscriptionId) {
      throw new Error('subscriptionId is required for cancellation.');
    }

    // 1. Verify user ownership
    let currentEnd = null;
    if (db) {
      const mappingDoc = await db.doc(`subscriptions/${subscriptionId}`).get();
      if (mappingDoc.exists) {
        const mappingData = mappingDoc.data();
        if (mappingData.uid && mappingData.uid !== uid) {
          throw new Error('Unauthorized: You do not own this subscription.');
        }
      }

      const userDoc = await db.doc(`users/${uid}/subscription/current`).get();
      if (userDoc.exists) {
        currentEnd = userDoc.data().currentPeriodEnd;
      }
    }

    // 2. Call Razorpay Cancel API
    try {
      await razorpayClient.cancelSubscription(subscriptionId, cancelAtCycleEnd);
    } catch (err) {
      const errMsg = (err && err.error && err.error.description) || (err && err.message) || String(err);
      console.warn(`[SUBSCRIPTION] Razorpay cancel API response for ${subscriptionId}:`, errMsg);
    }

    const isPremium = cancelAtCycleEnd ? calculateIsPremium({ status: 'cancelled', currentEnd, endedAt: null }) : false;

    // 3. Update Firestore
    if (db) {
      try {
        const batch = db.batch();

        const userSubRef = db.doc(`users/${uid}/subscription/current`);
        batch.set(userSubRef, {
          status: 'cancelled',
          razorpayStatus: 'cancelled',
          cancelledAt: new Date(),
          isPremium,
          updatedAt: new Date(),
        }, { merge: true });

        const subMappingRef = db.doc(`subscriptions/${subscriptionId}`);
        batch.set(subMappingRef, {
          status: 'cancelled',
          razorpayStatus: 'cancelled',
          cancelledAt: new Date(),
          updatedAt: new Date(),
        }, { merge: true });

        await batch.commit();
        console.log(`[SUBSCRIPTION] Cancelled subscription: ${subscriptionId} for user: ${uid}, isPremium: ${isPremium}`);
      } catch (err) {
        console.warn('[SUBSCRIPTION] Firestore cancel update warning:', err.message);
      }
    }

    return {
      success: true,
      status: 'cancelled',
      razorpayStatus: 'cancelled',
      subscriptionId,
      isPremium,
    };
  }

  /**
   * Fetches authoritative subscription state from Firestore and reconciles isPremium.
   */
  async getSubscriptionStatus({ uid }) {
    if (!uid) {
      return { isPremium: false, status: 'none', razorpayStatus: 'none', planId: null };
    }

    if (!db) {
      return { isPremium: false, status: 'none', razorpayStatus: 'none', planId: null, note: 'db_unavailable' };
    }

    try {
      const doc = await db.doc(`users/${uid}/subscription/current`).get();
      if (!doc.exists) {
        return { isPremium: false, status: 'none', razorpayStatus: 'none', planId: null };
      }

      const data = doc.data();
      const status = data.razorpayStatus || data.status || 'none';
      const currentEnd = data.currentPeriodEnd;
      const endedAt = data.endedAt;

      const isPremium = calculateIsPremium({ status, currentEnd, endedAt });

      return {
        isPremium,
        status,
        razorpayStatus: status,
        planId: data.planId || null,
        razorpayPlanId: data.razorpayPlanId || null,
        subscriptionId: data.subscriptionId || data.razorpaySubscriptionId || null,
        razorpaySubscriptionId: data.subscriptionId || data.razorpaySubscriptionId || null,
        currentPeriodStart: data.currentPeriodStart || null,
        currentPeriodEnd: data.currentPeriodEnd || null,
        nextChargeAt: data.nextChargeAt || null,
        endedAt: data.endedAt || null,
        lastWebhookEvent: data.lastWebhookEvent || null,
        lastWebhookEventId: data.lastWebhookEventId || null,
        lastPaymentId: data.lastPaymentId || null,
        updatedAt: data.updatedAt || null,
      };
    } catch (err) {
      console.error('[SUBSCRIPTION STATUS] Error fetching status:', err.message);
      return { isPremium: false, status: 'error', razorpayStatus: 'error', planId: null };
    }
  }
}

module.exports = new BackendSubscriptionService();
module.exports.calculateIsPremium = calculateIsPremium;
