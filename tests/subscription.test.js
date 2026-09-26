const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_AUTH = 'true';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret_2026';

const app = require('../server');
const { RAZORPAY_PLANS, getRazorpayPlanId } = require('../config/razorpay_plans');

let server;
let testPort;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      testPort = server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function makeRequest(path, options = {}, body = null, rawBodyString = null) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: '127.0.0.1',
      port: testPort,
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

test('Plan configuration contains all 4 official QuantSpeed plans', () => {
  assert.ok(RAZORPAY_PLANS.plan_1_month);
  assert.ok(RAZORPAY_PLANS.plan_3_months);
  assert.ok(RAZORPAY_PLANS.plan_6_months);
  assert.ok(RAZORPAY_PLANS.plan_1_year);

  assert.strictEqual(RAZORPAY_PLANS.plan_1_month.amount, 1400);
  assert.strictEqual(RAZORPAY_PLANS.plan_3_months.amount, 3900);
  assert.strictEqual(RAZORPAY_PLANS.plan_6_months.amount, 6900);
  assert.strictEqual(RAZORPAY_PLANS.plan_1_year.amount, 11100);

  assert.ok(getRazorpayPlanId('plan_1_month').startsWith('plan_'));
});

test('POST /api/subscriptions/create rejects unauthenticated requests', async () => {
  const res = await makeRequest('/api/subscriptions/create', { method: 'POST' }, { planId: 'plan_1_month' });
  assert.strictEqual(res.status, 401);
});

test('POST /api/subscriptions/create creates recurring subscription for authenticated user', async () => {
  const res = await makeRequest('/api/subscriptions/create', {
    method: 'POST',
    headers: { Authorization: 'Bearer mock_user_sub123' },
  }, { planId: 'plan_1_month' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, true);
  assert.ok(res.data.subscriptionId);
  assert.strictEqual(res.data.planId, 'plan_1_month');
  assert.ok(res.data.keyId);
});

test('POST /api/subscriptions/verify verifies signature and returns active status', async () => {
  const res = await makeRequest('/api/subscriptions/verify', {
    method: 'POST',
    headers: { Authorization: 'Bearer mock_user_sub123' },
  }, {
    subscriptionId: 'sub_test_12345',
    paymentId: 'pay_test_99999',
    signature: 'mock_sig_valid',
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, true);
  assert.strictEqual(res.data.subscription.isPremium, true);
  assert.strictEqual(res.data.subscription.status, 'active');
});

test('POST /api/subscriptions/cancel cancels subscription', async () => {
  const res = await makeRequest('/api/subscriptions/cancel', {
    method: 'POST',
    headers: { Authorization: 'Bearer mock_user_sub123' },
  }, {
    subscriptionId: 'sub_test_12345',
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, true);
  assert.strictEqual(res.data.status, 'cancelled');
});

test('POST /api/webhooks/razorpay rejects invalid signature', async () => {
  const payload = JSON.stringify({ event: 'subscription.charged', id: 'evt_test_1' });
  const res = await makeRequest('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'X-Razorpay-Signature': 'invalid_signature_hex' },
  }, null, payload);

  assert.strictEqual(res.status, 400);
});

test('POST /api/webhooks/razorpay processes valid HMAC signature event', async () => {
  const eventObj = {
    event_id: 'evt_valid_101',
    event: 'subscription.charged',
    payload: {
      subscription: {
        entity: {
          id: 'sub_test_webhook_1',
          plan_id: 'plan_test_plan_1_month',
          status: 'active',
          current_start: Math.floor(Date.now() / 1000),
          current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          charge_at: Math.floor(Date.now() / 1000) + 30 * 86400,
          notes: { uid: 'user_webhook_123', planId: 'plan_1_month' },
        },
      },
      payment: {
        entity: {
          id: 'pay_recurring_101',
          status: 'captured',
          amount: 1400,
        },
      },
    },
  };

  const rawBody = JSON.stringify(eventObj);
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const res = await makeRequest('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'X-Razorpay-Signature': signature },
  }, null, rawBody);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, true);
  assert.strictEqual(res.data.eventId, 'evt_valid_101');
});
