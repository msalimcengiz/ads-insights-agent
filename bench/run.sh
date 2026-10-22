#!/usr/bin/env bash
# Job queue benchmark with the scripted demo model (AGENT_MODEL=demo).
#
# The demo model answers instantly, so this measures everything around the model: the
# API enqueueing runs, workers claiming jobs with FOR UPDATE SKIP LOCKED + leases, the agent
# loop and the real tenant-scoped SQL tools against Postgres. It does NOT measure Claude's
# latency or answer quality (that is `make eval`, which needs an API key).
#
# RUNS runs are posted at once, then drained by 1, 2 and 4 worker containers
# (WORKER_CONCURRENCY=4 each). Every job must finish on its first attempt.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNS=${RUNS:-10000}
SCALES=${SCALES:-"1 2 4"}
RESULTS="$PWD/bench/results"
mkdir -p "$RESULTS"
export AGENT_MODEL=demo

sql() { docker compose exec -T postgres psql -U ads -d ads -v ON_ERROR_STOP=1 -tAc "$1"; }

rows_md=""
for workers in $SCALES; do
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker compose up -d --build --wait --scale worker="$workers" >/dev/null
  docker compose run --rm -T api node dist/seed.js >/dev/null
  echo "$workers worker(s): posting $RUNS runs"
  docker run --rm --network adsagent_default -v "$PWD/bench:/scripts:ro" -v "$RESULTS:/results" \
    -e RUNS="$RUNS" -e WORKERS="$workers" grafana/k6:1.2.3 run --quiet /scripts/enqueue.js >/dev/null
  for _ in $(seq 1 600); do
    [ "$(sql "SELECT count(*) FROM agent_jobs WHERE status IN ('queued', 'running')")" = 0 ] && break
    sleep 1
  done
  read -r n done failed retried secs rate p50 p95 <<<"$(sql "
    SELECT count(*), count(*) FILTER (WHERE status = 'done'), count(*) FILTER (WHERE status = 'failed'),
           count(*) FILTER (WHERE attempts > 1),
           round(extract(epoch FROM max(updated_at) - min(created_at))::numeric, 1),
           round((count(*) / extract(epoch FROM max(updated_at) - min(created_at)))::numeric, 0),
           round(1000 * percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM updated_at - created_at))::numeric, 0),
           round(1000 * percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM updated_at - created_at))::numeric, 0)
    FROM agent_jobs" | tr '|' ' ')"
  read -r enq_rps enq_p95 <<<"$(python3 - "$RESULTS/enqueue-$workers.json" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))["metrics"]
print(f'{m["http_reqs"]["values"]["rate"]:.0f} {m["http_req_duration"]["values"]["p(95)"]:.1f}')
EOF
)"
  echo "  $done done in ${secs}s = $rate runs/s"
  rows_md+="| $workers × 4 | $n | $done | $failed | $retried | $enq_rps | $enq_p95 | $secs | **$rate** | $p50 | $p95 |"$'\n'
done

{
  echo "Scripted demo model (no LLM latency): measures the API, the Postgres job queue, the agent loop and the SQL tools. $RUNS runs per row, posted by 20 clients at once."
  echo "Machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), Docker VM with $(docker info --format '{{.NCPU}}') CPUs shared by every container."
  echo
  echo "| workers × concurrency | jobs | done | failed | needed a 2nd attempt | enqueue req/s | enqueue p95 ms | seconds to drain | jobs/s | job latency p50 ms | job latency p95 ms |"
  echo "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
  printf '%s' "$rows_md"
  echo
  echo "Job latency = queued -> done, including the wait in the queue while all $RUNS were posted at once."
} | tee "$RESULTS/summary.md"
