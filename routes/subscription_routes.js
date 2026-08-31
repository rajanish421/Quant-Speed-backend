const express = require('express');
const { verifyFirebaseAuth } = require('../services/firebase_admin');
const subscriptionService = require('../services/subscription_service');
const webhookService = require('../services/webhook_service');

const router = express.Router();

// -------------------------------------------------------------
// 1. CREATE RECURRING SUBSCRIPTION
// -------------------------------------------------------------
router.post('/create', verifyFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { planId, phone } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'planId is required.' });
    }

    const result = await subscriptionService.createSubscription({
      uid,
      planId,
      userEmail: req.user.email,
      userPhone: phone,
    });

    return res.json(result);
  } catch (error) {
    console.error('[API] /subscriptions/create error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 2. VERIFY SUBSCRIPTION AUTHORIZATION SIGNATURE
// -------------------------------------------------------------
router.post('/verify', verifyFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { subscriptionId, paymentId, signature } = req.body;

    if (!subscriptionId || !paymentId || !signature) {
      return res.status(400).json({
        error: 'subscriptionId, paymentId, and signature are required for verification.',
      });
    }

    const result = await subscriptionService.verifySubscription({
      uid,
      subscriptionId,
      paymentId,
      signature,
    });

    return res.json(result);
  } catch (error) {
    console.error('[API] /subscriptions/verify error:', error.message);
    return res.status(400).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 3. CANCEL RECURRING SUBSCRIPTION
// -------------------------------------------------------------
router.post('/cancel', verifyFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { subscriptionId, cancelAtCycleEnd } = req.body;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'subscriptionId is required.' });
    }

    const result = await subscriptionService.cancelSubscription({
      uid,
      subscriptionId,
      cancelAtCycleEnd: cancelAtCycleEnd !== false,
    });

    return res.json(result);
  } catch (error) {
    console.error('[API] /subscriptions/cancel error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// 4. GET SUBSCRIPTION STATUS
// -------------------------------------------------------------
router.get('/status', verifyFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const result = await subscriptionService.getSubscriptionStatus({ uid });
    return res.json(result);
  } catch (error) {
    console.error('[API] /subscriptions/status error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
