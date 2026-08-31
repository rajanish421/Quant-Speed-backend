/**
 * Setup Script for Razorpay Subscription Plans.
 * 
 * Usage:
 *   node scripts/setup_razorpay_plans.js
 * 
 * Creates the 4 QuantSpeed recurring plans in Razorpay if not already created,
 * and prints out the plan IDs to put in .env.
 */

const dotenv = require('dotenv');
dotenv.config();

const razorpayClient = require('../services/razorpay_client');
const { RAZORPAY_PLANS } = require('../config/razorpay_plans');

async function setupPlans() {
  console.log('==================================================');
  console.log('   QuantSpeed Razorpay Plan Provisioning Script   ');
  console.log('==================================================');

  if (!razorpayClient.client) {
    console.log('[INFO] Razorpay client is running with development mock configuration.');
    console.log('Below are the mapped Plan IDs for development/testing:\n');
    for (const [key, plan] of Object.entries(RAZORPAY_PLANS)) {
      console.log(`${plan.envKey}=plan_test_${key}  # ${plan.name} (${plan.amount / 100} INR / ${plan.period})`);
    }
    return;
  }

  console.log('[INFO] Contacting Razorpay API to create official subscription plans...');

  const createdPlans = {};

  for (const [key, plan] of Object.entries(RAZORPAY_PLANS)) {
    try {
      const existingId = process.env[plan.envKey];
      if (existingId && existingId.startsWith('plan_')) {
        console.log(`[EXISTS] ${plan.name}: ${existingId} (from .env)`);
        createdPlans[plan.envKey] = existingId;
        continue;
      }

      const response = await razorpayClient.client.plans.create({
        period: plan.period,
        interval: plan.interval,
        item: {
          name: plan.name,
          amount: plan.amount,
          currency: plan.currency,
          description: plan.description,
        },
        notes: {
          planId: plan.id,
          appName: 'QuantSpeed',
        },
      });

      console.log(`[CREATED] ${plan.name}: ${response.id}`);
      createdPlans[plan.envKey] = response.id;
    } catch (err) {
      console.error(`[ERROR] Failed to create ${plan.name}:`, err.message);
    }
  }

  console.log('\n==================================================');
  console.log('Add the following Plan IDs to your .env file:');
  console.log('==================================================');
  for (const [envKey, id] of Object.entries(createdPlans)) {
    console.log(`${envKey}=${id}`);
  }
}

setupPlans();
