const dotenv = require('dotenv');
dotenv.config();

const Razorpay = require('razorpay');
const { RAZORPAY_PLANS, getRazorpayPlanId } = require('../config/razorpay_plans');

async function testRealRazorpayConnection() {
  console.log('====================================================');
  console.log('   Testing Real Razorpay TEST Mode API Connection   ');
  console.log('====================================================');

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  console.log('Using Key ID:', keyId);

  if (!keyId || !keySecret || keyId.includes('test_quantspeed')) {
    console.error('[FAIL] Real Razorpay Test keys not detected in .env');
    process.exit(1);
  }

  const razorpay = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });

  // Step 1: Verify the 4 Plan IDs against Razorpay API
  console.log('\n--- Step 1: Validating 4 Subscription Plans with Razorpay API ---');
  for (const [key, plan] of Object.entries(RAZORPAY_PLANS)) {
    const planId = getRazorpayPlanId(key);
    console.log(`\nChecking Plan: ${plan.name} (${key}) -> ${planId}`);

    try {
      const fetchedPlan = await razorpay.plans.fetch(planId);
      console.log(`✔ Plan verified successfully on Razorpay!`);
      console.log(`  - Razorpay ID: ${fetchedPlan.id}`);
      console.log(`  - Period: ${fetchedPlan.period}`);
      console.log(`  - Interval: ${fetchedPlan.interval}`);
      console.log(`  - Amount: ₹${fetchedPlan.item.amount / 100} (${fetchedPlan.item.currency})`);
      console.log(`  - Name: ${fetchedPlan.item.name}`);
    } catch (err) {
      console.error(`✖ Error fetching plan ${planId}:`, err.message || err);
    }
  }

  // Step 2: Test Creating a Real Subscription Mandate via Razorpay API
  console.log('\n--- Step 2: Testing Real Subscription Creation via API ---');
  const testPlanKey = 'plan_1_month';
  const testPlanId = getRazorpayPlanId(testPlanKey);

  try {
    const createdSub = await razorpay.subscriptions.create({
      plan_id: testPlanId,
      total_count: 120,
      quantity: 1,
      customer_notify: 1,
      notes: {
        uid: 'test_real_user_verification_101',
        planId: testPlanKey,
        appName: 'QuantSpeed',
      },
    });

    console.log('✔ Successfully created REAL Razorpay Test Mode Subscription Mandate!');
    console.log(`  - Subscription ID: ${createdSub.id}`);
    console.log(`  - Status: ${createdSub.status}`);
    console.log(`  - Plan ID: ${createdSub.plan_id}`);
    console.log(`  - Short URL: ${createdSub.short_url || 'N/A'}`);
    console.log(`  - Charge At: ${createdSub.charge_at ? new Date(createdSub.charge_at * 1000).toISOString() : 'N/A'}`);

    // Step 3: Fetch the newly created subscription to verify fetch API
    console.log('\n--- Step 3: Fetching Subscription Details from Razorpay API ---');
    const fetchedSub = await razorpay.subscriptions.fetch(createdSub.id);
    console.log(`✔ Successfully fetched subscription ${fetchedSub.id} with status: ${fetchedSub.status}`);

    console.log('\n====================================================');
    console.log('🎉 Real Razorpay TEST Mode API verification PASSED!');
    console.log('====================================================');
  } catch (err) {
    console.error('✖ Error creating subscription:', err.message || err);
  }
}

testRealRazorpayConnection();
