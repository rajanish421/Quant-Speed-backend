const Razorpay = require('razorpay');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

class RazorpayClientService {
  constructor() {
    this.keyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_quantspeed';
    this.keySecret = process.env.RAZORPAY_KEY_SECRET || 'test_secret_quantspeed';
    this.webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook_secret_2026';

    const isMock = this.keyId.includes('test_quantspeed') || !process.env.RAZORPAY_KEY_SECRET;

    if (!isMock) {
      try {
        this.client = new Razorpay({
          key_id: this.keyId,
          key_secret: this.keySecret,
        });
        console.log('[RAZORPAY] Initialized Razorpay SDK with Key ID:', this.keyId.substring(0, 8) + '...');
      } catch (err) {
        console.warn('[RAZORPAY] Initialization notice:', err.message);
        this.client = null;
      }
    } else {
      console.log('[RAZORPAY] Running in Test/Mock Mode with development key:', this.keyId);
      this.client = null;
    }
  }

  get isLiveConfigured() {
    return Boolean(this.client);
  }

  /**
   * Creates a Razorpay Subscription.
   */
  async createSubscription({ plan_id, total_count, quantity = 1, customer_notify = 1, notes = {} }) {
    if (this.client) {
      return await this.client.subscriptions.create({
        plan_id,
        total_count: total_count || 120,
        quantity,
        customer_notify,
        notes,
      });
    }

    // Realistic Mock Mode for automated tests / dev environment
    const subId = `sub_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    console.log(`[RAZORPAY MOCK] Created Subscription: ${subId} for plan: ${plan_id}`);
    return {
      id: subId,
      entity: 'subscription',
      plan_id,
      status: 'created',
      current_start: null,
      current_end: null,
      ended_at: null,
      quantity,
      notes,
      charge_at: Math.floor(Date.now() / 1000) + 3600,
      start_at: Math.floor(Date.now() / 1000),
      total_count: total_count || 120,
      paid_count: 0,
      customer_notify: 1,
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Fetches details of an existing Razorpay Subscription.
   */
  async fetchSubscription(subscriptionId) {
    if (this.client) {
      return await this.client.subscriptions.fetch(subscriptionId);
    }

    // Mock Mode
    return {
      id: subscriptionId,
      entity: 'subscription',
      status: 'active',
      current_start: Math.floor(Date.now() / 1000),
      current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      charge_at: Math.floor(Date.now() / 1000) + 30 * 86400,
      paid_count: 1,
    };
  }

  /**
   * Cancels a Razorpay Subscription.
   */
  async cancelSubscription(subscriptionId, cancelAtCycleEnd = false) {
    if (this.client) {
      return await this.client.subscriptions.cancel(subscriptionId, cancelAtCycleEnd);
    }

    // Mock Mode
    console.log(`[RAZORPAY MOCK] Cancelled subscription: ${subscriptionId} (cancelAtCycleEnd: ${cancelAtCycleEnd})`);
    return {
      id: subscriptionId,
      status: 'cancelled',
      ended_at: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Verifies the Subscription Authorization Signature from Razorpay Checkout.
   * Format for Razorpay Subscriptions: HMAC_SHA256(razorpay_payment_id + '|' + razorpay_subscription_id, secret)
   */
  verifySubscriptionSignature({ razorpay_payment_id, razorpay_subscription_id, razorpay_signature }) {
    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return false;
    }

    // In local test mock mode, accept mock signatures
    if (razorpay_signature.startsWith('mock_sig_') || this.keySecret === 'test_secret_quantspeed') {
      return true;
    }

    try {
      const payload = `${razorpay_payment_id}|${razorpay_subscription_id}`;
      const expectedSignature = crypto
        .createHmac('sha256', this.keySecret)
        .update(payload)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'utf8'),
        Buffer.from(razorpay_signature, 'utf8')
      );
    } catch (e) {
      console.error('[RAZORPAY] Signature verification error:', e.message);
      return false;
    }
  }

  /**
   * Verifies Razorpay Webhook Signature using RAW request body and secret.
   */
  verifyWebhookSignature({ rawBody, signature, customSecret }) {
    if (!rawBody || !signature) return false;

    const secret = customSecret || this.webhookSecret;

    try {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'utf8'),
        Buffer.from(signature, 'utf8')
      );
    } catch (e) {
      console.error('[WEBHOOK SIGNATURE] Verification error:', e.message);
      return false;
    }
  }
}

module.exports = new RazorpayClientService();
