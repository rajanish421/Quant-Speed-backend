const { db } = require('./firebase_admin');
const razorpayClient = require('./razorpay_client');
const { RAZORPAY_PLANS, getRazorpayPlanId } = require('../config/razorpay_plans');

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
          planId,
          razorpayPlanId,
          status: 'created',
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
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await batch.commit();
        console.log(`[SUBSCRIPTION] Stored created subscription: ${subscriptionId} for user: ${uid}`);
      } catch (err) {
        console.warn('[SUBSCRIPTION] Firestore storage warning:', err.message);
      }
    }

    return {
      success: true,
      subscriptionId,
      planId,
      razorpayPlanId,
      keyId: razorpayClient.keyId,
    };
  }

  /**
   * Verifies Razorpay Checkout subscription authorization and activates Premium.
   */
  async verifySubscription({ uid, subscriptionId, paymentId, signature }) {
    if (!subscriptionId || !paymentId || !signature) {
      throw new Error('subscriptionId, paymentId, and signature are required for verification.');
    }

    // 1. Verify Signature
    const isValidSignature = razorpayClient.verifySubscriptionSignature({
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subscriptionId,
      razorpay_signature: signature,
    });

    if (!isValidSignature) {
      throw new Error('Invalid Razorpay signature. Authorization verification failed.');
    }

    // 2. Fetch Subscription from Razorpay API
    let rzpSub = null;
    try {
      rzpSub = await razorpayClient.fetchSubscription(subscriptionId);
    } catch (fetchErr) {
      console.warn('[SUBSCRIPTION] Fetch from Razorpay API notice:', fetchErr.message || fetchErr);
    }

    const now = Date.now();
    const currentStart = (rzpSub && rzpSub.current_start) ? new Date(rzpSub.current_start * 1000) : new Date();
    const currentEnd = (rzpSub && rzpSub.current_end) ? new Date(rzpSub.current_end * 1000) : new Date(now + 30 * 86400000);
    const nextChargeAt = (rzpSub && rzpSub.charge_at) ? new Date(rzpSub.charge_at * 1000) : currentEnd;

    // 3. Resolve planId
    let planId = (rzpSub && rzpSub.notes && rzpSub.notes.planId) || 'plan_1_month';
    if (!RAZORPAY_PLANS[planId]) {
      // Find matching by razorpayPlanId
      for (const [key, val] of Object.entries(RAZORPAY_PLANS)) {
        if (rzpSub && getRazorpayPlanId(key) === rzpSub.plan_id) {
          planId = key;
          break;
        }
      }
    }

    const subscriptionData = {
      provider: 'razorpay',
      subscriptionId,
      planId,
      razorpayPlanId: (rzpSub && rzpSub.plan_id) || getRazorpayPlanId(planId),
      status: 'active',
      isPremium: true,
      currentPeriodStart: currentStart,
      currentPeriodEnd: currentEnd,
      nextChargeAt,
      lastPaymentId: paymentId,
      updatedAt: new Date(),
    };

    // 4. Update Firestore as Authoritative Source of Truth
    if (db) {
      try {
        const batch = db.batch();

        const userSubRef = db.doc(`users/${uid}/subscription/current`);
        batch.set(userSubRef, subscriptionData, { merge: true });

        const subMappingRef = db.doc(`subscriptions/${subscriptionId}`);
        batch.set(subMappingRef, {
          uid,
          status: 'active',
          lastPaymentId: paymentId,
          updatedAt: new Date(),
        }, { merge: true });

        await batch.commit();
        console.log(`[SUBSCRIPTION] Verified & Activated Premium for user: ${uid}, sub: ${subscriptionId}`);
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
    if (db) {
      const mappingDoc = await db.doc(`subscriptions/${subscriptionId}`).get();
      if (mappingDoc.exists) {
        const mappingData = mappingDoc.data();
        if (mappingData.uid && mappingData.uid !== uid) {
          throw new Error('Unauthorized: You do not own this subscription.');
        }
      }
    }

    // 2. Call Razorpay Cancel API (catch gracefully if subscription was in created state)
    let cancelResponse = null;
    try {
      cancelResponse = await razorpayClient.cancelSubscription(subscriptionId, cancelAtCycleEnd);
    } catch (err) {
      const errMsg = (err && err.error && err.error.description) || (err && err.message) || String(err);
      console.warn(`[SUBSCRIPTION] Razorpay cancel API response for ${subscriptionId}:`, errMsg);
    }

    // 3. Update Firestore
    if (db) {
      try {
        const batch = db.batch();

        const userSubRef = db.doc(`users/${uid}/subscription/current`);
        batch.set(userSubRef, {
          status: 'cancelled',
          cancelledAt: new Date(),
          // If cancelling at cycle end, user keeps premium until currentPeriodEnd
          isPremium: cancelAtCycleEnd,
          updatedAt: new Date(),
        }, { merge: true });

        const subMappingRef = db.doc(`subscriptions/${subscriptionId}`);
        batch.set(subMappingRef, {
          status: 'cancelled',
          cancelledAt: new Date(),
          updatedAt: new Date(),
        }, { merge: true });

        await batch.commit();
        console.log(`[SUBSCRIPTION] Cancelled subscription: ${subscriptionId} for user: ${uid}`);
      } catch (err) {
        console.warn('[SUBSCRIPTION] Firestore cancel update warning:', err.message);
      }
    }

    return {
      success: true,
      status: 'cancelled',
      subscriptionId,
    };
  }

  /**
   * Fetches authoritative subscription state from Firestore.
   */
  async getSubscriptionStatus({ uid }) {
    if (!uid) {
      return { isPremium: false, status: 'none', planId: null };
    }

    if (!db) {
      return { isPremium: false, status: 'none', planId: null, note: 'db_unavailable' };
    }

    try {
      const doc = await db.doc(`users/${uid}/subscription/current`).get();
      if (!doc.exists) {
        return { isPremium: false, status: 'none', planId: null };
      }

      const data = doc.data();
      const now = new Date();

      let isPremium = data.isPremium === true;

      // Validate expiry
      if (data.currentPeriodEnd) {
        const periodEnd = data.currentPeriodEnd.toDate ? data.currentPeriodEnd.toDate() : new Date(data.currentPeriodEnd);
        if (now > periodEnd && data.status !== 'active') {
          isPremium = false;
        }
      }

      return {
        isPremium,
        status: data.status || 'none',
        planId: data.planId || null,
        subscriptionId: data.subscriptionId || null,
        currentPeriodStart: data.currentPeriodStart || null,
        currentPeriodEnd: data.currentPeriodEnd || null,
        nextChargeAt: data.nextChargeAt || null,
        updatedAt: data.updatedAt || null,
      };
    } catch (err) {
      console.error('[SUBSCRIPTION STATUS] Error fetching status:', err.message);
      return { isPremium: false, status: 'error', planId: null };
    }
  }
}

module.exports = new BackendSubscriptionService();
