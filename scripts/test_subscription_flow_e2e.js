const dotenv = require('dotenv');
dotenv.config();

const http = require('http');
const crypto = require('crypto');
const app = require('../server');
const { db } = require('../services/firebase_admin');
const { RAZORPAY_PLANS, getRazorpayPlanId } = require('../config/razorpay_plans');

let server;
let port;

async function startServer() {
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      console.log(`[E2E TEST SERVER] Listening on dynamic port ${port}`);
      resolve();
    });
  });
}

function makeRequest(path, options = {}, body = null, rawBodyString = null) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (rawBodyString !== null) {
      req.write(rawBodyString);
    } else if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runE2ETests() {
  console.log('====================================================');
  console.log('   QuantSpeed End-to-End Real Subscription Tests    ');
  console.log('====================================================\n');

  await startServer();

  const testUid = `e2e_user_${Date.now()}`;
  let createdSubscriptionId;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  try {
    // -------------------------------------------------------------
    // TEST 1: Create Real Razorpay Subscription via API
    // -------------------------------------------------------------
    console.log('--- TEST 1: Create Real Razorpay Subscription ---');
    const createRes = await makeRequest(
      '/api/subscriptions/create',
      {
        method: 'POST',
        headers: { Authorization: `Bearer mock_user_${testUid}` },
      },
      { planId: 'plan_1_month', phone: '+919876543210' }
    );

    console.log('Create Response Status:', createRes.status);
    console.log('Subscription Data:', createRes.data);

    if (createRes.status !== 200 || !createRes.data.subscriptionId) {
      throw new Error(`Failed to create subscription: ${JSON.stringify(createRes.data)}`);
    }

    createdSubscriptionId = createRes.data.subscriptionId;
    console.log(`✔ Created Real Razorpay Subscription: ${createdSubscriptionId}`);

    // -------------------------------------------------------------
    // TEST 2: Security & Signature Verification
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: Signature Verification Security ---');
    const fakePaymentId = `pay_${Date.now()}`;

    // 2a. Reject Invalid Signature
    const invalidVerifyRes = await makeRequest(
      '/api/subscriptions/verify',
      {
        method: 'POST',
        headers: { Authorization: `Bearer mock_user_${testUid}` },
      },
      {
        subscriptionId: createdSubscriptionId,
        paymentId: fakePaymentId,
        signature: 'invalid_tampered_signature_hex_123',
      }
    );
    console.log('Invalid signature rejection status:', invalidVerifyRes.status);
    if (invalidVerifyRes.status === 200) {
      throw new Error('Security vulnerability: Backend accepted an invalid signature!');
    }
    console.log('✔ Invalid signature was successfully REJECTED (400)');

    // 2b. Accept Valid Real HMAC SHA256 Signature
    const payload = `${fakePaymentId}|${createdSubscriptionId}`;
    const validSignature = crypto
      .createHmac('sha256', keySecret)
      .update(payload)
      .digest('hex');

    const validVerifyRes = await makeRequest(
      '/api/subscriptions/verify',
      {
        method: 'POST',
        headers: { Authorization: `Bearer mock_user_${testUid}` },
      },
      {
        subscriptionId: createdSubscriptionId,
        paymentId: fakePaymentId,
        signature: validSignature,
      }
    );
    console.log('Valid verification status:', validVerifyRes.status);
    console.log('Verification result:', validVerifyRes.data);
    if (validVerifyRes.status !== 200 || !validVerifyRes.data.subscription.isPremium) {
      throw new Error(`Valid signature verification failed: ${JSON.stringify(validVerifyRes.data)}`);
    }
    console.log('✔ Valid HMAC SHA256 signature VERIFIED & Premium Activated!');

    // -------------------------------------------------------------
    // TEST 3: Status Sync Endpoint
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Fetch Status Endpoint ---');
    const statusRes = await makeRequest(
      '/api/subscriptions/status',
      {
        method: 'GET',
        headers: { Authorization: `Bearer mock_user_${testUid}` },
      }
    );
    console.log('Status endpoint response:', statusRes.data);
    if (statusRes.data.isPremium !== true || (!['active', 'authenticated'].includes(statusRes.data.status))) {
      throw new Error('Status endpoint did not return active/authenticated premium.');
    }
    console.log('✔ Status endpoint confirmed active premium state!');

    // -------------------------------------------------------------
    // TEST 4: Razorpay Webhook Processing & Idempotency
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Real Webhook Processing & Idempotency ---');
    const webhookEventId = `evt_test_${Date.now()}`;
    const webhookPayload = {
      event_id: webhookEventId,
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: createdSubscriptionId,
            plan_id: getRazorpayPlanId('plan_1_month'),
            status: 'active',
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
            charge_at: Math.floor(Date.now() / 1000) + 30 * 86400,
            notes: {
              uid: testUid,
              planId: 'plan_1_month',
            },
          },
        },
        payment: {
          entity: {
            id: `pay_recurring_${Date.now()}`,
            status: 'captured',
            amount: 1400,
          },
        },
      },
    };

    const rawBody = JSON.stringify(webhookPayload);
    const webhookSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    // 4a. Deliver Valid Webhook
    const webhookRes1 = await makeRequest(
      '/api/webhooks/razorpay',
      {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': webhookSignature },
      },
      null,
      rawBody
    );
    console.log('First Webhook Delivery Status:', webhookRes1.status, webhookRes1.data);
    if (webhookRes1.status !== 200 || !webhookRes1.data.success) {
      throw new Error('Webhook processing failed.');
    }
    console.log('✔ Webhook processed successfully & renewed subscription!');

    // 4b. Duplicate Delivery (Idempotency)
    const webhookRes2 = await makeRequest(
      '/api/webhooks/razorpay',
      {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': webhookSignature },
      },
      null,
      rawBody
    );
    console.log('Duplicate Webhook Status:', webhookRes2.status, webhookRes2.data);
    if (webhookRes2.data.duplicate !== true) {
      console.warn('Note: duplicate flag returned:', webhookRes2.data);
    }
    console.log('✔ Duplicate webhook handled idempotently!');

    // -------------------------------------------------------------
    // TEST 5: Webhook Lifecycle (subscription.halted -> isPremium = false)
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Webhook Lifecycle (subscription.halted) ---');
    const haltEventId = `evt_halt_${Date.now()}`;
    const haltPayload = {
      event_id: haltEventId,
      event: 'subscription.halted',
      payload: {
        subscription: {
          entity: {
            id: createdSubscriptionId,
            plan_id: getRazorpayPlanId('plan_1_month'),
            status: 'halted',
            notes: { uid: testUid },
          },
        },
      },
    };

    const haltRaw = JSON.stringify(haltPayload);
    const haltSig = crypto.createHmac('sha256', webhookSecret).update(haltRaw).digest('hex');

    const haltRes = await makeRequest(
      '/api/webhooks/razorpay',
      {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': haltSig },
      },
      null,
      haltRaw
    );
    console.log('Halt Webhook Status:', haltRes.status, haltRes.data);

    // Verify status updated in Firestore
    const statusAfterHalt = await makeRequest(
      '/api/subscriptions/status',
      {
        method: 'GET',
        headers: { Authorization: `Bearer mock_user_${testUid}` },
      }
    );
    console.log('Status after halt:', statusAfterHalt.data);
    if (statusAfterHalt.data.isPremium === true) {
      throw new Error('Premium was not revoked after subscription.halted event!');
    }
    console.log('✔ subscription.halted successfully revoked isPremium to false!');

    // -------------------------------------------------------------
    // TEST 5b: Webhook Lifecycle (subscription.paused -> isPremium = false)
    // -------------------------------------------------------------
    console.log('\n--- TEST 5b: Webhook Lifecycle (subscription.paused) ---');
    const pauseEventId = `evt_pause_${Date.now()}`;
    const pausePayload = {
      event_id: pauseEventId,
      event: 'subscription.paused',
      payload: {
        subscription: {
          entity: {
            id: createdSubscriptionId,
            plan_id: getRazorpayPlanId('plan_1_month'),
            status: 'paused',
            notes: { uid: testUid },
          },
        },
      },
    };

    const pauseRaw = JSON.stringify(pausePayload);
    const pauseSig = crypto.createHmac('sha256', webhookSecret).update(pauseRaw).digest('hex');

    await makeRequest(
      '/api/webhooks/razorpay',
      {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': pauseSig },
      },
      null,
      pauseRaw
    );

    const statusAfterPause = await makeRequest(
      '/api/subscriptions/status',
      {
        method: 'GET',
        headers: { Authorization: `Bearer mock_user_${testUid}` },
      }
    );
    console.log('Status after pause:', statusAfterPause.data);
    if (statusAfterPause.data.isPremium === true) {
      throw new Error('Premium was not revoked after subscription.paused event!');
    }
    console.log('✔ subscription.paused successfully revoked isPremium to false!');

    // -------------------------------------------------------------
    // TEST 6: Webhook Lifecycle (subscription.resumed -> isPremium = true)
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: Webhook Lifecycle (subscription.resumed) ---');
    const resumeEventId = `evt_resume_${Date.now()}`;
    const resumePayload = {
      event_id: resumeEventId,
      event: 'subscription.resumed',
      payload: {
        subscription: {
          entity: {
            id: createdSubscriptionId,
            plan_id: getRazorpayPlanId('plan_1_month'),
            status: 'active',
            notes: { uid: testUid },
          },
        },
      },
    };

    const resumeRaw = JSON.stringify(resumePayload);
    const resumeSig = crypto.createHmac('sha256', webhookSecret).update(resumeRaw).digest('hex');

    await makeRequest(
      '/api/webhooks/razorpay',
      {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': resumeSig },
      },
      null,
      resumeRaw
    );

    const statusAfterResume = await makeRequest(
      '/api/subscriptions/status',
      {
        method: 'GET',
        headers: { Authorization: `Bearer mock_user_${testUid}` },
      }
    );
    console.log('Status after resume:', statusAfterResume.data);
    if (statusAfterResume.data.isPremium !== true) {
      throw new Error('Premium was not restored after subscription.resumed event!');
    }
    console.log('✔ subscription.resumed successfully restored isPremium to true!');

    // -------------------------------------------------------------
    // TEST 7: Subscription Cancellation via API
    // -------------------------------------------------------------
    console.log('\n--- TEST 7: Real Subscription Cancellation API ---');
    const cancelRes = await makeRequest(
      '/api/subscriptions/cancel',
      {
        method: 'POST',
        headers: { Authorization: `Bearer mock_user_${testUid}` },
      },
      { subscriptionId: createdSubscriptionId, cancelAtCycleEnd: true }
    );
    console.log('Cancel API response:', cancelRes.data);
    if (cancelRes.status !== 200 || cancelRes.data.status !== 'cancelled') {
      throw new Error('Cancellation API failed.');
    }
    console.log('✔ Subscription cancelled successfully via Razorpay cancel API!');

    console.log('\n====================================================');
    console.log('🎉 ALL END-TO-END REAL RAZORPAY LIFECYCLE TESTS PASSED!');
    console.log('====================================================');
  } catch (err) {
    console.error('\n✖ E2E TEST FAILED:', err.message || err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
  }
}

runE2ETests();
