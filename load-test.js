import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '60s', target: 200 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<60000'],
    http_req_failed: ['rate<0.3'],
  },
};

export default function () {
  const payload = JSON.stringify({
    task: 'add a comment to the main function',
    repoPath: 'test-repo',
    userId: 'load_test_user',
  });

  const res = http.post(
    'https://zone-api-production.up.railway.app/api/patch',
    payload,
    { headers: { 'Content-Type': 'application/json' }, timeout: '120s' }
  );

  check(res, {
    'status 200': (r) => r.status === 200,
    'ok true': (r) => {
      try { return JSON.parse(r.body).ok === true; } catch { return false; }
    },
  });

  sleep(1);
}
