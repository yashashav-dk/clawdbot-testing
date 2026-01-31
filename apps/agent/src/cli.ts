import "dotenv/config";

/**
 * CLI entry point for the SRE Dreamer agent.
 *
 * Usage:
 *   tsx src/cli.ts detect                  — Run perception only (ShopDemo)
 *   tsx src/cli.ts dream                   — Run full dream cycle (ShopDemo)
 *   tsx src/cli.ts demo                    — Run the complete demo sequence (ShopDemo)
 *   tsx src/cli.ts scan <url> <flow>...    — Scan any website with custom flows
 *   tsx src/cli.ts memory                  — Show stored incident memories
 *   tsx src/cli.ts memory:stats            — Show memory statistics
 */

const command = process.argv[2] ?? "demo";

async function main() {
  console.log("┌─────────────────────────────────────────┐");
  console.log("│         SRE DREAMER v0.2.0              │");
  console.log("│   Autonomous Visual Regression Agent     │");
  console.log("│   Now with LLM reasoning + any-site     │");
  console.log("└─────────────────────────────────────────┘");
  console.log();

  switch (command) {
    case "detect": {
      const { loadConfig } = await import("./config.js");
      const { runPerception } = await import("./perception/detector.js");
      const { SHOPDEMO_PROFILE } = await import("./types/site-profile.js");

      const config = loadConfig();
      const profile = { ...SHOPDEMO_PROFILE, url: config.targetUrl };

      console.log(`[CLI] Running perception on ${profile.name} (${profile.url})\n`);

      const result = await runPerception(profile, config);

      console.log("\n── Perception Result ──");
      console.log(`HTTP Status:      ${result.httpStatus ?? "N/A"}`);
      console.log(`HTTP Healthy:     ${result.httpHealthy}`);
      console.log(`Overall Healthy:  ${result.healthy}`);
      console.log(`Session Replay:   ${result.sessionReplayUrl ?? "N/A"}`);

      console.log("\n── Flow Results ──");
      for (const flow of result.flowResults) {
        const icon = flow.passed ? "+" : "-";
        console.log(
          `  [${icon}] ${flow.flow.name}: ${flow.passed ? "PASS" : "FAIL"} (${flow.durationMs}ms)`
        );
        if (flow.occlusionDetected) console.log(`      Occlusion detected`);
        if (flow.blockingElement) console.log(`      Blocker: ${flow.blockingElement}`);
        if (flow.errorMessage) console.log(`      Error: ${flow.errorMessage.slice(0, 100)}`);
      }
      break;
    }

    case "scan": {
      // Generic scan: tsx src/cli.ts scan https://example.com "Click login" "Click buy"
      const url = process.argv[3];
      if (!url) {
        console.error("Usage: tsx src/cli.ts scan <url> [action1] [action2] ...");
        process.exit(1);
      }

      const actions = process.argv.slice(4);
      if (actions.length === 0) {
        actions.push("Click the main call-to-action button");
      }

      const { loadConfig } = await import("./config.js");
      const { createGenericProfile } = await import("./types/site-profile.js");
      const { runAgentWithProfile } = await import("./index.js");

      const config = loadConfig();
      const flows = actions.map((action, i) => ({
        name: `Flow ${i + 1}`,
        action,
        expectation: `The action "${action}" should produce a visible response`,
      }));

      const profile = createGenericProfile(url, flows, {
        remediationAction: {
          type: "none" as const,
          reason: "Generic scan — report only",
        },
      });

      console.log(`[CLI] Scanning ${url} with ${flows.length} flow(s)\n`);
      const result = await runAgentWithProfile(profile, config);

      console.log("\n── Scan Result ──");
      console.log(`Phase:     ${result.phase}`);
      console.log(`Verified:  ${result.verified ?? "N/A"}`);
      if (result.postMortem) {
        console.log(`\nPost-mortem: ${result.postMortem}`);
      }
      break;
    }

    case "dream":
    case "demo": {
      const { runAgent } = await import("./index.js");
      const result = await runAgent();

      console.log("\n── Final Result ──");
      console.log(`Phase:          ${result.phase}`);
      console.log(`Memory Updated: ${result.memoryUpdated}`);
      console.log(`Verified:       ${result.verified ?? "N/A"}`);

      if (result.resolution) {
        console.log(`Resolution:     ${result.resolution}`);
      }
      if (result.postMortem) {
        console.log(`\nPost-mortem: ${result.postMortem}`);
      }
      if (result.dreamReport) {
        console.log(`\n── Dream Summary ──`);
        console.log(
          `Diagnosis: ${result.dreamReport.diagnosis.rootCause} (${result.dreamReport.diagnosis.category}, confidence: ${result.dreamReport.diagnosis.confidence.toFixed(2)})`
        );
        for (const dream of result.dreamReport.dreams) {
          const icon = dream.success ? "+" : "-";
          console.log(
            `  [${icon}] ${dream.strategy}: score=${dream.score.toFixed(2)}, ${dream.durationMs}ms`
          );
          console.log(`      ${dream.detail}`);
          if (dream.sessionUrl) console.log(`      Replay: ${dream.sessionUrl}`);
        }
      }
      break;
    }

    case "memory": {
      const { loadConfig } = await import("./config.js");
      const { IncidentMemoryStore } = await import("./memory/redis-store.js");

      const config = loadConfig();
      const store = new IncidentMemoryStore(config.redisUrl);
      await store.connect();

      const memories = await store.getRecentMemories(20);
      console.log(`\n── Stored Memories (${memories.length}) ──`);
      for (const m of memories) {
        console.log(
          `  [${m.timestamp}] ${m.type} — ${m.strategyUsed} (score: ${m.score.toFixed(2)})`
        );
        console.log(`    ${m.description}`);
        console.log(`    Resolution: ${m.resolution}\n`);
      }

      await store.disconnect();
      break;
    }

    case "memory:stats": {
      const { loadConfig } = await import("./config.js");
      const { IncidentMemoryStore } = await import("./memory/redis-store.js");

      const config = loadConfig();
      const store = new IncidentMemoryStore(config.redisUrl);
      await store.connect();

      const stats = await store.getMemoryStats();
      console.log("\n── Memory Statistics ──");
      console.log(`Total incidents: ${stats.total}`);
      console.log(`With embeddings: ${stats.withEmbeddings}`);
      console.log("By type:");
      for (const [type, count] of Object.entries(stats.byType)) {
        console.log(`  ${type}: ${count}`);
      }

      await store.disconnect();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(
        "Usage: tsx src/cli.ts [detect|dream|demo|scan|memory|memory:stats]"
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
