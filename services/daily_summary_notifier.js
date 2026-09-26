const { db, messaging } = require('./firebase_admin');

class DailySummaryNotifier {
  /**
   * Dispatches personalized Daily Summary notification to target user or all eligible users.
   */
  async sendDailySummary({ targetUid, streak, questionsSolved, accuracyRate }) {
    if (!db || !messaging) {
      console.warn('[DAILY SUMMARY] Firebase Admin db/messaging not initialized.');
      return { success: false, reason: 'firebase_unavailable' };
    }

    try {
      let devicesQuery = db.collectionGroup('devices');
      if (targetUid) {
        // Query specific user's devices
        devicesQuery = db.collection(`users/${targetUid}/devices`);
      }

      const snapshot = await devicesQuery.get();
      if (snapshot.empty) {
        return { success: true, recipientsCount: 0, reason: 'no_devices_found' };
      }

      const tokens = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.notificationsEnabled !== false && data.dailySummaryEnabled !== false && data.fcmToken) {
          tokens.push(data.fcmToken);
        }
      });

      if (tokens.length === 0) {
        return { success: true, recipientsCount: 0, reason: 'no_eligible_tokens' };
      }

      const streakVal = streak || 0;
      const title = streakVal > 0
        ? `📊 Daily Summary: ${streakVal}-Day Streak Strong!`
        : '📊 Daily QuantSpeed Summary';
      const body = questionsSolved > 0
        ? `You completed ${questionsSolved} drills with ${accuracyRate || 100}% accuracy today. Keep up the momentum!`
        : 'Solve 3 quick arithmetic drills today to climb the leaderboard & protect your streak!';

      const payload = {
        notification: {
          title,
          body,
        },
        data: {
          type: 'daily_summary',
          targetRoute: '/account',
          streak: String(streakVal),
          questionsSolved: String(questionsSolved || 0),
          timestamp: String(Date.now()),
        },
        android: {
          priority: 'normal',
          notification: {
            channelId: 'quantspeed_streak_reminders',
            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          },
        },
        tokens,
      };

      const response = await messaging.sendEachForMulticast(payload);
      console.log(`[DAILY SUMMARY] Sent daily summary to ${response.successCount} devices.`);

      return {
        success: true,
        recipientsCount: response.successCount,
        failureCount: response.failureCount,
      };
    } catch (error) {
      console.error('[DAILY SUMMARY] Error sending daily summary:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new DailySummaryNotifier();
