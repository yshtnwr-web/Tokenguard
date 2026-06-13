# TokenGuard

TokenGuard is a small proxy server that sits between your company and AI providers. Your app sends requests to TokenGuard instead of calling OpenAI or Anthropic directly. TokenGuard forwards the request, logs token cost, watches for runaway loops, enforces team budgets, and returns the provider response.

## Setup

```bash
npm install
```

Edit `config.json`:

```json
{
  "teams": {
    "engineering": { "monthlyBudget": 500 },
    "marketing": { "monthlyBudget": 100 },
    "default": { "monthlyBudget": 200 }
  },
  "providers": {
    "openai": { "apiKey": "sk-your-openai-key" },
    "anthropic": { "apiKey": "sk-ant-your-anthropic-key" }
  }
}
```

## Run

```bash
node index.js
```

The proxy starts at:

```text
http://localhost:3000
```

The dashboard is available at:

```text
http://localhost:3000/dashboard
```

## Point Existing OpenAI Code To TokenGuard

Keep your normal OpenAI request shape. Change only the base URL:

```text
http://localhost:3000
```

For example, calls that used to go to:

```text
https://api.openai.com/v1/chat/completions
```

should now go to:

```text
http://localhost:3000/v1/chat/completions
```

Add these optional headers so TokenGuard can track team spend and agent sessions:

```text
x-tokenguard-team: engineering
x-tokenguard-session: user-or-agent-session-id
```

## Test With Curl

OpenAI-compatible request:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-tokenguard-team: engineering" \
  -H "x-tokenguard-session: demo-session-1" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      { "role": "user", "content": "Say hello from TokenGuard." }
    ]
  }'
```

Anthropic request:

```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-tokenguard-team: engineering" \
  -H "x-tokenguard-session: demo-session-2" \
  -d '{
    "model": "claude-sonnet-4",
    "max_tokens": 128,
    "messages": [
      { "role": "user", "content": "Say hello from TokenGuard." }
    ]
  }'
```

## What Gets Logged

Every provider response is stored in `tokenguard.sqlite` with:

- timestamp
- provider
- team
- session ID
- model
- input tokens
- output tokens
- estimated cost in USD
- estimated savings compared with using GPT-4o for the same token volume
- request duration
- provider status code

## Budget Rules

Team budgets live in `config.json`.

- At 80% of monthly budget, TokenGuard adds this response header: `x-tokenguard-warning: budget-80-percent`
- At 100% of monthly budget, TokenGuard blocks new requests with HTTP `402`

## Loop Detection

TokenGuard tracks `x-tokenguard-session`.

If one session makes more than 10 requests in 60 seconds without a successful provider response, TokenGuard blocks the next request with HTTP `429`:

```text
TokenGuard: Potential agent loop detected. Request blocked to prevent cost overrun.
```

## Notes For Reviewers

The implementation is intentionally plain JavaScript with minimal dependencies:

- `index.js` handles HTTP routes, provider forwarding, budget checks, and response transparency.
- `db.js` owns SQLite tables and dashboard queries.
- `pricing.js` owns model pricing and cost math.
- `loop-detector.js` owns session loop protection.
- `router.js` owns smart model routing, classification, fallback planning, caching, and quality checks.
- `dashboard.html` is static HTML, CSS, and JavaScript with no build step.

## Smart Model Routing

TokenGuard can automatically route expensive model requests to cheaper models when the local classifier decides the cheaper model is likely to handle the work well.

### How The Local Classifier Works

The classifier runs locally in JavaScript. It does not call any external API, does not add provider cost, and uses no extra dependencies.

It reads:

- total character count across all messages
- system prompt length
- number of messages
- code indicators like `function`, `class`, `import`, `debug`, `refactor`, `python`, and `code`
- complex reasoning indicators like `architecture`, `legal`, `medical`, `strategy`, `deep dive`, and `reason through`
- simple task indicators like `summarize`, `extract`, `translate`, `fix grammar`, and `yes or no`
- agentic indicators like `tool_call`, `function_call`, `agent`, `previous step`, and `next step`

Classification results include tier, confidence, `has_code`, and `is_agentic`. If confidence is below the configured threshold, TokenGuard keeps the original model.

### What Each Tier Means

- `simple`: short extraction, tagging, translation, spelling, grammar, or yes/no style work.
- `medium`: moderate length requests, simple code requests, or longer simple-task prompts.
- `complex`: long prompts, complex reasoning, sophisticated system prompts, code-heavy requests, or deep multi-turn conversations.

Agentic requests are detected separately. By default, agentic traffic is never downgraded.

### Routing Tables

OpenAI:

- simple or medium without code routes to `gpt-4o-mini`
- medium with code routes to `gpt-4o`
- complex routes to `gpt-4o`
- agentic or low-confidence requests keep the original model

Anthropic:

- simple or medium without code routes to `claude-haiku-4-5`
- medium with code routes to `claude-sonnet-4-6`
- complex routes to `claude-opus-4`
- agentic or low-confidence requests keep the original model

### Override Headers

Use these on any proxied request:

```text
x-proxy-no-route: true
x-proxy-force-model: gpt-4o-mini
x-proxy-min-tier: simple
x-proxy-no-cache: true
```

`x-proxy-no-route` skips smart routing. `x-proxy-force-model` sends the request to a specific model. `x-proxy-min-tier` prevents routing below `simple`, `medium`, or `complex`. `x-proxy-no-cache` forces fresh classification.

TokenGuard also accepts `x-proxy-team` for team spend tracking. The older `x-tokenguard-team` header still works.

### Routing Config

`config.json` includes:

```json
{
  "routing": {
    "enabled": true,
    "min_confidence_threshold": 0.65,
    "allow_code_downgrade": true,
    "allow_agentic_downgrade": false,
    "quality_check_enabled": true,
    "auto_retry_on_quality_fail": true,
    "classifier_cache_enabled": true,
    "classifier_cache_ttl_minutes": 60,
    "min_savings_threshold_usd": 0.001,
    "multi_provider_fallback_enabled": true
  }
}
```

You can inspect and update routing config without restarting:

```bash
curl http://localhost:3000/api/routing-config
curl -X POST http://localhost:3000/api/routing-config \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true, "min_confidence_threshold": 0.7 }'
```

### How Savings Are Calculated

Before routing, TokenGuard estimates input tokens as characters divided by 4 with a 10% safety buffer. It estimates output tokens from `max_tokens` or `max_completion_tokens` when present, otherwise it uses a conservative default.

If projected savings are below `min_savings_threshold_usd`, routing is skipped. After the response, actual usage from the provider is logged and savings are recalculated as:

```text
original model cost - actual model cost
```

### Quality Checks And Fallbacks

For non-streaming responses, cheaper-model output is checked before returning:

- empty or too-short response
- possible refusal-style content such as `I cannot`
- truncation where the response ends mid-sentence and finish reason is not `stop`

On a quality failure, TokenGuard retries with a stronger model. If that works, the response includes:

```text
x-proxy-quality-fallback: true
```

If the routed provider/model fails, TokenGuard tries the next tier up, then an equivalent model on the other provider if configured, then the original requested model. Routing failures are logged internally and should fall back to the original model whenever possible.

Streaming responses are forwarded chunk by chunk immediately. If a stream fails after chunks have started, TokenGuard logs the failure and ends the stream; it does not retry mid-stream because that would break the caller's SSE response.

### Classification Cache

Routing decisions are cached in memory by SHA256 hash of the `messages` array. Defaults:

- TTL: 60 minutes
- max entries: 1000
- only cached when confidence is above 0.75

Cache hits skip classification but still run budget checks, loop detection, and provider forwarding.

### Routing Dashboard

Open:

```text
http://localhost:3000/dashboard
```

The Routing Intelligence section shows:

- total saved through routing this month
- requests routed to cheaper models
- routing success rate
- average classifier confidence
- quality fallback rate
- cache hit rate
- daily savings chart
- tier distribution chart
- routing efficiency chart
- recent routing decisions table

Routing data is also available through:

```text
GET /api/routing-stats
GET /api/routing-logs?limit=50&offset=0
GET /api/routing-config
POST /api/routing-config
```

### Known Limitations And Edge Cases

- The classifier is intentionally fast and local, so it uses deterministic heuristics rather than semantic model calls.
- Very short prompts can have savings below the configured threshold and will not be routed.
- Unknown model names use the default pricing fallback for estimates, so add pricing entries before relying on savings reports for custom models.
- Streaming quality cannot be checked before delivery because chunks are forwarded immediately.
- If neither provider key is configured, TokenGuard cannot complete fallback and returns a clear provider configuration error.

## Pre-flight Cost Estimation

Pre-flight estimation predicts cost before a request reaches OpenAI or Anthropic. This prevents accidental overruns before spend happens, instead of only reporting the bill after the provider response comes back.

### What It Does

Before forwarding a request, TokenGuard estimates:

- input tokens from message characters, message overhead, role overhead, system prompts, tool definitions, and a 15% buffer
- output tokens from `max_tokens` or `max_completion_tokens`, or model defaults
- estimated cost using `pricing.js`
- agentic risk, with a configurable chain multiplier for likely multi-call agent workflows

If the estimate is low, the request passes. If it is high but below the block threshold, the request passes with:

```text
x-preflight-warning: estimated-cost-high
```

Every preflight-enabled response includes:

```text
x-preflight-estimated-cost: 0.043000
```

### Team Thresholds

Each team can configure pre-flight independently in `config.json`:

```json
{
  "monthlyBudget": 500,
  "preflight": {
    "enabled": true,
    "warn_above_usd": 0.05,
    "block_above_usd": 0.20,
    "agentic_block_above_usd": 0.50,
    "approval_timeout_minutes": 10,
    "auto_approve_if_similar_approved": true,
    "agentic_chain_multiplier": 8
  }
}
```

Use this header to disable pre-flight for a specific request:

```text
x-proxy-no-preflight: true
```

### Approval Workflow

When a request exceeds the block threshold, TokenGuard stores it in `pending_approvals` and holds the original HTTP connection open. It polls every 2 seconds for up to the team's approval timeout, capped at 10 minutes.

If approved, the original request continues to the provider and the caller receives the normal model response. If rejected or timed out, the caller receives HTTP `402` with the approval details.

Approval pages are available at:

```text
http://localhost:3000/approve/{approval_id}
```

The page is self-contained HTML with the estimated cost, team, session, model, request preview, approve button, reject button, and countdown timer.

Dashboard endpoints:

```text
GET /api/pending-approvals
GET /api/approval-stats
```

### Agentic Detection

Pre-flight treats a call as agentic when:

- the request has more than 2 tools
- message history contains prior tool calls or tool results
- the same session has made more than 3 requests in 60 seconds
- the body contains `function_call`

Agentic estimates are multiplied by `agentic_chain_multiplier`, default `8`, because one user action often triggers multiple LLM calls.

### Similar Call Memory

When a blocked call is approved, TokenGuard stores an in-memory fingerprint for 1 hour. The fingerprint includes:

- model
- team
- first 100 characters of the system prompt
- request type classification

If a later blocked request has the same fingerprint and `auto_approve_if_similar_approved` is enabled, it proceeds silently with:

```text
x-preflight-auto-approved: true
```

### Dashboard Accuracy

The dashboard includes a Pre-flight Intelligence section with:

- total blocked calls this month
- estimated savings from rejected or timed-out calls
- pending approvals
- estimation accuracy
- average estimation time
- pending approval actions
- approval history

After an approved call completes, TokenGuard compares estimated cost against actual provider usage. If the estimate is within 30%, it marks the approval as accurate. Routing logs also store `preflight_actual_cost_usd` and `preflight_accuracy_pct`.

### Known Limitations

- Output token estimation is approximate because providers only know final usage after generation.
- Agentic chain depth is estimated, not measured ahead of time.
- Streaming responses cannot be quality-checked or fully cost-verified until chunks finish.
- Similar-call approvals are stored in memory, so they reset when the server restarts.
