# SRE Dreamer

Autonomous visual regression detection and remediation agent for WeaveHacks 3.

## The Problem

Traditional monitoring (HTTP checks, metrics, logs) returns `200 OK` even when a CSS z-index bug makes your entire UI unclickable. Users see a working page but can't interact with it. Your alerts stay silent.

## The Solution

SRE Dreamer detects "invisible" outages by **seeing** the app through a browser — the same way a user does. When it finds a problem, it **dreams** — spinning up parallel sandboxed browsers to test different fixes — then applies the best one.

Works on **any website** — not just the demo app.

### The Cognitive Loop

```
PERCEIVE  →  DIAGNOSE  →  DREAM  →  ACT  →  VERIFY  →  LEARN
   ↑                                                      │
   └──────────────────────────────────────────────────────┘
```

1. **Perceive** — Stagehand + Browserbase: run configurable critical user flows against any site
2. **Diagnose** — LLM root cause analysis: reason about DOM snapshots and error patterns
3. **Dream** — Parallel Browserbase sessions: simulate CSS patches, rollbacks, JS injection, DOM removal
4. **Act** — Pluggable actions: Vercel rollback, GitHub issue, Slack alert, webhook, or script
5. **Verify** — Re-run perception after the fix to confirm resolution
6. **Learn** — Store incident + vector embedding in Redis for semantic retrieval next time

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Perception | [Stagehand](https://docs.stagehand.dev) | Natural-language browser interaction |
| Infrastructure | [Browserbase](https://browserbase.com) | Ephemeral sandboxed browsers + session replay |
| Reasoning | [OpenAI](https://openai.com) / [Cerebras](https://cerebras.ai) | Root cause diagnosis, visual assessment, post-mortems |
| Evaluation | [W&B Weave](https://wandb.ai/site/agents) | Tracing, evaluation, scoring |
| Memory | [Redis](https://redis.io) | Incident history + vector similarity search |
| Target | [Next.js](https://nextjs.org) + [Vercel](https://vercel.com) | Demo app with programmatic rollback |

## Project Structure

```
sre-dreamer/
├── apps/
│   ├── target-app/              # Next.js app with toggleable z-index bug
│   │   └── src/app/
│   │       ├── page.tsx         # Main page with ghost overlay bug
│   │       └── api/
│   │           ├── health/      # Always-200 health endpoint
│   │           └── bug/         # Bug toggle API for demo automation
│   └── agent/                   # The SRE Dreamer agent
│       └── src/
│           ├── perception/      # Site-agnostic visual health checks
│           ├── reasoning/       # LLM root cause diagnosis + post-mortems
│           ├── dreamer/         # Parallel dream simulation engine
│           ├── scoring/         # Multi-dimensional evaluation (DOM + LLM)
│           ├── actions/         # Pluggable: Vercel, GitHub, Slack, webhook, script
│           ├── memory/          # Redis + vector embeddings + cosine similarity
│           ├── types/           # Core types + site profile system
│           ├── index.ts         # Main orchestrator (profile-driven)
│           └── cli.ts           # CLI with detect/dream/scan/memory commands
├── .env.example
└── package.json
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in API keys for Browserbase, Vercel, Redis, OpenAI

# 3. Run the target app locally
npm run dev:target

# 4. Run the agent
npm run agent:run
```

## CLI Commands

```bash
# Visual health check only (ShopDemo)
npm run agent:detect

# Full autonomous cycle (perceive → diagnose → dream → act → verify → learn)
npm run agent:run

# Scan ANY website with custom user flows
npm run agent:scan -- https://example.com "Click the login button" "Submit the contact form"

# View stored incident memories
npm run agent:memory

# Memory statistics
npm run agent:memory:stats
```

## Scanning Any Website

The `scan` command makes the agent work against any URL:

```bash
# Scan a production site with specific user flows
npm run agent:scan -- https://myapp.com \
  "Click the Sign Up button" \
  "Fill in the email field and submit" \
  "Navigate to the pricing page"

# Quick smoke test — checks if the main CTA is clickable
npm run agent:scan -- https://myapp.com
```

For sites you own, you can create a **Site Profile** (see `apps/agent/src/types/site-profile.ts`) that defines:
- Critical user flows with verification methods (selector, visual, URL change)
- Expected visual elements
- Remediation actions (Vercel rollback, GitHub issue, Slack alert, webhook)
- Domain-specific knowledge base for the LLM

## The Demo Scenario

1. **Good state**: ShopDemo app is deployed and working. Login button is clickable.
2. **Bad deployment**: A "ghost overlay" `div` with `z-index: 9999` covers the entire page. HTTP health check still returns 200.
3. **Agent perceives**: Stagehand runs all critical flows, detects occlusion on Login.
4. **Agent diagnoses**: LLM analyzes DOM snapshot, identifies z-index overlap, suggests strategies.
5. **Agent dreams**: 3+ parallel Browserbase sessions test CSS patch, JS injection, DOM removal, rollback.
6. **Agent acts**: Best strategy (rollback) is executed via Vercel API.
7. **Agent verifies**: Re-runs perception to confirm the site is healthy.
8. **Agent learns**: Incident + vector embedding stored in Redis. Next time, it's faster.

## Architecture Decisions

- **Site Profile system**: Decouples the agent from any specific target. Define flows, elements, and actions for any website via a typed schema.
- **LLM reasoning pipeline**: Root cause diagnosis via OpenAI/Cerebras. The agent doesn't just pattern-match errors — it reasons about DOM structure, stacking contexts, and CSS inheritance.
- **Vector memory**: Incidents are embedded via `text-embedding-3-small` and stored in Redis. Similar incidents are found via cosine similarity, not just type matching. This is the "self-improving" mechanism.
- **Pluggable actions**: Remediation isn't limited to Vercel rollback. GitHub issues, Slack alerts, webhooks, and custom scripts are all supported via the action dispatcher.
- **Post-incident verification**: After acting, the agent re-runs perception to confirm the fix worked. This closes the loop and provides confidence scoring.
- **Parallel dreams**: `Promise.allSettled` runs all simulations concurrently. Each dream is an isolated Browserbase session with its own replay URL.
- **Weighted scoring**: Fixes are evaluated on reachability (40%), visual integrity (25%), safety (20%), and latency (15%). Visual integrity uses both DOM checks and LLM assessment.
