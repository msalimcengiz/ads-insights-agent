"""Guided demo of ads-insights-agent. Runs with the scripted demo model unless
ANTHROPIC_API_KEY is set, in which case Claude answers. demo/run.sh stops and starts the
worker for the queue step."""

import os
import sys
import uuid

from lib import done, http, next_step, note, ok, show, step

API = "http://api:3000"
MODA = {"x-account-id": "acc_moda"}
EV = {"x-account-id": "acc_ev"}
REAL = os.environ.get("REAL_MODEL") == "1"


def ask(message: str, account: dict = MODA, key: str | None = None) -> tuple[dict, dict]:
    headers = dict(account, **({"Idempotency-Key": key} if key else {}))
    r = http("POST", f"{API}/v1/runs", {"message": message}, headers)
    ok(r.status in (200, 202), f'queued: "{message}" → job {r.json()["job_id"][:8]}…')
    job = http("GET", f"{API}/v1/jobs/{r.json()['job_id']}?wait=30", headers=account, timeout=40).json()
    if job["status"] == "failed":
        print(f"   job failed: {job['last_error']}")
        sys.exit(1)
    return r.json(), job


def trace(job: dict) -> None:
    for t in job["result"]["tool_calls"]:
        note(f"tool {t['name']}({_short(t['input'])}) → {'ok' if t['ok'] else 'error: ' + str(t.get('error'))}")
    note(f"answer: {job['result']['answer']}")
    u = job["result"]["usage"]["this_turn"]
    note(f"{u['requests']} model calls · {u['input_tokens']} in / {u['output_tokens']} out tokens · ${u['cost_usd']:.4f}")


def _short(v: dict) -> str:
    s = ", ".join(f"{k}={v[k]}" for k in v)
    return s[:90] + ("…" if len(s) > 90 else "")


def analysis() -> None:
    who = "Claude" if REAL else "the scripted demo model (no API key set)"
    step(f"A question is queued, a worker runs the agent loop with {who}, the client polls the job")
    _, job = ask("Son günlerde performansı aniden bozulan bir kampanya var mı?")
    trace(job)
    ok(job["status"] == "done" and any(t["name"] == "detect_anomalies" for t in job["result"]["tool_calls"]),
       "the agent queried the database through detect_anomalies")
    ok("UGC" in job["result"]["answer"] or "Kombin" in job["result"]["answer"],
       "it found the planted CTR collapse in the TikTok UGC campaign")

    step("The same Idempotency-Key returns the same job instead of running (and paying for) it twice")
    key = f"q-{uuid.uuid4()}"
    first, _ = ask("Son 7 günde ROAS'ı en yüksek kampanyam hangisi?", key=key)
    again = http("POST", f"{API}/v1/runs", {"message": "Son 7 günde ROAS'ı en yüksek kampanyam hangisi?"}, dict(MODA, **{"Idempotency-Key": key}))
    ok(again.status == 200 and again.json()["job_id"] == first["job_id"], "200 with the original job id")


def approval() -> None:
    step("Writes are proposals: the agent cannot pause a campaign, a person approves it")
    _, job = ask("Display - Prospecting kampanyasını durdur, hiç satış getirmiyor.")
    trace(job)
    pending = http("GET", f"{API}/v1/actions?status=pending", headers=MODA).json()
    action = next(a for a in pending if a["campaign_id"] == "c09")
    show(http("GET", f"{API}/v1/actions?status=pending", headers=MODA), 260)
    ok(action["kind"] == "pause_campaign", "a pending pause_campaign proposal exists; the campaign itself is untouched")

    r = http("POST", f"{API}/v1/actions/{action['id']}/approve", headers=MODA)
    show(r)
    ok(r.status == 200 and r.json()["status"] == "approved", "approved: the change is applied in a locked transaction")
    r = http("POST", f"{API}/v1/actions/{action['id']}/approve", headers=MODA)
    ok(r.status == 409, "approving the same proposal again is rejected (409)")

    step("Guardrails are code, not prompt: tripling a budget is refused, the agent proposes the allowed maximum")
    _, job = ask("Marka Araması kampanyasının günlük bütçesini 3 katına çıkar.")
    trace(job)
    calls = job["result"]["tool_calls"]
    ok(any(not t["ok"] and "50%" in str(t.get("error")) for t in calls), "the tool rejected the change (±50% limit)")
    budgets = [a["params"].get("to") for a in http("GET", f"{API}/v1/actions?status=pending", headers=MODA).json() if a["campaign_id"] == "c03"]
    ok(budgets and all(b <= 1200 for b in budgets), f"pending proposal(s) stay within +50%: {budgets} TRY (current 800)")

    step("Tenant isolation: another account cannot see or approve these proposals")
    ok(http("GET", f"{API}/v1/actions", headers=EV).json() == [] or all(
        a["campaign_id"] not in ("c03", "c09") for a in http("GET", f"{API}/v1/actions", headers=EV).json()),
       "acc_ev sees none of acc_moda's proposals")
    other = next(a for a in http("GET", f"{API}/v1/actions?status=pending", headers=MODA).json() if a["campaign_id"] == "c03")
    r = http("POST", f"{API}/v1/actions/{other['id']}/approve", headers=EV)
    ok(r.status == 409 and "not found" in r.json()["error"], "approving it as acc_ev: 'action not found'")
    r = http("POST", f"{API}/v1/runs", {"message": "x"}, {"x-account-id": "acc_unknown"})
    ok(r.status == 401, "an unknown account is rejected")


def queue_enqueue() -> None:
    step("The worker is stopped: requests are still accepted and wait in the queue")
    r = http("POST", f"{API}/v1/runs", {"message": "Kampanyalarımı listele"}, MODA)
    job = http("GET", f"{API}/v1/jobs/{r.json()['job_id']}?wait=2", headers=MODA).json()
    ok(job["status"] == "queued", "job is 'queued' while no worker is running")
    open("/tmp/job", "w").write(r.json()["job_id"])


def queue_done() -> None:
    step("The worker is back and picks the job up")
    job = http("GET", f"{API}/v1/jobs/{open('/tmp/job').read()}?wait=30", headers=MODA, timeout=40).json()
    ok(job["status"] == "done", f"done after {job['attempts']} attempt(s): {job['result']['answer'][:90]}")
    done("queued runs with polling, idempotency, real SQL tools, human approval, code guardrails, tenant isolation.")


{"analysis": analysis, "approval": approval, "queue_enqueue": queue_enqueue, "queue_done": queue_done}[sys.argv[1]]()
with open("/tmp/next_step", "w") as f:
    f.write(str(next_step()))
