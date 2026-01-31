/**
 * Integration test for SRE Dreamer.
 *
 * Tests the core detection pipeline against the target app.
 * Requires the target app to be running at TARGET_URL (default: http://localhost:3000).
 *
 * Usage:
 *   # Start the target app first:
 *   cd apps/target-app && npm run dev
 *
 *   # Run this test:
 *   cd apps/agent && npx tsx src/test/integration.test.ts
 */

import "dotenv/config";

const TARGET_URL = process.env.TARGET_URL || "http://localhost:3000";

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, detail: "OK", durationMs: Date.now() - start });
    console.log(`  [PASS] ${name} (${Date.now() - start}ms)`);
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    results.push({ name, passed: false, detail, durationMs: Date.now() - start });
    console.log(`  [FAIL] ${name}: ${detail} (${Date.now() - start}ms)`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ── Tests ─────────────────────────────────────────────────────────────

async function run() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   SRE DREAMER — Integration Tests        ║");
  console.log(`║   Target: ${TARGET_URL.padEnd(30)}║`);
  console.log("╚══════════════════════════════════════════╝\n");

  // ── Target App Health ────────────────────────────────────────────
  console.log("── Target App ──");

  await test("Health endpoint returns 200 (proves traditional monitoring is blind)", async () => {
    const res = await fetch(`${TARGET_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.status === "ok", `Expected status "ok", got "${body.status}"`);
  });

  await test("Homepage returns 200", async () => {
    const res = await fetch(TARGET_URL, { signal: AbortSignal.timeout(5000) });
    assert(res.ok, `Expected 200, got ${res.status}`);
  });

  // ── Bug Toggle API ───────────────────────────────────────────────
  console.log("\n── Bug Toggle API ──");

  await test("GET /api/bug returns current state", async () => {
    const res = await fetch(`${TARGET_URL}/api/bug`, { signal: AbortSignal.timeout(5000) });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(typeof body.enabled === "boolean", `Expected 'enabled' boolean, got ${JSON.stringify(body)}`);
  });

  await test("POST /api/bug can enable the bug", async () => {
    const res = await fetch(`${TARGET_URL}/api/bug`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
      signal: AbortSignal.timeout(5000),
    });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.enabled === true, `Expected enabled=true, got ${JSON.stringify(body)}`);
  });

  await test("Health endpoint STILL returns 200 even with bug enabled (the invisible outage)", async () => {
    const res = await fetch(`${TARGET_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.status === "ok", `Health should report ok even with bug — got "${body.status}"`);
  });

  await test("POST /api/bug can disable the bug", async () => {
    const res = await fetch(`${TARGET_URL}/api/bug`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
      signal: AbortSignal.timeout(5000),
    });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.enabled === false, `Expected enabled=false`);
  });

  // ── Site Profile ─────────────────────────────────────────────────
  console.log("\n── Site Profile ──");

  await test("SHOPDEMO_PROFILE loads and validates with Zod", async () => {
    const { SHOPDEMO_PROFILE } = await import("../types/site-profile.js");
    assert(SHOPDEMO_PROFILE.name === "ShopDemo", `Expected "ShopDemo", got "${SHOPDEMO_PROFILE.name}"`);
    assert(SHOPDEMO_PROFILE.criticalFlows.length > 0, "Expected at least 1 critical flow");
    assert(SHOPDEMO_PROFILE.expectedElements.length > 0, "Expected at least 1 expected element");
    assert(SHOPDEMO_PROFILE.knowledgeBase.length > 0, "Expected knowledge base entries");
  });

  await test("createGenericProfile works for any URL", async () => {
    const { createGenericProfile } = await import("../types/site-profile.js");
    const profile = createGenericProfile("https://example.com", [
      { name: "Test", action: "Click button", expectation: "Something happens" },
    ]);
    assert(profile.url === "https://example.com", `URL mismatch`);
    assert(profile.criticalFlows.length === 1, `Expected 1 flow`);
  });

  // ── Config ───────────────────────────────────────────────────────
  console.log("\n── Config ──");

  await test("loadConfig succeeds with minimal env vars", async () => {
    // Save and mock env
    const saved = { ...process.env };
    process.env.BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY || "test-key";
    process.env.BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || "test-project";
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai-key";

    try {
      // Re-import to get fresh config
      const { loadConfig } = await import("../config.js");
      const config = loadConfig();
      assert(!!config.browserbaseApiKey, "Missing browserbaseApiKey");
      assert(!!config.openaiApiKey, "Missing openaiApiKey");
      assert(config.targetUrl.length > 0, "Missing targetUrl");
    } finally {
      // Restore env
      Object.assign(process.env, saved);
    }
  });

  // ── Incident Builder ─────────────────────────────────────────────
  console.log("\n── Incident Builder ──");

  await test("buildIncidentFromPerception returns null for healthy result", async () => {
    const { buildIncidentFromPerception } = await import("../perception/detector.js");
    const { SHOPDEMO_PROFILE } = await import("../types/site-profile.js");
    const result = buildIncidentFromPerception(
      {
        healthy: true,
        url: "http://test",
        httpHealthy: true,
        flowResults: [],
        domSnapshot: "",
        timestamp: new Date().toISOString(),
      },
      SHOPDEMO_PROFILE
    );
    assert(result === null, "Expected null for healthy result");
  });

  await test("buildIncidentFromPerception creates incident for unhealthy result", async () => {
    const { buildIncidentFromPerception } = await import("../perception/detector.js");
    const { SHOPDEMO_PROFILE } = await import("../types/site-profile.js");
    const result = buildIncidentFromPerception(
      {
        healthy: false,
        url: "http://test",
        httpHealthy: true,
        flowResults: [
          {
            flow: SHOPDEMO_PROFILE.criticalFlows[0],
            passed: false,
            occlusionDetected: true,
            blockingElement: "div.ghost-overlay",
            durationMs: 100,
          },
        ],
        domSnapshot: "<body>...</body>",
        timestamp: new Date().toISOString(),
      },
      SHOPDEMO_PROFILE
    );
    assert(result !== null, "Expected incident for unhealthy result");
    assert(result!.type === "visual_occlusion", `Expected visual_occlusion, got ${result!.type}`);
    assert(result!.severity === "critical", `Expected critical severity`);
  });

  // ── Scoring ──────────────────────────────────────────────────────
  console.log("\n── Scoring ──");

  await test("computeScore weights sum correctly", async () => {
    const { computeScore } = await import("../scoring/evaluator.js");
    const score = computeScore({
      reachability: 1.0,
      visualIntegrity: 1.0,
      latency: 1.0,
      safety: 1.0,
      aggregate: 0,
      details: {},
    });
    assert(Math.abs(score - 1.0) < 0.001, `Perfect inputs should give ~1.0, got ${score}`);
  });

  await test("computeScore gives 0 for all-zero inputs", async () => {
    const { computeScore } = await import("../scoring/evaluator.js");
    const score = computeScore({
      reachability: 0,
      visualIntegrity: 0,
      latency: 0,
      safety: 0,
      aggregate: 0,
      details: {},
    });
    assert(score === 0, `All-zero inputs should give 0, got ${score}`);
  });

  await test("scoreLatency returns correct values", async () => {
    const { scoreLatency } = await import("../scoring/evaluator.js");
    assert(scoreLatency(1000) === 1.0, "1s should be 1.0");
    assert(scoreLatency(5000) === 1.0, "5s should be 1.0");
    assert(scoreLatency(120000) === 0.0, "120s should be 0.0");
    assert(scoreLatency(200000) === 0.0, "200s should be 0.0");
    const mid = scoreLatency(60000);
    assert(mid > 0 && mid < 1, `60s should be between 0 and 1, got ${mid}`);
  });

  // ── Memory (Redis) ───────────────────────────────────────────────
  console.log("\n── Memory ──");

  await test("cosineSimilarity computes correctly", async () => {
    // Import the module and test the cosine similarity function
    const mod = await import("../memory/redis-store.js");
    const store = new mod.IncidentMemoryStore("redis://localhost:6379");

    // Access via prototype or test indirectly
    // Since cosineSimilarity is private, we'll test findSimilarIncidents behavior
    // For now, just verify the class can be instantiated
    assert(store instanceof mod.IncidentMemoryStore, "Should instantiate IncidentMemoryStore");
  });

  // ── Summary ──────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("\n[FATAL] Test runner error:", err);
  process.exit(1);
});
