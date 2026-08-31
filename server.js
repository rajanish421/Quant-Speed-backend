const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const { verifyFirebaseAuth, db, messaging, rtdb, findServiceAccountKey } = require('./services/firebase_admin');
const battleNotifier = require('./services/battle_notifier');
const dailySummaryNotifier = require('./services/daily_summary_notifier');
const subscriptionRoutes = require('./routes/subscription_routes');
const webhookService = require('./services/webhook_service');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & Parsing Middleware
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Preserve raw body for Webhook HMAC Signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// -------------------------------------------------------------
// HEALTHCHECK & DIAGNOSTICS
// -------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'quantspeed-backend',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now(),
  });
});

app.get('/api/diagnostics', async (req, res) => {
  try {
    const keyPath = findServiceAccountKey();
    let deviceCount = 0;
    let firestoreConnected = false;
    let rtdbConnected = false;

    if (db) {
      try {
        const snapshot = await db.collectionGroup('devices').get();
        deviceCount = snapshot.size;
        firestoreConnected = true;
      } catch (e) {
        firestoreConnected = false;
      }
    }

    if (rtdb) {
      rtdbConnected = true;
    }

    res.json({
      status: 'ready',
      serviceAccountKeyLoaded: Boolean(keyPath),
      keyPath: keyPath || 'None (Download from Firebase Console -> Project Settings -> Service Accounts)',
      firestoreConnected,
      registeredDevicesCount: deviceCount,
      rtdbConnected,
      timestamp: Date.now(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// SUBSCRIPTIONS API
// -------------------------------------------------------------
app.use('/api/subscriptions', subscriptionRoutes);

// -------------------------------------------------------------
// RAZORPAY WEBHOOK RECEIVER
// -------------------------------------------------------------
app.post('/api/webhooks/razorpay', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);

    if (!signature) {
      return res.status(400).json({ error: 'Missing X-Razorpay-Signature header.' });
    }

    const eventIdHeader = req.headers['x-razorpay-event-id'];

    const result = await webhookService.processWebhookEvent({
      rawBody,
      signature,
      eventPayload: req.body,
      eventIdHeader,
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('[API] /webhooks/razorpay error:', error.message);
    return res.status(400).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// BATTLE PRESENCE NOTIFICATION DISPATCH
// -------------------------------------------------------------
app.post('/api/notifications/battle-presence', verifyFirebaseAuth, async (req, res) => {
  try {
    const hostUid = req.user.uid;
    const { playerName, rankTitle, rating, duelId, timestamp } = req.body;

    if (!hostUid) {
      return res.status(400).json({ error: 'Missing hostUid in authenticated context.' });
    }

    const result = await battleNotifier.notifyChallengers({
      hostUid,
      playerName: playerName || req.user.name || 'A Challenger',
      rankTitle: rankTitle || 'Cadet',
      rating: parseInt(rating, 10) || 1000,
      duelId: duelId || hostUid,
      timestamp: timestamp || Date.now(),
    });

    return res.json(result);
  } catch (error) {
    console.error('[API] /battle-presence error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// DIRECT TEST BATTLE PUSH TRIGGER (FOR TESTING)
// -------------------------------------------------------------
app.post('/api/notifications/test-battle-push', async (req, res) => {
  try {
    const { playerName, rating, hostUid } = req.body;
    console.log('[TEST BATTLE PUSH] Triggered manual test battle alert...');

    const result = await battleNotifier.notifyChallengers({
      hostUid: hostUid || 'test_host_manual_trigger',
      playerName: playerName || 'Master Tactician',
      rankTitle: 'Gold II',
      rating: parseInt(rating, 10) || 1450,
      duelId: 'test_duel_' + Date.now(),
      timestamp: Date.now(),
    });

    return res.json({
      message: 'Test battle alert triggered!',
      result,
    });
  } catch (error) {
    console.error('[API] /test-battle-push error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// DAILY SUMMARY NOTIFICATION DISPATCH
// -------------------------------------------------------------
app.post('/api/notifications/daily-summary', async (req, res) => {
  try {
    const apiKey = req.headers['x-admin-api-key'];
    if (apiKey && process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
      // Authorized by admin cron key
    } else {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Unauthorized: Admin API key or Auth Token required.' });
      }
    }

    const { targetUid, streak, questionsSolved, accuracyRate } = req.body;
    const result = await dailySummaryNotifier.sendDailySummary({
      targetUid,
      streak: parseInt(streak, 10) || 0,
      questionsSolved: parseInt(questionsSolved, 10) || 0,
      accuracyRate: parseInt(accuracyRate, 10) || 100,
    });

    return res.json(result);
  } catch (error) {
    console.error('[API] /daily-summary error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// DEVICE TOKEN REGISTRATION (FALLBACK)
// -------------------------------------------------------------
app.post('/api/devices/register', verifyFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { deviceId, fcmToken, platform, appVersion, battleAlertsEnabled, notificationsEnabled } = req.body;

    if (!deviceId || !fcmToken) {
      return res.status(400).json({ error: 'deviceId and fcmToken are required.' });
    }

    if (!db) {
      return res.status(503).json({ error: 'Database service unavailable.' });
    }

    const deviceRef = db.doc(`users/${uid}/devices/${deviceId}`);
    await deviceRef.set(
      {
        deviceId,
        fcmToken,
        platform: platform || 'android',
        appVersion: appVersion || '1.0.0+1',
        battleAlertsEnabled: battleAlertsEnabled !== false,
        notificationsEnabled: notificationsEnabled !== false,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    return res.json({ success: true, message: 'Device registered successfully.' });
  } catch (error) {
    console.error('[API] /devices/register error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// REALTIME DATABASE MATCHMAKING QUEUE LISTENER
// -------------------------------------------------------------
function startRtdbQueueListener() {
  if (!rtdb) {
    return;
  }

  try {
    const queueRef = rtdb.ref('matchmaking_queue');
    console.log('[RTDB LISTENER] Actively listening for new matchmaking entries in Firebase RTDB...');

    queueRef.on('child_added', async (snapshot) => {
      const data = snapshot.val();
      const hostUid = snapshot.key;

      if (!data || !hostUid) return;

      console.log(`[RTDB QUEUE] New player entered matchmaking queue: ${data.name || hostUid}`);
      await battleNotifier.notifyChallengers({
        hostUid,
        playerName: data.name || 'A Challenger',
        rankTitle: data.rankTitle || 'Cadet',
        rating: data.rating || 1000,
        duelId: hostUid,
        timestamp: data.timestamp || Date.now(),
      });
    });
  } catch (err) {
    console.warn('[RTDB LISTENER] Could not attach RTDB listener:', err.message);
  }
}

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[QUANTSPEED BACKEND] Server listening on port ${PORT}`);
    startRtdbQueueListener();
  });
}

module.exports = app;
