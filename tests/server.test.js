const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_AUTH = 'true';

const app = require('../server');

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

function makeRequest(path, options = {}, body = null) {
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
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

test('GET /health returns status ok', async () => {
  const res = await makeRequest('/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.status, 'ok');
  assert.strictEqual(res.data.service, 'quantspeed-backend');
});

test('POST /api/notifications/battle-presence rejects unauthorized request', async () => {
  const res = await makeRequest('/api/notifications/battle-presence', {
    method: 'POST',
  }, { playerName: 'Aarav' });

  assert.strictEqual(res.status, 401);
});

test('POST /api/notifications/battle-presence accepts authenticated dev request', async () => {
  const res = await makeRequest('/api/notifications/battle-presence', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer mock_user_host123',
    },
  }, {
    playerName: 'Aarav',
    rankTitle: 'Silver IV',
    rating: 1050,
    duelId: 'duel_999',
    timestamp: Date.now(),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.data.success, 'boolean');
});

test('POST /api/notifications/battle-presence enforces stale presence limits', async () => {
  const res = await makeRequest('/api/notifications/battle-presence', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer mock_user_host123',
    },
  }, {
    playerName: 'Aarav',
    duelId: 'duel_old',
    timestamp: Date.now() - 300000, // 5 minutes old
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, false);
  assert.strictEqual(res.data.reason, 'stale_presence');
});
