import * as weave from "weave";
import { Stagehand } from "@browserbasehq/stagehand";
import type {
  Incident,
  DreamContext,
  DreamResult,
  IncidentMemory,
  AgentConfig,
} from "../types/index.js";
import type { SiteProfile } from "../types/site-profile.js";
import { applyCssPatch, removeBlockingElement } from "../actions/css-patch.js";
import {
  evaluatePageHealth,
  scoreLatency,
  computeScore,
  type ScoreBreakdown,
} from "../scoring/evaluator.js";
import {
  diagnoseRootCause,
  type Diagnosis,
} from "../reasoning/llm.js";

/**
 * The Dreaming Engine.
 *
 * Spawns parallel Browserbase sessions to simulate different remediation
 * strategies. Each "dream" is an isolated sandbox where the agent can
 * test a fix without affecting production.
 *
 * Now uses LLM reasoning for root cause diagnosis and strategy selection,
 * and works generically for any site profile.
 */

export interface DreamReport {
  incidentId: string;
  diagnosis: Diagnosis;
  dreams: DreamResult[];
  bestStrategy: DreamResult | null;
  totalDurationMs: number;
}

export const runDreamCycle = weave.op(
  async function runDreamCycle(
  incident: Incident,
  pastIncidents: IncidentMemory[],
  profile: SiteProfile,
  config: AgentConfig
): Promise<DreamReport> {
  const start = Date.now();

  const context: DreamContext = {
    incident,
    targetUrl: profile.url,
    pastIncidents,
  };

  // ── Step 1: LLM Root Cause Diagnosis ─────────────────────────────
  console.log(`[DREAMER] Diagnosing root cause for ${incident.id}...`);

  const diagnosis = await diagnoseRootCause(
    incident,
    incident.domSnapshot ?? "(no snapshot)",
    profile,
    config
  );

  console.log(
    `[DREAMER] Diagnosis: "${diagnosis.rootCause}" (confidence: ${diagnosis.confidence.toFixed(2)}, category: ${diagnosis.category})`
  );
  console.log(`[DREAMER] LLM reasoning: ${diagnosis.reasoning}`);

  // ── Step 2: Strategy Selection ───────────────────────────────────
  const strategies = selectStrategies(context, diagnosis, pastIncidents);

  console.log(
    `[DREAMER] Starting dream cycle with ${strategies.length} strategies: ${strategies.map((s) => s.name).join(", ")}`
  );

  // ── Step 3: Parallel Dream Execution ─────────────────────────────
  const dreams = await Promise.allSettled(
    strategies.map((strategy) =>
      executeDream(strategy, context, profile, config)
    )
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

  results.sort((a, b) => b.score - a.score);

  const bestStrategy = results.find((r) => r.success && r.score > 0.5) ?? null;

  const report: DreamReport = {
    incidentId: incident.id,
    diagnosis,
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
});

interface StrategyDef {
  name: string;
  description: string;
  priority: number;
}

function selectStrategies(
  context: DreamContext,
  diagnosis: Diagnosis,
  pastIncidents: IncidentMemory[]
): StrategyDef[] {
  const strategies: StrategyDef[] = [];

  // Always include rollback as the safest fallback
  strategies.push({
    name: "rollback_simulation",
    description: "Simulate rollback to last known-good state",
    priority: 5,
  });

  // Add strategies based on LLM diagnosis
  for (const suggested of diagnosis.suggestedStrategies) {
    if (suggested === "rollback_simulation") continue; // Already added

    const existing = strategies.find((s) => s.name === suggested);
    if (!existing) {
      strategies.push({
        name: suggested,
        description: `LLM-suggested strategy: ${suggested}`,
        priority: 2, // LLM suggestions get high priority
      });
    }
  }

  // Add strategies based on incident type (deterministic fallbacks)
  if (
    context.incident.type === "visual_occlusion" &&
    !strategies.find((s) => s.name === "css_patch_targeted")
  ) {
    strategies.push({
      name: "css_patch_targeted",
      description: "Neutralize blocking element via CSS",
      priority: 3,
    });
  }

  if (
    context.incident.type === "visual_occlusion" &&
    !strategies.find((s) => s.name === "dom_removal")
  ) {
    strategies.push({
      name: "dom_removal",
      description: "Remove blocking element from DOM",
      priority: 4,
    });
  }

  // Boost strategies that worked in past incidents
  const pastWins = pastIncidents.filter((m) => m.score > 0.8);
  if (pastWins.length > 0) {
    const preferredStrategy = pastWins[0].strategyUsed;
    const existing = strategies.find((s) => s.name === preferredStrategy);
    if (existing) {
      existing.priority = 0;
      console.log(
        `[DREAMER] Boosting "${preferredStrategy}" based on ${pastWins.length} past successes (self-improving)`
      );
    }
  }

  return strategies.sort((a, b) => a.priority - b.priority);
}

const executeDream = weave.op(
  async function executeDream(
  strategy: StrategyDef,
  context: DreamContext,
  profile: SiteProfile,
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

    await page.goto(context.targetUrl, { waitUntil: "networkidle" });

    // Apply the strategy
    let strategyDetail = "";

    switch (strategy.name) {
      case "rollback_simulation": {
        // Simulate rollback by navigating to a previous Vercel deployment URL
        // This is a true counterfactual: "what if we rolled back to the last good deploy?"
        try {
          const { listRecentDeployments } = await import("../actions/vercel.js");
          const deployments = await listRecentDeployments(config, 5);
          const currentDeployId = config.vercelGoodDeploymentId;

          // Find the most recent READY deployment that isn't the current one
          const rollbackTarget = deployments.find(
            (d) => d.state === "READY" && d.id !== currentDeployId
          );

          if (rollbackTarget) {
            // Navigate to the previous deployment's preview URL
            const rollbackUrl = rollbackTarget.url.startsWith("http")
              ? rollbackTarget.url
              : `https://${rollbackTarget.url}`;
            await page.goto(rollbackUrl, { waitUntil: "networkidle" });
            strategyDetail = `Simulated rollback: navigated to previous deployment ${rollbackTarget.id} (${rollbackUrl})`;
          } else {
            // No alternative deployment found — fall back to page reload
            await page.reload({ waitUntil: "networkidle" });
            strategyDetail = "No previous deployment available — simulated rollback via reload";
          }
        } catch (e: any) {
          // Vercel API unavailable — fall back to removing the element as approximation
          const result = await removeBlockingElement(
            page,
            context.incident.blockingElement
          );
          strategyDetail = `Vercel API unavailable (${e?.message}) — approximated rollback by removing blocker: ${result.detail}`;
        }
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

      case "style_override": {
        // Generic style override — make all fixed/absolute positioned elements non-blocking
        try {
          await page.addStyleTag({
            content: `
              * {
                pointer-events: auto !important;
              }
              [style*="position: fixed"], [style*="position:fixed"],
              [style*="position: absolute"], [style*="position:absolute"] {
                pointer-events: none !important;
              }
            `,
          });
          strategyDetail = "Applied global style override for positioned elements";
        } catch (e: any) {
          strategyDetail = `Style override failed: ${e?.message}`;
        }
        break;
      }

      case "js_injection": {
        // Use JavaScript to find and neutralize overlays
        try {
          const removed = await page.evaluate(() => {
            let count = 0;
            document.querySelectorAll("*").forEach((el) => {
              const style = window.getComputedStyle(el);
              if (
                (style.position === "fixed" || style.position === "absolute") &&
                el.clientWidth > window.innerWidth * 0.5 &&
                el.clientHeight > window.innerHeight * 0.5 &&
                style.backgroundColor === "rgba(0, 0, 0, 0)" &&
                parseInt(style.zIndex) > 100
              ) {
                (el as HTMLElement).style.pointerEvents = "none";
                count++;
              }
            });
            return count;
          });
          strategyDetail = `JS injection: neutralized ${removed} overlay element(s)`;
        } catch (e: any) {
          strategyDetail = `JS injection failed: ${e?.message}`;
        }
        break;
      }

      case "cache_clear": {
        // Simulate cache clearing by hard-refreshing
        try {
          await page.evaluate(() => {
            if ("caches" in window) {
              caches.keys().then((names) =>
                names.forEach((name) => caches.delete(name))
              );
            }
          });
          await page.reload({ waitUntil: "networkidle" });
          strategyDetail = "Cache cleared and page reloaded";
        } catch (e: any) {
          strategyDetail = `Cache clear failed: ${e?.message}`;
        }
        break;
      }

      default:
        strategyDetail = `Strategy "${strategy.name}" has no implementation — skipped`;
    }

    // Evaluate the result using the profile-aware scorer
    const scoreBreakdown = await evaluatePageHealth(page, profile, config);
    scoreBreakdown.latency = scoreLatency(Date.now() - start);
    scoreBreakdown.aggregate = computeScore(scoreBreakdown);

    const durationMs = Date.now() - start;

    // Get session replay URL
    let sessionUrl: string | undefined;
    try {
      const sessionId = (stagehand as any).browserbaseSessionID;
      if (sessionId) {
        sessionUrl = `https://www.browserbase.com/sessions/${sessionId}`;
      }
    } catch {}

    console.log(
      `[DREAM:${strategy.name}] Complete. Score: ${scoreBreakdown.aggregate.toFixed(2)} (reach=${scoreBreakdown.reachability.toFixed(2)}, visual=${scoreBreakdown.visualIntegrity.toFixed(2)}, safety=${scoreBreakdown.safety.toFixed(2)})`
    );

    return {
      strategy: strategy.name,
      success: scoreBreakdown.reachability > 0.5,
      score: scoreBreakdown.aggregate,
      sessionUrl,
      detail: strategyDetail,
      durationMs,
      sideEffects:
        scoreBreakdown.safety < 1.0 ? ["potential_side_effects"] : [],
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
});
