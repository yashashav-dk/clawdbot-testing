# SRE Dreamer

Autonomous visual regression detection and remediation agent for WeaveHacks 3.

## The Problem

Traditional monitoring (HTTP checks, metrics, logs) returns `200 OK` even when a CSS z-index bug makes your entire UI unclickable. Users see a working page but can't interact with it. Your alerts stay silent.

## The Solution

SRE Dreamer detects "invisible" outages by **seeing** the app through a browser — the same way a user does. When it finds a problem, it **dreams** — spinning up parallel sandboxed browsers to test different fixes — then applies the best one.

### The Cognitive Loop

```
PERCEIVE  →  DREAM  →  ACT  →  LEARN
   ↑                              │
   └──────────────────────────────┘
```

1. **Perceive** — Stagehand + Browserbase: navigate the app, click buttons, detect occlusion errors
2. **Dream** — Parallel Browserbase sessions: simulate CSS patches, rollbacks, DOM removal
3. **Act** — Execute the winning strategy (Vercel rollback, hotfix deployment)
4. **Learn** — Store the incident in Redis so next time, the agent is faster

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Perception | [Stagehand](https://docs.stagehand.dev) | Natural-language browser interaction |
| Infrastructure | [Browserbase](https://browserbase.com) | Ephemeral sandboxed browsers |
| Reasoning | [W&B Weave](https://wandb.ai/site/agents) | Tracing, evaluation, scoring |
| Memory | [Redis](https://redis.io) | Incident history + vector retrieval |
| Target | [Next.js](https://nextjs.org) + [Vercel](https://vercel.com) | Demo app with programmatic rollback |

## Project Structure

```
sre-dreamer/
├── apps/
│   ├── target-app/           # Next.js app with toggleable z-index bug
│   │   └── src/app/
│   │       ├── page.tsx      # Main page with ghost overlay bug
│   │       └── api/health/   # Always-200 health endpoint
│   └── agent/                # The SRE Dreamer agent
│       └── src/
│           ├── perception/   # Visual health checks via Stagehand
│           ├── dreamer/      # Parallel dream simulation engine
│           ├── scoring/      # Multi-dimensional fix evaluation
│           ├── actions/      # Vercel rollback, CSS patches
│           ├── memory/       # Redis incident store
│           ├── index.ts      # Main orchestrator
│           └── cli.ts        # CLI entry point
├── .env.example              # Required environment variables
└── package.json              # Workspace root
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
# Visual health check only (perception layer)
npm run agent:detect

# Full autonomous cycle (perceive → dream → act → learn)
npm run agent:run

# View stored incident memories
npm run agent:memory
```

## The Demo Scenario

1. **Good state**: ShopDemo app is deployed and working. Login button is clickable.
2. **Bad deployment**: A "ghost overlay" `div` with `z-index: 9999` covers the entire page. HTTP health check still returns 200.
3. **Agent detects**: Stagehand tries to click Login, gets an occlusion error.
4. **Agent dreams**: 3 parallel Browserbase sessions test CSS patch, DOM removal, and rollback.
5. **Agent acts**: Best strategy (rollback) is executed via Vercel API.
6. **Agent learns**: Incident stored in Redis for future reference.

## Architecture Decisions

- **Stagehand over Playwright selectors**: Natural language actions are resilient to UI changes. `act("Click login")` works even if the button ID changes.
- **Parallel dreams**: `Promise.allSettled` runs all simulations concurrently. Each dream is an isolated Browserbase session.
- **Weighted scoring**: Fixes are evaluated on reachability (40%), visual integrity (25%), safety (20%), and latency (15%).
- **Redis memory**: Simple type-based retrieval now, extensible to vector similarity search with RedisVL.
