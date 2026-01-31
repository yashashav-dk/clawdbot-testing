import { Stagehand } from "@browserbasehq/stagehand";
import type {
  Incident,
  DreamContext,
  DreamResult,
  IncidentMemory,
  AgentConfig,
} from "../types/index.js";
import { applyCssPatch, removeBlockingElement } from "../actions/css-patch.js";
import {
  evaluatePageHealth,
  scoreLatency,
  type ScoreBreakdown,
} from "../scoring/evaluator.js";

/**
 * The Dreaming Engine.
 *
 * Spawns parallel Browserbase sessions to simulate different remediation
 * strategies. Each "dream" is an isolated sandbox where the agent can
 * test a fix without affecting production.
 */

export interface DreamReport {
  incidentId: string;
  dreams: DreamResult[];
  bestStrategy: DreamResult | null;
  totalDurationMs: number;
}

export async function runDreamCycle(
  incident: Incident,
  pastIncidents: IncidentMemory[],
  config: AgentConfig
): Promise<DreamReport> {
  const start = Date.now();

  const context: DreamContext = {
    incident,
    targetUrl: config.targetUrl,
    pastIncidents,
  };

  // Determine which strategies to test based on incident type and past experience
  const strategies = selectStrategies(context);

  console.log(
    `[DREAMER] Starting dream cycle for ${incident.id} with ${strategies.length} strategies`
  );

  // Run all dreams in parallel
  const dreams = await Promise.allSettled(
    strategies.map((strategy) => executeDream(strategy, context, config))
  );

  const results: DreamResult[] = dreams.map((d, i) => {
    if (d.status === "fulfilled") return d.value;
    return {
      strategy: strategies[i].name,
      success: false,
      score: 0,
      detail: `Dream failed: ${d.reason?.message ?? String(d.reason)}`,
      durationMs: 0,
      sideEffects: ["dream_crashed"],
    };
  });

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  const bestStrategy = results.find((r) => r.success && r.score > 0.5) ?? null;

  const report: DreamReport = {
    incidentId: incident.id,
    dreams: results,
    bestStrategy,
    totalDurationMs: Date.now() - start,
  };

  console.log(`[DREAMER] Dream cycle complete in ${report.totalDurationMs}ms`);
  if (bestStrategy) {
    console.log(
      `[DREAMER] Best strategy: "${bestStrategy.strategy}" (score: ${bestStrategy.score.toFixed(2)})`
    );
  } else {
    console.log("[DREAMER] No viable strategy found.");
  }

  return report;
}

interface StrategyDef {
  name: string;
  description: string;
  priority: number;
}

function selectStrategies(context: DreamContext): StrategyDef[] {
  const strategies: StrategyDef[] = [];

  // Always try rollback — safest option
  strategies.push({
    name: "rollback_simulation",
    description: "Simulate the effect of rolling back to last good deployment",
    priority: 1,
  });

  if (context.incident.type === "visual_occlusion") {
    // CSS patches are relevant for occlusion bugs
    strategies.push({
      name: "css_patch_targeted",
      description: "Apply targeted CSS to neutralize the blocking element",
      priority: 2,
    });

    strategies.push({
      name: "dom_removal",
      description: "Remove the blocking element from the DOM entirely",
      priority: 3,
    });
  }

  // Check if past incidents suggest a preferred strategy
  const pastWins = context.pastIncidents.filter((m) => m.score > 0.8);
  if (pastWins.length > 0) {
    const preferredStrategy = pastWins[0].strategyUsed;
    const existing = strategies.find((s) => s.name === preferredStrategy);
    if (existing) {
      existing.priority = 0; // Boost to highest priority
      console.log(
        `[DREAMER] Boosting "${preferredStrategy}" based on past success`
      );
    }
  }

  return strategies.sort((a, b) => a.priority - b.priority);
}

async function executeDream(
  strategy: StrategyDef,
  context: DreamContext,
  config: AgentConfig
): Promise<DreamResult> {
  const start = Date.now();

  console.log(`[DREAM:${strategy.name}] Starting simulation...`);

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: config.browserbaseApiKey,
    projectId: config.browserbaseProjectId,
    modelName: "gpt-4o",
    modelClientOptions: {
      apiKey: config.openaiApiKey,
    },
  });

  try {
    await stagehand.init();
    const page = stagehand.page;

    // Navigate to the target in the sandbox
    await page.goto(context.targetUrl, { waitUntil: "networkidle" });

    // Apply the strategy
    let strategyDetail = "";

    switch (strategy.name) {
      case "rollback_simulation": {
        // In the dream, we simulate rollback by removing the overlay
        // (since we can't actually trigger a Vercel rollback in the sandbox)
        // This tests: "If the overlay were gone, would the site work?"
        const result = await removeBlockingElement(
          page,
          context.incident.blockingElement
        );
        strategyDetail = result.detail;
        break;
      }

      case "css_patch_targeted": {
        const result = await applyCssPatch(
          page,
          context.incident.blockingElement
        );
        strategyDetail = result.detail;
        break;
      }

      case "dom_removal": {
        const result = await removeBlockingElement(
          page,
          context.incident.blockingElement
        );
        strategyDetail = result.detail;
        break;
      }

      default:
        strategyDetail = `Unknown strategy: ${strategy.name}`;
    }

    // Evaluate the result
    const scoreBreakdown = await evaluatePageHealth(page);
    scoreBreakdown.latency = scoreLatency(Date.now() - start);
    const finalScore =
      scoreBreakdown.reachability * 0.4 +
      scoreBreakdown.visualIntegrity * 0.25 +
      scoreBreakdown.latency * 0.15 +
      scoreBreakdown.safety * 0.2;

    const durationMs = Date.now() - start;

    console.log(
      `[DREAM:${strategy.name}] Complete. Score: ${finalScore.toFixed(2)} (reachability=${scoreBreakdown.reachability}, visual=${scoreBreakdown.visualIntegrity}, safety=${scoreBreakdown.safety})`
    );

    return {
      strategy: strategy.name,
      success: scoreBreakdown.reachability > 0.5,
      score: finalScore,
      sessionUrl: undefined, // Would be session.replay_url in production
      detail: strategyDetail,
      durationMs,
      sideEffects: scoreBreakdown.safety < 1.0 ? ["potential_side_effects"] : [],
    };
  } catch (error: any) {
    console.error(
      `[DREAM:${strategy.name}] Error: ${error?.message ?? String(error)}`
    );
    return {
      strategy: strategy.name,
      success: false,
      score: 0,
      detail: `Dream error: ${error?.message ?? String(error)}`,
      durationMs: Date.now() - start,
      sideEffects: ["dream_error"],
    };
  } finally {
    await stagehand.close().catch(() => {});
  }
}
