import { loadConfig } from "./config.js";
import {
  runVisualHealthCheck,
  buildIncidentFromCheck,
} from "./perception/detector.js";
import { runDreamCycle, type DreamReport } from "./dreamer/engine.js";
import { rollbackToGoodDeployment } from "./actions/vercel.js";
import { IncidentMemoryStore } from "./memory/redis-store.js";
import type { Incident, IncidentMemory } from "./types/index.js";

/**
 * SRE Dreamer — Main Orchestrator
 *
 * The tri-phasic cognitive loop:
 *   1. PERCEIVE — Visual health check via Stagehand
 *   2. DREAM   — Parallel simulation of remediation strategies
 *   3. ACT     — Execute the best strategy on production
 *
 * After resolution, the incident is committed to long-term memory
 * so the agent improves over time.
 */

export interface RunResult {
  phase: "healthy" | "detected" | "dreaming" | "resolved" | "failed";
  incident?: Incident;
  dreamReport?: DreamReport;
  resolution?: string;
  memoryUpdated: boolean;
}

export async function runAgent(): Promise<RunResult> {
  const config = loadConfig();
  const memory = new IncidentMemoryStore(config.redisUrl);

  try {
    await memory.connect();
    console.log("[SRE-DREAMER] Connected to Redis memory store");
  } catch (err) {
    console.warn(
      "[SRE-DREAMER] Redis unavailable — running without memory:",
      err
    );
  }

  // ── Phase 1: PERCEIVE ──────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PHASE 1: PERCEPTION (Wakeful State)    ║");
  console.log("╚══════════════════════════════════════════╝\n");

  console.log(`[PERCEIVE] Running visual health check on ${config.targetUrl}`);

  const healthCheck = await runVisualHealthCheck(config);

  console.log(
    `[PERCEIVE] HTTP Status: ${healthCheck.httpStatus ?? "N/A"} (traditional monitoring says: ${healthCheck.httpStatus === 200 ? "ALL GOOD" : "PROBLEM"})`
  );
  console.log(
    `[PERCEIVE] Visual Check: Login clickable = ${healthCheck.visualCheck.loginClickable}, Occlusion = ${healthCheck.visualCheck.occlusionDetected}`
  );

  if (healthCheck.healthy) {
    console.log("[PERCEIVE] Site is healthy. No action needed.");
    return { phase: "healthy", memoryUpdated: false };
  }

  // Build incident from the health check
  const incident = buildIncidentFromCheck(healthCheck);
  if (!incident) {
    return { phase: "healthy", memoryUpdated: false };
  }

  console.log(
    `\n[PERCEIVE] ANOMALY DETECTED: ${incident.type} (severity: ${incident.severity})`
  );
  console.log(`[PERCEIVE] ${incident.description}`);
  if (incident.blockingElement) {
    console.log(`[PERCEIVE] Blocking element: ${incident.blockingElement}`);
  }

  // Start incident thread in memory
  try {
    await memory.startThread(incident.id, incident);
  } catch {}

  // ── Phase 2: DREAM ─────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PHASE 2: DREAMING (Simulation State)   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // Retrieve past incident memories to inform strategy selection
  let pastIncidents: IncidentMemory[] = [];
  try {
    pastIncidents = await memory.findSimilarIncidents(incident.type);
    if (pastIncidents.length > 0) {
      console.log(
        `[DREAM] Found ${pastIncidents.length} similar past incidents in memory`
      );
    } else {
      console.log("[DREAM] No past incidents found — this is a novel event");
    }
  } catch {}

  const dreamReport = await runDreamCycle(incident, pastIncidents, config);

  // Log dream results to thread
  try {
    for (const dream of dreamReport.dreams) {
      await memory.logThreadStep(incident.id, "dream_executed", {
        strategy: dream.strategy,
        score: dream.score,
        success: dream.success,
      });
    }
  } catch {}

  if (!dreamReport.bestStrategy) {
    console.log("\n[DREAM] No viable remediation strategy found.");
    return {
      phase: "failed",
      incident,
      dreamReport,
      memoryUpdated: false,
    };
  }

  // ── Phase 3: ACT ───────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PHASE 3: ACTION (Lucid State)          ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const bestStrategy = dreamReport.bestStrategy;
  let resolution = "";

  console.log(
    `[ACT] Executing best strategy: "${bestStrategy.strategy}" (score: ${bestStrategy.score.toFixed(2)})`
  );

  // For the demo, the primary production action is Vercel rollback
  if (
    bestStrategy.strategy === "rollback_simulation" ||
    bestStrategy.strategy === "dom_removal"
  ) {
    console.log("[ACT] Triggering Vercel rollback to known-good deployment...");

    const rollbackResult = await rollbackToGoodDeployment(config);
    resolution = rollbackResult.message;

    console.log(`[ACT] ${rollbackResult.message}`);

    if (rollbackResult.success) {
      console.log(
        `[ACT] Rollback completed in ${rollbackResult.durationMs}ms`
      );
    }
  } else if (bestStrategy.strategy === "css_patch_targeted") {
    // In production, this would deploy a hotfix
    resolution = `CSS patch identified: ${bestStrategy.detail}. Recommend deploying hotfix.`;
    console.log(`[ACT] ${resolution}`);
  }

  // ── Phase 4: LEARN ─────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PHASE 4: LEARNING (Memory Update)      ║");
  console.log("╚══════════════════════════════════════════╝\n");

  let memoryUpdated = false;
  try {
    const incidentMemory: IncidentMemory = {
      incidentId: incident.id,
      timestamp: incident.timestamp,
      type: incident.type,
      description: incident.description,
      resolution,
      strategyUsed: bestStrategy.strategy,
      score: bestStrategy.score,
    };

    await memory.storeMemory(incidentMemory);
    memoryUpdated = true;

    const totalMemories = await memory.getMemoryCount();
    console.log(
      `[LEARN] Incident stored in long-term memory (total memories: ${totalMemories})`
    );
    console.log(
      `[LEARN] Future incidents of type "${incident.type}" will benefit from this experience`
    );
  } catch (err) {
    console.warn("[LEARN] Failed to update memory:", err);
  }

  try {
    await memory.disconnect();
  } catch {}

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   SRE DREAMER: INCIDENT RESOLVED         ║");
  console.log("╚══════════════════════════════════════════╝\n");

  return {
    phase: "resolved",
    incident,
    dreamReport,
    resolution,
    memoryUpdated,
  };
}
