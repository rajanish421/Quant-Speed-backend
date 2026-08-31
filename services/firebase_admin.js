const admin = require('firebase-admin');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const os = require('os');

dotenv.config();

let isInitialized = false;

function findServiceAccountKey() {
  // 1. Direct environment variable path
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  // 2. quantspeed_backend/serviceAccountKey.json
  const localKeyPath = path.join(__dirname, '../serviceAccountKey.json');
  if (fs.existsSync(localKeyPath)) {
    return localKeyPath;
  }

  // 3. Search ~/Downloads for quantspeed-math-*.json or serviceAccountKey*.json
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  if (fs.existsSync(downloadsDir)) {
    const files = fs.readdirSync(downloadsDir);
    const match = files.find(f => 
      (f.startsWith('quantspeed-math-firebase-adminsdk') || f.startsWith('quantspeed-math') || f.startsWith('serviceAccountKey')) && f.endsWith('.json')
    );
    if (match) {
      const foundPath = path.join(downloadsDir, match);
      console.log(`[FIREBASE ADMIN] Automatically detected service account in Downloads: ${match}`);
      return foundPath;
    }
  }

  return null;
}

function initializeFirebaseAdmin() {
  if (isInitialized) return admin;

  const keyPath = findServiceAccountKey();
  const dbUrl = process.env.FIREBASE_DATABASE_URL || 'https://quantspeed-math-default-rtdb.firebaseio.com';

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || 'quantspeed-math',
        databaseURL: dbUrl,
      });
      console.log('[FIREBASE ADMIN] Initialized using FIREBASE_SERVICE_ACCOUNT_KEY env var.');
    } else if (keyPath) {
      const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id || 'quantspeed-math',
        databaseURL: dbUrl,
      });
      console.log(`[FIREBASE ADMIN] Initialized successfully with Service Account Key: ${keyPath}`);
    } else {
      admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'quantspeed-math',
        databaseURL: dbUrl,
      });
      console.log('[FIREBASE ADMIN] Initialized in default mode. (Place serviceAccountKey.json in quantspeed_backend/ to enable live FCM and Firestore)');
    }
    isInitialized = true;
  } catch (error) {
    console.warn('[FIREBASE ADMIN] Initialization notice:', error.message);
    if (!admin.apps.length) {
      admin.initializeApp({
        projectId: 'quantspeed-math',
        databaseURL: dbUrl,
      });
    }
    isInitialized = true;
  }

  return admin;
}

const firebaseInstance = initializeFirebaseAdmin();
const db = firebaseInstance.firestore ? firebaseInstance.firestore() : null;
const auth = firebaseInstance.auth ? firebaseInstance.auth() : null;
const messaging = firebaseInstance.messaging ? firebaseInstance.messaging() : null;
const rtdb = firebaseInstance.database ? firebaseInstance.database() : null;

/**
 * Express middleware to verify Firebase ID tokens in Authorization: Bearer <token>.
 */
async function verifyFirebaseAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header.' });
  }

  const token = authHeader.split('Bearer ')[1].trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Empty bearer token.' });
  }

  // Support local test mock tokens in development mode
  if (process.env.NODE_ENV === 'test' || (process.env.ALLOW_DEV_AUTH === 'true' && token.startsWith('mock_user_'))) {
    req.user = {
      uid: token.replace('mock_user_', ''),
      email: `${token}@quantspeed.local`,
      name: 'Test Cadet',
    };
    return next();
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = decodedToken;
    return next();
  } catch (error) {
    console.error('[AUTH] Token verification failed:', error.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired Firebase ID token.' });
  }
}

module.exports = {
  admin: firebaseInstance,
  db,
  auth,
  messaging,
  rtdb,
  verifyFirebaseAuth,
  findServiceAccountKey,
};
