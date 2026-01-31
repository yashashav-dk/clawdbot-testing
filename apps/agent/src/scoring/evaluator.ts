import { Stagehand } from "@browserbasehq/stagehand";
import type { DreamResult, AgentConfig } from "../types/index.js";

/**
 * The Scoring Layer.
 *
 * Evaluates dream results across multiple dimensions:
 * - Reachability: Can the user click the login button?
 * - Visual integrity: Does the page still look correct?
 * - Latency: How fast was the fix?
 * - Safety: Did the fix cause any side effects?
 */

export interface ScoreBreakdown {
  reachability: number; // 0-1: Did the login button become clickable?
  visualIntegrity: number; // 0-1: Are key page elements still present?
  latency: number; // 0-1: Normalized speed score
  safety: number; // 0-1: No destructive side effects?
  aggregate: number; // Weighted average
}

const WEIGHTS = {
  reachability: 0.4,
  visualIntegrity: 0.25,
  latency: 0.15,
  safety: 0.2,
};

export function computeScore(breakdown: ScoreBreakdown): number {
  return (
    breakdown.reachability * WEIGHTS.reachability +
    breakdown.visualIntegrity * WEIGHTS.visualIntegrity +
    breakdown.latency * WEIGHTS.latency +
    breakdown.safety * WEIGHTS.safety
  );
}

/**
 * Runs a full evaluation of a page state after a remediation attempt.
 * This is called within each dream simulation to score the result.
 */
export async function evaluatePageHealth(
  page: any
): Promise<ScoreBreakdown> {
  const reachability = await checkReachability(page);
  const visualIntegrity = await checkVisualIntegrity(page);
  const safety = await checkSafety(page);

  // Latency is scored externally based on duration
  const breakdown: ScoreBreakdown = {
    reachability,
    visualIntegrity,
    latency: 1.0, // Placeholder — set by caller based on timing
    safety,
    aggregate: 0,
  };

  breakdown.aggregate = computeScore(breakdown);
  return breakdown;
}

async function checkReachability(page: any): Promise<number> {
  try {
    // Try clicking the login button via direct Playwright action
    await page.click('[data-testid="login-btn"]', { timeout: 5000 });

    // Check if the success message appeared
    const success = await page
      .locator('[data-testid="login-success"]')
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    return success ? 1.0 : 0.3;
  } catch {
    return 0.0;
  }
}

async function checkVisualIntegrity(page: any): Promise<number> {
  try {
    const checks = await page.evaluate(() => {
      const results: Record<string, boolean> = {};

      // Check key elements exist
      results.header = !!document.querySelector("header");
      results.footer = !!document.querySelector("footer");
      results.mainContent = !!document.querySelector("main");
      results.loginBtn = !!document.querySelector('[data-testid="login-btn"]');
      results.healthOk = !!document.querySelector('[data-testid="health-ok"]');

      // Check no blank page
      results.hasContent = document.body.innerText.length > 50;

      return results;
    });

    const passed = Object.values(checks).filter(Boolean).length;
    const total = Object.values(checks).length;
    return passed / total;
  } catch {
    return 0.0;
  }
}

async function checkSafety(page: any): Promise<number> {
  try {
    const issues = await page.evaluate(() => {
      const problems: string[] = [];

      // Check for JS errors visible in the DOM
      if (document.body.innerText.includes("Unhandled Runtime Error")) {
        problems.push("runtime_error");
      }

      // Check for blank/destroyed page
      if (document.body.children.length < 2) {
        problems.push("page_destroyed");
      }

      // Check console for critical errors (limited to what's in DOM)
      if (document.querySelectorAll("[role='alert']").length > 0) {
        problems.push("error_alerts");
      }

      return problems;
    });

    if (issues.length === 0) return 1.0;
    if (issues.includes("page_destroyed")) return 0.0;
    return Math.max(0, 1.0 - issues.length * 0.3);
  } catch {
    return 0.5; // Can't evaluate = uncertain
  }
}

/**
 * Normalizes latency to a 0-1 score.
 * Under 5s = 1.0, over 120s = 0.0, linear between.
 */
export function scoreLatency(durationMs: number): number {
  const seconds = durationMs / 1000;
  if (seconds <= 5) return 1.0;
  if (seconds >= 120) return 0.0;
  return 1.0 - (seconds - 5) / (120 - 5);
}
