import "dotenv/config";

/**
 * CLI entry point for the SRE Dreamer agent.
 *
 * Usage:
 *   tsx src/cli.ts detect    — Run perception only (visual health check)
 *   tsx src/cli.ts dream     — Run full dream cycle on current state
 *   tsx src/cli.ts demo      — Run the complete demo sequence
 *   tsx src/cli.ts memory    — Show stored incident memories
 */

const command = process.argv[2] ?? "demo";

async function main() {
  console.log("┌─────────────────────────────────────────┐");
  console.log("│         SRE DREAMER v0.1.0              │");
  console.log("│   Autonomous Visual Regression Agent     │");
  console.log("└─────────────────────────────────────────┘");
  console.log();

  switch (command) {
    case "detect": {
      const { loadConfig } = await import("./config.js");
      const { runVisualHealthCheck, buildIncidentFromCheck } = await import(
        "./perception/detector.js"
      );

      const config = loadConfig();
      console.log(`[CLI] Running visual health check on ${config.targetUrl}\n`);

      const result = await runVisualHealthCheck(config);

      console.log("\n── Health Check Result ──");
      console.log(`HTTP Status:     ${result.httpStatus ?? "N/A"}`);
      console.log(`Page Loaded:     ${result.visualCheck.pageLoaded}`);
      console.log(`Login Clickable: ${result.visualCheck.loginClickable}`);
      console.log(`Occlusion:       ${result.visualCheck.occlusionDetected}`);
      console.log(`Blocking Element: ${result.visualCheck.blockingElementSelector ?? "none"}`);
      console.log(`Overall:         ${result.healthy ? "HEALTHY" : "UNHEALTHY"}`);

      if (!result.healthy) {
        const incident = buildIncidentFromCheck(result);
        if (incident) {
          console.log(`\n── Incident Created ──`);
          console.log(`ID:       ${incident.id}`);
          console.log(`Type:     ${incident.type}`);
          console.log(`Severity: ${incident.severity}`);
        }
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
      if (result.resolution) {
        console.log(`Resolution:     ${result.resolution}`);
      }
      if (result.dreamReport) {
        console.log(`\n── Dream Summary ──`);
        for (const dream of result.dreamReport.dreams) {
          const icon = dream.success ? "+" : "-";
          console.log(
            `  [${icon}] ${dream.strategy}: score=${dream.score.toFixed(2)}, ${dream.durationMs}ms — ${dream.detail}`
          );
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

    default:
      console.error(`Unknown command: ${command}`);
      console.log("Usage: tsx src/cli.ts [detect|dream|demo|memory]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
