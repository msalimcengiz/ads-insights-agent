NODE := docker run --rm -v $(CURDIR):/app -w /app node:24-alpine
# Tests run against ads_test, never the database the demo worker is using.
NODE_DB := docker run --rm --network adsagent_default -v $(CURDIR):/app -w /app \
	-e DATABASE_URL=postgres://ads:ads@postgres:5432/ads_test node:24-alpine

.PHONY: demo up down install check test bench eval

demo:        ## Guided tour (~1 min). Uses the scripted demo model unless ANTHROPIC_API_KEY is set
	./demo/run.sh

node_modules: package-lock.json
	$(NODE) npm ci --no-fund --no-audit
	@touch node_modules

install: node_modules

up:          ## API :3001, worker, Postgres (seeded). Needs ANTHROPIC_API_KEY or AGENT_MODEL=demo
	docker compose up -d --build --wait
	docker compose run --rm -T api node dist/seed.js

down:
	docker compose down -v

check: node_modules   ## typecheck + lint
	$(NODE) sh -c 'npm run typecheck && npm run lint'

test: node_modules    ## 41 tests: tools on Postgres, agent loop, job queue, eval graders
	docker compose up -d --wait postgres
	$(NODE_DB) npm test

bench:       ## job queue throughput with the demo model and 1/2/4 workers (no LLM latency)
	./bench/run.sh

eval: node_modules    ## 12 cases against the real Claude API (needs ANTHROPIC_API_KEY, costs money)
	docker compose up -d --wait postgres
	docker run --rm --network adsagent_default -v $(CURDIR):/app -w /app -e ANTHROPIC_API_KEY \
		-e DATABASE_URL=postgres://ads:ads@postgres:5432/ads node:24-alpine npm run eval
