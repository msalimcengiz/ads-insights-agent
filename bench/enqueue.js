// Posts RUNS new runs as fast as 20 clients can, each with its own Idempotency-Key.

import { check } from 'k6';
import http from 'k6/http';

const QUESTIONS = [
  'Son günlerde performansı aniden bozulan bir kampanya var mı?',
  'Geçen hafta en çok harcayan kampanyalar hangileri?',
  'ROAS değeri en düşük kampanya hangisi?',
  'Bütçesi en hızlı tükenen kampanyalar hangileri?',
];

export const options = {
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  scenarios: { enqueue: { executor: 'shared-iterations', vus: 20, iterations: parseInt(__ENV.RUNS || '10000', 10) } },
};

export default function () {
  const res = http.post(
    'http://api:3000/v1/runs',
    JSON.stringify({ message: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] }),
    {
      headers: {
        'Content-Type': 'application/json',
        'x-account-id': 'acc_moda',
        'Idempotency-Key': `bench-${__ENV.WORKERS}-${__VU}-${__ITER}`,
      },
    },
  );
  check(res, { queued: (r) => r.status === 202 });
}

export function handleSummary(data) {
  return { [`/results/enqueue-${__ENV.WORKERS}.json`]: JSON.stringify(data) };
}
