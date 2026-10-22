#!/usr/bin/env bash
# Guided demo. Without ANTHROPIC_API_KEY it uses the scripted demo model (AGENT_MODEL=demo)
# so the queue, tools, guardrails and approvals can be tried without an account; with a
# key, Claude answers (and costs a few cents).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  export AGENT_MODEL=${AGENT_MODEL:-claude-opus-5-5}; REAL=1
  echo "ANTHROPIC_API_KEY is set: Claude ($AGENT_MODEL) will answer."
else
  export AGENT_MODEL=demo; REAL=0
  echo "No ANTHROPIC_API_KEY: using the scripted demo model. Set the key to run the same demo with Claude."
fi

STATE="$PWD/.demo-state"   # inside the project: Docker Desktop/Colima only share the home directory
rm -rf "$STATE" && mkdir -p "$STATE" && echo 1 > "$STATE/next_step"
py() {
  docker run --rm --network adsagent_default -v "$PWD/demo:/demo:ro" -v "$STATE:/tmp" -w /demo \
    -e DEMO_STEP="$(cat "$STATE/next_step")" -e REAL_MODEL="$REAL" python:3.13-alpine python -u demo.py "$1"
}
quiet() { "$@" >/dev/null 2>&1; }

echo "Starting the stack (API, worker, Postgres) and seeding demo ad data…"
quiet docker compose up -d --build --wait
docker compose run --rm -T api node dist/seed.js 2>/dev/null | sed 's/^/   seeded: /'

py analysis
py approval
quiet docker compose stop worker
py queue_enqueue
quiet docker compose up -d --wait worker
py queue_done
rm -rf "$STATE"
echo "Explore: requests.http · API http://localhost:3001 · stop → make down"
