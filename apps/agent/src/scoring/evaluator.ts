import * as weave from "weave";
import { Stagehand } from "@browserbasehq/stagehand";
import type { DreamResult, AgentConfig } from "../types/index.js";
import type { SiteProfile, CriticalFlow } from "../types/site-profile.js";
import { assessPageVisually, type VisualAssessment } from "../reasoning/llm.js";
import { captureDomSnapshot } from "../perception/detector.js";

/**
 * The Scoring Layer.
 *
 * Evaluates dream results across multiple dimensions. Works generically
 * for any site profile — uses both DOM checks (fast, reliable) and
 * LLM-based visual assessment (flexible, works on any page).
 */

export interface ScoreBreakdown {
  reachability: number;
  visualIntegrity: number;
  latency: number;
  safety: number;
  aggregate: number;
  details: Record<string, any>;
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
 * Uses the site profile to know what to check.
 */
export const evaluatePageHealth = weave.op(
  async function evaluatePageHealth(
  page: any,
  profile?: SiteProfile,
  config?: AgentConfig
): Promise<ScoreBreakdown> {
  const details: Record<string, any> = {};

  // Reachability: test critical flows
  const reachability = profile
    ? await checkFlowReachability(page, profile, details)
    : await checkBasicReachability(page, details);

  // Visual integrity: check expected elements + LLM assessment
  const visualIntegrity = profile
    ? await checkProfileVisualIntegrity(page, profile, config, details)
    : await checkBasicVisualIntegrity(page, details);

  // Safety: check for destructive side effects
  const safety = await checkSafety(page, details);

  const breakdown: ScoreBreakdown = {
    reachability,
    visualIntegrity,
    latency: 1.0,
    safety,
    aggregate: 0,
    details,
  };

  breakdown.aggregate = computeScore(breakdown);
  return breakdown;
});

// ── Reachability Checks ──────────────────────────────────────────────

async function checkFlowReachability(
  page: any,
  profile: SiteProfile,
  details: Record<string, any>
): Promise<number> {
  const flowResults: Record<string, boolean> = {};
  let totalWeight = 0;
  let passedWeight = 0;

  for (const flow of profile.criticalFlows) {
    const passed = await testFlowInPage(page, flow);
    flowResults[flow.name] = passed;
    totalWeight += flow.priority;
    if (passed) passedWeight += flow.priority;
  }

  details.flowResults = flowResults;
  return totalWeight > 0 ? passedWeight / totalWeight : 0;
}

async function testFlowInPage(page: any, flow: CriticalFlow): Promise<boolean> {
  if (flow.verification.type !== "selector") {
    // For non-selector verifications, do a basic click test
    return checkBasicClickability(page);
  }

  try {
    // For selector-based flows, check if the target element is clickable
    const selector = flow.verification.selector;
    await page.click(selector, { timeout: 5000 });

    // Check if selector verification element appeared
    if (flow.verification.expectVisible) {
      return await page
        .locator(selector)
        .isVisible({ timeout: 2000 })
        .catch(() => false);
    }
    return true;
  } catch {
    return false;
  }
}

async function checkBasicReachability(
  page: any,
  details: Record<string, any>
): Promise<number> {
  const clickable = await checkBasicClickability(page);
  details.basicClickable = clickable;
  return clickable ? 1.0 : 0.0;
}

async function checkBasicClickability(page: any): Promise<boolean> {
  try {
    // Try clicking the first button or link found on the page
    const clickable = await page.evaluate(() => {
      const btn =
        document.querySelector("button") ??
        document.querySelector('a[href]') ??
        document.querySelector('[role="button"]');
      if (!btn) return false;

      const rect = btn.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const topEl = document.elementFromPoint(x, y);
      return topEl === btn || btn.contains(topEl);
    });
    return clickable;
  } catch {
    return false;
  }
}

// ── Visual Integrity ─────────────────────────────────────────────────

async function checkProfileVisualIntegrity(
  page: any,
  profile: SiteProfile,
  config: AgentConfig | undefined,
  details: Record<string, any>
): Promise<number> {
  const elementChecks: Record<string, boolean> = {};
  let passed = 0;
  let total = 0;

  // Check expected elements from profile
  for (const expected of profile.expectedElements) {
    total++;
    if (expected.selector) {
      try {
        const exists =
          (await page.locator(expected.selector).count()) > 0;
        elementChecks[expected.description] = exists;
        if (exists) passed++;
      } catch {
        elementChecks[expected.description] = false;
      }
    } else {
      // Without a selector, ask the LLM (if config available)
      // For now, give partial credit
      elementChecks[expected.description] = true;
      passed += 0.5;
    }
  }

  // If no expected elements defined, fall back to generic checks
  if (total === 0) {
    return checkBasicVisualIntegrity(page, details);
  }

  // Optionally run LLM visual assessment for richer scoring
  if (config) {
    try {
      const domSummary = await captureDomSnapshot(page);
      const assessment = await assessPageVisually(
        "Page state after remediation attempt",
        domSummary,
        profile,
        config
      );
      details.llmAssessment = assessment;

      // Blend DOM check results with LLM assessment
      const domScore = total > 0 ? passed / total : 0.5;
      return domScore * 0.6 + assessment.overallScore * 0.4;
    } catch {
      // LLM assessment failed, use DOM checks only
    }
  }

  details.elementChecks = elementChecks;
  return total > 0 ? passed / total : 0.5;
}

async function checkBasicVisualIntegrity(
  page: any,
  details: Record<string, any>
): Promise<number> {
  try {
    const checks = await page.evaluate(() => {
      const results: Record<string, boolean> = {};
      results.hasHeader =
        !!document.querySelector("header") ||
        !!document.querySelector("nav") ||
        !!document.querySelector('[role="banner"]');
      results.hasMainContent =
        !!document.querySelector("main") ||
        !!document.querySelector('[role="main"]') ||
        document.body.children.length > 2;
      results.hasText = document.body.innerText.length > 50;
      results.notBlank = document.body.innerHTML.length > 100;
      return results;
    });

    details.visualChecks = checks;
    const passed = Object.values(checks).filter(Boolean).length;
    return passed / Object.keys(checks).length;
  } catch {
    return 0.0;
  }
}

// ── Safety Checks ────────────────────────────────────────────────────

async function checkSafety(
  page: any,
  details: Record<string, any>
): Promise<number> {
  try {
    const issues = await page.evaluate(() => {
      const problems: string[] = [];

      if (document.body.innerText.includes("Unhandled Runtime Error")) {
        problems.push("runtime_error");
      }
      if (document.body.innerText.includes("Application error")) {
        problems.push("application_error");
      }
      if (document.body.children.length < 2) {
        problems.push("page_destroyed");
      }
      if (document.querySelectorAll("[role='alert']").length > 0) {
        problems.push("error_alerts");
      }
      // Check for hydration errors (React)
      if (document.body.innerText.includes("Hydration failed")) {
        problems.push("hydration_error");
      }

      return problems;
    });

    details.safetyIssues = issues;

    if (issues.length === 0) return 1.0;
    if (issues.includes("page_destroyed")) return 0.0;
    return Math.max(0, 1.0 - issues.length * 0.3);
  } catch {
    return 0.5;
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
