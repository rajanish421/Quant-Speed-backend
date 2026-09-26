const dotenv = require('dotenv');
dotenv.config();

const Razorpay = require('razorpay');

async function listPlans() {
  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  try {
    const plans = await razorpay.plans.all({ count: 20 });
    console.log(`Found ${plans.count} plans on your Razorpay account:\n`);
    for (const item of plans.items) {
      console.log(`Plan ID: ${item.id}`);
      console.log(`  - Name:     ${item.item.name}`);
      console.log(`  - Amount:   ₹${item.item.amount / 100} ${item.item.currency}`);
      console.log(`  - Period:   ${item.period} (interval: ${item.interval})`);
      console.log(`  - Created:  ${new Date(item.created_at * 1000).toISOString()}\n`);
    }
  } catch (err) {
    console.error('Error fetching plans list:', err);
  }
}

listPlans();
