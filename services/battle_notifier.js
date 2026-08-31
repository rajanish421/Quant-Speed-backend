const { db, messaging } = require('./firebase_admin');

class BattleNotifier {
  constructor() {
    // In-memory cooldown tracking: userUid -> timestamp (ms)
    this.userLastNotified = new Map();
    // Global last broadcast timestamp (ms)
    this.lastGlobalBroadcastTime = 0;
    // Default cooldowns
    this.COOLDOWN_MS = (parseInt(process.env.BATTLE_NOTIFICATION_COOLDOWN_SECONDS, 10) || 300) * 1000; // 5 mins
    this.GLOBAL_COOLDOWN_MS = 60 * 1000; // 1 min minimum between global pushes
    this.STALE_PRESENCE_LIMIT_MS = 120 * 1000; // 2 mins max age
  }

  /**
   * Dispatches Live Battle Challenger notification to all eligible users.
   */
  async notifyChallengers({ hostUid, playerName, rankTitle, rating, duelId, timestamp }) {
    const now = Date.now();

    // 1. Stale Presence Check
    if (timestamp && (now - timestamp > this.STALE_PRESENCE_LIMIT_MS || timestamp > now + 30000)) {
      console.log(`[BATTLE NOTIFIER] Skipped stale matchmaking presence from ${hostUid} (age: ${now - timestamp}ms)`);
      return { success: false, reason: 'stale_presence' };
    }

    // 2. Global Anti-Spam Check (Throttle rapid concurrent entries into single aggregated alert)
    const timeSinceGlobal = now - this.lastGlobalBroadcastTime;
    if (timeSinceGlobal < this.GLOBAL_COOLDOWN_MS) {
      console.log(`[BATTLE NOTIFIER] Global cooldown active (${timeSinceGlobal}ms < ${this.GLOBAL_COOLDOWN_MS}ms). Throttling broadcast.`);
      return { success: false, reason: 'global_cooldown_active' };
    }

    if (!db) {
      console.warn('[BATTLE NOTIFIER] Firestore database not available.');
      return { success: false, reason: 'database_unavailable' };
    }

    try {
      // 3. Query all registered device tokens across users
      const devicesSnapshot = await db.collectionGroup('devices').get();
      if (devicesSnapshot.empty) {
        console.log('[BATTLE NOTIFIER] No registered devices found in Firestore.');
        return { success: true, recipientsCount: 0, reason: 'no_registered_devices' };
      }

      const tokensToSend = [];
      const tokenDocs = []; // for invalid token cleanup

      devicesSnapshot.forEach((doc) => {
        const data = doc.data();
        const pathParts = doc.ref.path.split('/');
        // Path is users/{userId}/devices/{deviceId}
        const userUid = pathParts[1];

        // Rule A: Never notify the host player
        if (userUid === hostUid) return;

        // Rule B: Respect notification preferences
        if (data.notificationsEnabled === false || data.battleAlertsEnabled === false) return;

        // Rule C: Validate token presence
        const token = data.fcmToken;
        if (!token || typeof token !== 'string' || token.trim().length === 0) return;

        // Rule D: Per-user cooldown check
        const lastNotified = this.userLastNotified.get(userUid) || 0;
        if (now - lastNotified < this.COOLDOWN_MS) return;

        tokensToSend.push(token);
        tokenDocs.push({ ref: doc.ref, token, userUid });
      });

      if (tokensToSend.length === 0) {
        console.log('[BATTLE NOTIFIER] No eligible recipients after preference/cooldown filtering.');
        return { success: true, recipientsCount: 0, reason: 'no_eligible_recipients' };
      }

      // 4. Construct Notification Payload
      const title = '⚔️ Opponent Available in Battle Arena!';
      const body = `${playerName || 'A Challenger'} (${rankTitle || 'Cadet'} • ${rating || 1000} ELO) is ready to battle. Tap to join!`;

      const payload = {
        notification: {
          title,
          body,
        },
        data: {
          type: 'battle_invite',
          targetRoute: '/battle',
          hostUid: String(hostUid || ''),
          playerName: String(playerName || 'Challenger'),
          rankTitle: String(rankTitle || 'Cadet'),
          rating: String(rating || '1000'),
          duelId: String(duelId || ''),
          timestamp: String(now),
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'quantspeed_battle_challenges',
            priority: 'max',
            defaultSound: true,
            defaultVibrateTimings: true,
            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              contentAvailable: true,
            },
          },
        },
      };

      // 5. Send FCM Multicast in batches of 500
      let totalSuccess = 0;
      let totalFailure = 0;
      const invalidDocsToDelete = [];

      for (let i = 0; i < tokensToSend.length; i += 500) {
        const batchTokens = tokensToSend.slice(i, i + 500);
        const batchDocRefs = tokenDocs.slice(i, i + 500);

        const multicastMessage = {
          ...payload,
          tokens: batchTokens,
        };

        if (messaging) {
          const response = await messaging.sendEachForMulticast(multicastMessage);
          totalSuccess += response.successCount;
          totalFailure += response.failureCount;

          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              const errCode = resp.error ? resp.error.code : 'unknown';
              if (
                errCode === 'messaging/invalid-registration-token' ||
                errCode === 'messaging/registration-token-not-registered'
              ) {
                invalidDocsToDelete.push(batchDocRefs[idx].ref);
              }
            } else {
              // Update last notified time for user
              this.userLastNotified.set(batchDocRefs[idx].userUid, now);
            }
          });
        } else {
          // Development/Mock Mode without FCM connection
          console.log(`[BATTLE NOTIFIER MOCK] Simulated sending to ${batchTokens.length} tokens.`);
          totalSuccess += batchTokens.length;
        }
      }

      // 6. Prune invalid tokens from Firestore
      if (invalidDocsToDelete.length > 0) {
        console.log(`[BATTLE NOTIFIER] Pruning ${invalidDocsToDelete.length} invalid/unregistered device tokens.`);
        const batch = db.batch();
        invalidDocsToDelete.forEach((ref) => batch.delete(ref));
        await batch.commit();
      }

      this.lastGlobalBroadcastTime = now;
      console.log(`[BATTLE NOTIFIER] Dispatched battle alert. Success: ${totalSuccess}, Failures: ${totalFailure}, Pruned: ${invalidDocsToDelete.length}`);

      return {
        success: true,
        recipientsCount: totalSuccess,
        failureCount: totalFailure,
        prunedCount: invalidDocsToDelete.length,
      };
    } catch (error) {
      console.error('[BATTLE NOTIFIER] Error dispatching battle notifications:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new BattleNotifier();
