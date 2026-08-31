/**
 * Authoritative QuantSpeed Subscription Plans Configuration.
 * 
 * QuantSpeed official plans:
 * 1. 1 Month:  ₹14  (monthly, interval: 1)
 * 2. 3 Months: ₹39  (quarterly, interval: 1)
 * 3. 6 Months: ₹69  (monthly, interval: 6)
 * 4. 1 Year:   ₹111 (yearly, interval: 1)
 */

const RAZORPAY_PLANS = {
  plan_1_month: {
    id: 'plan_1_month',
    name: 'QuantSpeed Premium - 1 Month',
    amount: 1400, // in paise (₹14.00)
    currency: 'INR',
    period: 'monthly',
    interval: 1,
    description: 'Monthly recurring subscription for QuantSpeed Premium',
    envKeys: ['RAZORPAY_PLAN_MONTHLY', 'RAZORPAY_PLAN_1_MONTH'],
    totalBillingCycles: 120, // 10 years max recurring
  },
  plan_3_months: {
    id: 'plan_3_months',
    name: 'QuantSpeed Premium - 3 Months',
    amount: 3900, // in paise (₹39.00)
    currency: 'INR',
    period: 'quarterly',
    interval: 1,
    description: 'Quarterly recurring subscription for QuantSpeed Premium',
    envKeys: ['RAZORPAY_PLAN_QUARTERLY', 'RAZORPAY_PLAN_3_MONTHS'],
    totalBillingCycles: 40, // 10 years max recurring
  },
  plan_6_months: {
    id: 'plan_6_months',
    name: 'QuantSpeed Premium - 6 Months',
    amount: 6900, // in paise (₹69.00)
    currency: 'INR',
    period: 'monthly',
    interval: 6,
    description: '6-Month recurring subscription for QuantSpeed Premium',
    envKeys: ['RAZORPAY_PLAN_6_MONTHS', 'RAZORPAY_PLAN_6_MONTH'],
    totalBillingCycles: 20, // 10 years max recurring
  },
  plan_1_year: {
    id: 'plan_1_year',
    name: 'QuantSpeed Premium - 1 Year',
    amount: 11100, // in paise (₹111.00)
    currency: 'INR',
    period: 'yearly',
    interval: 1,
    description: 'Annual recurring subscription for QuantSpeed Premium',
    envKeys: ['RAZORPAY_PLAN_YEARLY', 'RAZORPAY_PLAN_1_YEAR', 'RAZORPAY_PLAN_ANNUAL'],
    totalBillingCycles: 10, // 10 years max recurring
  },
};

/**
 * Resolves the server-controlled Razorpay Plan ID for a requested QuantSpeed plan ID.
 */
function getRazorpayPlanId(planId) {
  const plan = RAZORPAY_PLANS[planId];
  if (!plan) return null;
  for (const envKey of plan.envKeys) {
    if (process.env[envKey] && process.env[envKey].trim().length > 0) {
      return process.env[envKey].trim();
    }
  }
  return `plan_test_${planId}`;
}

module.exports = {
  RAZORPAY_PLANS,
  getRazorpayPlanId,
};
