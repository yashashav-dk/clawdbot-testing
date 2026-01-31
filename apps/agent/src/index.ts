import { loadConfig } from "./config.js";
import {
  runPerception,
  buildIncidentFromPerception,
  type PerceptionResult,
} from "./perception/detector.js";
import { runDreamCycle, type DreamReport } from "./dreamer/engine.js";
import {
  executeRemediationAction,
  type ActionResult,
} from "./actions/dispatcher.js";
import { IncidentMemoryStore } from "./memory/redis-store.js";
import {
  generatePostMortem,
  generateEmbedding,
  type Diagnosis,
} from "./reasoning/llm.js";
import { initWeave, runWeaveEvaluation } from "./tracing/weave.js";
import type { Incident, IncidentMemory, AgentConfig } from "./types/index.js";
import type { SiteProfile } from "./types/site-profile.js";
import { SHOPDEMO_PROFILE } from "./types/site-profile.js";

/**
 * SRE Dreamer — Main Orchestrator
 *
 * The cognitive loop:
 *   1. PERCEIVE  — Visual health check via Stagehand (profile-driven)
 *   2. DIAGNOSE  — LLM root cause analysis
 *   3. DREAM     — Parallel simulation of remediation strategies
 *   4. ACT       — Execute the best strategy via pluggable action layer
 *   5. VERIFY    — Re-check the site to confirm the fix worked
 *   6. LEARN     — Store incident + embedding in Redis for self-improvement
 */

export interface RunResult {
  phase: "healthy" | "detected" | "dreaming" | "resolved" | "failed" | "verified";
  incident?: Incident;
  perception?: PerceptionResult;
  dreamReport?: DreamReport;
  actionResult?: ActionResult;
  resolution?: string;
  memoryUpdated: boolean;
  postMortem?: string;
  verified?: boolean;
}

/**
 * Run the agent against a specific site profile.
 * This is the generic entry point — works for any website.
 */
export async function runAgentWithProfile(
  profile: SiteProfile,
  config?: AgentConfig
): Promise<RunResult> {
  const agentConfig = config ?? loadConfig();

  // Initialize Weave tracing
  try {
    await initWeave(agentConfig);
  } catch (err) {
    console.warn("[SRE-DREAMER] Weave init failed — running without tracing");
  }

  const memory = new IncidentMemoryStore(agentConfig.redisUrl);

  let memoryConnected = false;
  try {
    await memory.connect();
    memoryConnected = true;
    console.log("[SRE-DREAMER] Connected to Redis memory store");
    const stats = await memory.getMemoryStats();
    if (stats.total > 0) {
      console.log(
        `[SRE-DREAMER] Memory: ${stats.total} incidents stored (${stats.withEmbeddings} with embeddings)`
      );
    }
  } catch (err) {
    console.warn("[SRE-DREAMER] Redis unavailable — running without memory");
  }

  // ── Phase 1: PERCEIVE ──────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PHASE 1: PERCEPTION (Wakeful State)    ║");
  console.log("╚══════════════════════════════════════════╝\n");

  console.log(`[PERCEIVE] Target: ${profile.name} (${profile.url})`);
  console.log(
    `[PERCEIVE] Testing ${profile.criticalFlows.length} critical flows: ${profile.criticalFlows.map((f) => f.name).join(", ")}`
  );

  const perception = await runPerception(profile, agentConfig);

  console.log(
    `[PERCEIVE] HTTP Status: ${perception.httpStatus ?? "N/A"} (traditional monitoring: ${perception.httpHealthy ? "ALL GOOD" : "PROBLEM"})`
  );

  for (const flow of perception.flowResults) {
    const icon = flow.passed ? "PASS" : "FAIL";
    console.log(
      `[PERCEIVE] Flow "${flow.flow.name}": ${icon}${flow.occlusionDetected ? " (OCCLUSION DETECTED)" : ""}${flow.blockingElement ? ` [blocker: ${flow.blockingElement}]` : ""} (${flow.durationMs}ms)`
    );
  }

  if (perception.sessionReplayUrl) {
    console.log(`[PERCEIVE] Session replay: ${perception.sessionReplayUrl}`);
  }

  if (perception.healthy) {
    console.log("[PERCEIVE] All flows passed. Site is healthy.");
    if (memoryConnected) await memory.disconnect();
    return { phase: "healthy", perception, memoryUpdated: false };
  }

  // Build incident
  const incident = buildIncidentFromPerception(perception, profile);
  if (!incident) {
    if (memoryConnected) await memory.disconnect();
    return { phase: "healthy", perception, memoryUpdated: false };
  }

  console.log(
    `\n[PERCEIVE] ANOMALY DETECTED: ${incident.type} (severity: ${incident.severity})`
  );
  console.log(`[PERCEIVE] ${incident.description}`);

  // Start incident thread in memory
  if (memoryConnected) {
    try {
      await memory.startThread(incident.id, incident);
    } catch (err) {
      console.warn("[MEMORY] Failed to start incident thread:", (err as Error)?.message);
    }
  }

  // ── Phase 2: DREAM (includes LLM diagnosis) ───────────────────────
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PHASE 2: DREAMING (Simulation State)   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // Retrieve past incidents — use vector search if possible
  let pastIncidents: IncidentMemory[] = [];
  if (memoryConnected) {
    try {
      let queryEmbedding: number[] | undefined;
      try {
        queryEmbedding = await generateEmbedding(
          `${incident.type}: ${incident.description}`,
          agentConfig
        );
      } catch (err) {
        console.warn("[DREAM] Embedding generation failed — falling back to type match:", (err as Error)?.message);
      }

      pastIncidents = await memory.findSimilarIncidents(
        incident.type,
        queryEmbedding
      );
      if (pastIncidents.length > 0) {
        console.log(
          `[DREAM] Found ${pastIncidents.length} similar past incidents in memory${queryEmbedding ? " (vector search)" : " (type match)"}`
        );
        for (const past of pastIncidents.slice(0, 3)) {
          console.log(
            `[DREAM]   - ${past.incidentId}: ${past.strategyUsed} (score: ${past.score.toFixed(2)})`
          );
        }
      } else {
        console.log("[DREAM] No past incidents found — this is a novel event");
      }
    } catch (err) {
      console.warn("[DREAM] Memory lookup failed:", (err as Error)?.message);
    }
  }

  const dreamReport = await runDreamCycle(
    incident,
    pastIncidents,
    profile,
    agentConfig
  );

  // Log dream results to thread
  if (memoryConnected) {
    try {
      for (const dream of dreamReport.dreams) {
        await memory.logThreadStep(incident.id, "dream_executed", {
          strategy: dream.strategy,
          score: dream.score,
          success: dream.success,
          sessionUrl: dream.sessionUrl,
        });
      }
    } catch (err) {
      console.warn("[MEMORY] Failed to log dream results:", (err as Error)?.message);
    }
  }

  // Run Weave evaluation on dream results
  try {
    await runWeaveEvaluation(
      dreamReport.dreams.map((d) => ({
        strategy: d.strategy,
        scores: {
          reachability: d.success ? 1.0 : 0.0,
          visualIntegrity: d.score,
          safety: d.sideEffects.length === 0 ? 1.0 : 0.5,
          latency: d.durationMs < 30000 ? 1.0 : 0.5,
          aggregate: d.score,
        },
      }))
    );
  } catch (err) {
    console.warn("[WEAVE] Evaluation failed:", (err as Error)?.message);
  }

  if (!dreamReport.bestStrategy) {
    console.log("\n[DREAM] No viable remediation strategy found.");
    if (memoryConnected) await memory.disconnect();
    return {
      phase: "failed",
      incident,
      perception,
      dreamReport,
      memoryUpdated: false,
    };
  }

  // ── Phase 3: ACT ───────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PHASE 3: ACTION (Lucid State)          ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const bestStrategy = dreamReport.bestStrategy;
  console.log(
    `[ACT] Best strategy: "${bestStrategy.strategy}" (score: ${bestStrategy.score.toFixed(2)})`
  );
  console.log(`[ACT] Dream detail: ${bestStrategy.detail}`);

  // Enrich the incident with dream findings before passing to the action layer
  const enrichedIncident: Incident = {
    ...incident,
    description: `${incident.description}\n\nDream analysis: ${bestStrategy.detail}\nDiagnosis: ${dreamReport.diagnosis.rootCause} (${dreamReport.diagnosis.category}, confidence: ${dreamReport.diagnosis.confidence.toFixed(2)})`,
  };

  const actionResult = await executeRemediationAction(
    profile,
    enrichedIncident,
    bestStrategy.strategy,
    agentConfig
  );

  console.log(`[ACT] ${actionResult.message} (${actionResult.durationMs}ms)`);

  // ── Phase 4: VERIFY ────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PHASE 4: VERIFICATION                  ║");
  console.log("╚══════════════════════════════════════════╝\n");

  let verified = false;
  if (actionResult.success && profile.remediationAction.type !== "none") {
    console.log("[VERIFY] Waiting for changes to propagate...");
    await sleep(5000);

    console.log("[VERIFY] Re-running perception check...");
    const verifyResult = await runPerception(profile, agentConfig);
    verified = verifyResult.healthy;

    console.log(
      `[VERIFY] Post-fix status: ${verified ? "HEALTHY" : "STILL UNHEALTHY"}`
    );
    for (const flow of verifyResult.flowResults) {
      const icon = flow.passed ? "PASS" : "FAIL";
      console.log(`[VERIFY]   ${flow.flow.name}: ${icon}`);
    }
  } else {
    console.log("[VERIFY] Skipped — action was report-only or failed");
  }

  // ── Phase 5: LEARN ─────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   PHASE 5: LEARNING (Memory Update)      ║");
  console.log("╚══════════════════════════════════════════╝\n");

  let memoryUpdated = false;
  let postMortem: string | undefined;

  if (memoryConnected) {
    try {
      // Generate LLM post-mortem summary
      postMortem = await generatePostMortem(
        incident,
        dreamReport.diagnosis,
        bestStrategy.strategy,
        verified || actionResult.success,
        agentConfig
      );
      console.log(`[LEARN] Post-mortem: ${postMortem}`);

      // Generate embedding for semantic search
      let embedding: number[] | undefined;
      try {
        embedding = await generateEmbedding(
          `${incident.type}: ${incident.description}. Resolution: ${postMortem}`,
          agentConfig
        );
        console.log(
          `[LEARN] Generated embedding (${embedding.length} dimensions)`
        );
      } catch (err) {
        console.warn("[LEARN] Embedding generation failed:", (err as Error)?.message);
      }

      const incidentMemory: IncidentMemory = {
        incidentId: incident.id,
        timestamp: incident.timestamp,
        type: incident.type,
        description: postMortem,
        resolution: actionResult.message,
        strategyUsed: bestStrategy.strategy,
        score: bestStrategy.score,
      };

      await memory.storeMemory(incidentMemory, embedding);
      memoryUpdated = true;

      const stats = await memory.getMemoryStats();
      console.log(
        `[LEARN] Memory updated: ${stats.total} total incidents, ${stats.withEmbeddings} with embeddings`
      );
      console.log(
        `[LEARN] Future "${incident.type}" incidents will benefit from this experience`
      );
    } catch (err) {
      console.warn("[LEARN] Failed to update memory:", err);
    }

    try {
      await memory.disconnect();
    } catch (err) {
      console.warn("[MEMORY] Disconnect failed:", (err as Error)?.message);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  const finalPhase = verified ? "verified" : actionResult.success ? "resolved" : "failed";

  console.log("\n╔══════════════════════════════════════════╗");
  console.log(
    `║   SRE DREAMER: ${finalPhase.toUpperCase().padEnd(25)}║`
  );
  console.log("╚══════════════════════════════════════════╝\n");

  return {
    phase: finalPhase,
    incident,
    perception,
    dreamReport,
    actionResult,
    resolution: actionResult.message,
    memoryUpdated,
    postMortem,
    verified,
  };
}

/**
 * Run the agent using the ShopDemo profile (legacy entry point).
 */
export async function runAgent(): Promise<RunResult> {
  const config = loadConfig();
  const profile = { ...SHOPDEMO_PROFILE, url: config.targetUrl };
  return runAgentWithProfile(profile, config);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
