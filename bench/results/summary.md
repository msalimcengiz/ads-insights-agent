Scripted demo model (no LLM latency): measures the API, the Postgres job queue, the agent loop and the SQL tools. 10000 runs per row, posted by 20 clients at once.
Machine: Apple M4, Docker VM with 4 CPUs shared by every container.

| workers × concurrency | jobs | done | failed | needed a 2nd attempt | enqueue req/s | enqueue p95 ms | seconds to drain | jobs/s | job latency p50 ms | job latency p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 × 4 | 10000 | 10000 | 0 | 0 | 3518 | 10.2 | 14.0 | **712** | 8185 | 10919 |
| 2 × 4 | 10000 | 10000 | 0 | 0 | 3255 | 10.5 | 11.6 | **859** | 6585 | 8463 |
| 4 × 4 | 10000 | 10000 | 0 | 0 | 2154 | 16.8 | 12.5 | **801** | 5606 | 7836 |

Job latency = queued -> done, including the wait in the queue while all 10000 were posted at once.
