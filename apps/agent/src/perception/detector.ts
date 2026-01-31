import { Stagehand } from "@browserbasehq/stagehand";
import type {
  Incident,
  VisualCheckResult,
  HealthCheckResult,
  AgentConfig,
  IncidentType,
} from "../types/index.js";
import type { SiteProfile, CriticalFlow } from "../types/site-profile.js";

/**
 * The Perception Layer.
 *
 * Uses Stagehand (backed by Browserbase) to interact with any target app
 * as a real user would. Tests each critical flow defined in the site profile.
 * Detects visual regressions that HTTP health checks miss.
 */

export interface FlowTestResult {
  flow: CriticalFlow;
  passed: boolean;
  occlusionDetected: boolean;
  blockingElement?: string;
  errorMessage?: string;
  domSnapshot?: string;
  durationMs: number;
}

export interface PerceptionResult {
  healthy: boolean;
  url: string;
  httpStatus?: number;
  httpHealthy: boolean;
  flowResults: FlowTestResult[];
  domSnapshot: string;
  sessionReplayUrl?: string;
  timestamp: string;
}

export async function runPerception(
  profile: SiteProfile,
  config: AgentConfig
): Promise<PerceptionResult> {
  const timestamp = new Date().toISOString();

  // First, prove that traditional monitoring sees nothing wrong
  const httpResult = await checkHttpHealth(profile.url);

  // Now do what traditional monitoring can't: visual + interaction checks
  const stagehandResult = await runStagehandFlowChecks(profile, config);

  // Site is healthy only if ALL critical flows pass
  const healthy = stagehandResult.flowResults.every((r) => r.passed);

  return {
    healthy,
    url: profile.url,
    httpStatus: httpResult.status,
    httpHealthy: httpResult.healthy,
    flowResults: stagehandResult.flowResults,
    domSnapshot: stagehandResult.domSnapshot,
    sessionReplayUrl: stagehandResult.sessionReplayUrl,
    timestamp,
  };
}

async function checkHttpHealth(
  url: string
): Promise<{ healthy: boolean; status?: number }> {
  try {
    // Try /api/health first, then fall back to the root URL
    for (const path of ["/api/health", "/"]) {
      try {
        const res = await fetch(`${url}${path}`, {
          signal: AbortSignal.timeout(10000),
        });
        return { healthy: res.ok, status: res.status };
      } catch {
        continue;
      }
    }
    return { healthy: false };
  } catch {
    return { healthy: false };
  }
}

interface StagehandFlowResult {
  flowResults: FlowTestResult[];
  domSnapshot: string;
  sessionReplayUrl?: string;
}

async function runStagehandFlowChecks(
  profile: SiteProfile,
  config: AgentConfig
): Promise<StagehandFlowResult> {
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

    // Navigate to target
    await page.goto(profile.url, { waitUntil: "networkidle" });

    // Capture initial DOM snapshot for diagnosis
    const domSnapshot = await captureDomSnapshot(page);

    // Test each critical flow
    const flowResults: FlowTestResult[] = [];

    for (const flow of profile.criticalFlows) {
      const result = await testCriticalFlow(stagehand, page, flow, profile);
      flowResults.push(result);

      // If a flow fails with occlusion, subsequent flows will likely fail too.
      // Continue anyway to gather data, but reload the page between flows
      // to avoid state pollution.
      if (!result.passed) {
        try {
          await page.goto(profile.url, { waitUntil: "networkidle" });
        } catch {}
      }
    }

    // Get session replay URL from Browserbase
    let sessionReplayUrl: string | undefined;
    try {
      // Access the session ID from Stagehand's browserbase context
      const browserContext = stagehand.context;
      const pages = browserContext.pages();
      // The replay URL follows the pattern: https://browserbase.com/sessions/{sessionId}
      // We extract the sessionId from the CDP connection if available
      sessionReplayUrl = (stagehand as any).browserbaseSessionID
        ? `https://www.browserbase.com/sessions/${(stagehand as any).browserbaseSessionID}`
        : undefined;
    } catch {}

    return { flowResults, domSnapshot, sessionReplayUrl };
  } finally {
    await stagehand.close().catch(() => {});
  }
}

async function testCriticalFlow(
  stagehand: Stagehand,
  page: any,
  flow: CriticalFlow,
  profile: SiteProfile
): Promise<FlowTestResult> {
  const start = Date.now();

  try {
    // Execute the action using Stagehand's natural language
    await stagehand.act({ action: flow.action });

    // Verify the result based on the flow's verification type
    const verified = await verifyFlowResult(stagehand, page, flow);

    if (verified) {
      return {
        flow,
        passed: true,
        occlusionDetected: false,
        durationMs: Date.now() - start,
      };
    }

    // Action didn't throw but verification failed — possible occlusion
    const blockingElement = await identifyBlockingElement(page, flow);
    return {
      flow,
      passed: false,
      occlusionDetected: !!blockingElement,
      blockingElement,
      errorMessage: "Action completed but verification failed — element may be visually present but non-interactive",
      durationMs: Date.now() - start,
    };
  } catch (error: any) {
    const msg = error?.message ?? String(error);
    const isOcclusion =
      msg.includes("not clickable at point") ||
      msg.includes("intercept") ||
      msg.includes("obscured") ||
      msg.includes("other element would receive") ||
      msg.includes("Element is not visible") ||
      msg.includes("element click intercepted");

    let blockingElement: string | undefined;
    let domSnapshot: string | undefined;

    if (isOcclusion) {
      blockingElement = await identifyBlockingElement(page, flow);
      domSnapshot = await captureDomSnapshot(page);
    }

    return {
      flow,
      passed: false,
      occlusionDetected: isOcclusion,
      blockingElement,
      errorMessage: msg,
      domSnapshot,
      durationMs: Date.now() - start,
    };
  }
}

async function verifyFlowResult(
  stagehand: Stagehand,
  page: any,
  flow: CriticalFlow
): Promise<boolean> {
  const verification = flow.verification;

  switch (verification.type) {
    case "selector": {
      try {
        const locator = page.locator(verification.selector);
        if (verification.expectVisible) {
          return await locator
            .isVisible({ timeout: 3000 })
            .catch(() => false);
        }
        return (await locator.count()) > 0;
      } catch {
        return false;
      }
    }

    case "visual": {
      // Use Stagehand's extract to ask the LLM about the page state
      try {
        const observation = await stagehand.extract({
          instruction: `Check if the following is true about this page: "${verification.expectation}". Answer with just "yes" or "no".`,
          schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } as any,
        });
        const answer = (observation as any)?.answer?.toLowerCase() ?? "";
        return answer.includes("yes");
      } catch {
        return false;
      }
    }

    case "url_change": {
      try {
        const currentUrl = page.url();
        return new RegExp(verification.expectedPattern).test(currentUrl);
      } catch {
        return false;
      }
    }

    case "network": {
      // Network verification would need request interception setup
      // For now, return true if the action didn't throw
      return true;
    }

    default:
      return false;
  }
}

/**
 * Identifies the element blocking interaction at the position of a target.
 * Works generically by finding clickable elements near the center of the viewport
 * or using specific selectors from the flow definition.
 */
async function identifyBlockingElement(
  page: any,
  flow?: CriticalFlow
): Promise<string | undefined> {
  try {
    return await page.evaluate(
      (flowData: { selector?: string }) => {
        // Try to find the target element to get its position
        let targetEl: Element | null = null;

        if (flowData.selector) {
          targetEl = document.querySelector(flowData.selector);
        }

        // If no specific target, check the center of the viewport
        const rect = targetEl?.getBoundingClientRect();
        const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
        const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;

        const topElement = document.elementFromPoint(x, y);
        if (!topElement) return undefined;
        if (targetEl && topElement === targetEl) return undefined;

        // Check if this element is a likely overlay/blocker
        const style = window.getComputedStyle(topElement);
        const isLikelyOverlay =
          style.position === "fixed" ||
          style.position === "absolute" ||
          parseInt(style.zIndex) > 100 ||
          (topElement.clientWidth > window.innerWidth * 0.8 &&
            topElement.clientHeight > window.innerHeight * 0.8);

        if (!isLikelyOverlay && targetEl) return undefined;

        const id = topElement.id ? `#${topElement.id}` : "";
        const classes = topElement.className
          ? `.${String(topElement.className)
              .trim()
              .split(/\s+/)
              .join(".")}`
          : "";
        const tag = topElement.tagName.toLowerCase();

        return `${tag}${id}${classes}`;
      },
      {
        selector:
          flow?.verification.type === "selector"
            ? flow.verification.selector
            : undefined,
      }
    );
  } catch {
    return undefined;
  }
}

/**
 * Captures a structured DOM snapshot for LLM analysis.
 * Includes computed styles on key elements and the stacking context tree.
 */
export async function captureDomSnapshot(page: any): Promise<string> {
  try {
    return await page.evaluate(() => {
      function summarizeElement(el: Element, depth: number): string {
        if (depth > 4) return "";
        const indent = "  ".repeat(depth);
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const classes = el.className
          ? `.${String(el.className)
              .trim()
              .split(/\s+/)
              .join(".")}`
          : "";
        const style = window.getComputedStyle(el);

        // Include style info for positioned/high-z-index elements
        let styleInfo = "";
        if (
          style.position !== "static" ||
          style.zIndex !== "auto" ||
          style.pointerEvents !== "auto"
        ) {
          const parts: string[] = [];
          if (style.position !== "static") parts.push(`pos:${style.position}`);
          if (style.zIndex !== "auto") parts.push(`z:${style.zIndex}`);
          if (style.pointerEvents !== "auto")
            parts.push(`ptr:${style.pointerEvents}`);
          if (style.opacity !== "1") parts.push(`opacity:${style.opacity}`);
          styleInfo = ` [${parts.join(", ")}]`;
        }

        const text =
          el.children.length === 0
            ? el.textContent?.trim().slice(0, 50) ?? ""
            : "";
        const textPart = text ? ` "${text}"` : "";

        let result = `${indent}<${tag}${id}${classes}${styleInfo}${textPart}>\n`;

        for (const child of Array.from(el.children)) {
          result += summarizeElement(child, depth + 1);
        }

        return result;
      }

      return summarizeElement(document.body, 0);
    });
  } catch {
    return "(DOM snapshot unavailable)";
  }
}

// ── Incident Builder ─────────────────────────────────────────────────

export function buildIncidentFromPerception(
  result: PerceptionResult,
  profile: SiteProfile
): Incident | null {
  if (result.healthy) return null;

  const id = `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const failedFlows = result.flowResults.filter((r) => !r.passed);
  const hasOcclusion = failedFlows.some((r) => r.occlusionDetected);

  let type: IncidentType = "unknown";
  let severity: Incident["severity"] = "medium";

  if (hasOcclusion) {
    type = "visual_occlusion";
    severity = "critical";
  } else if (failedFlows.length > 0) {
    type = "element_unclickable";
    severity = failedFlows.length >= profile.criticalFlows.length / 2 ? "critical" : "high";
  }

  const description = failedFlows
    .map(
      (f) =>
        `Flow "${f.flow.name}" failed: ${f.errorMessage ?? "verification failed"}`
    )
    .join("; ");

  const primaryBlocker = failedFlows.find((f) => f.blockingElement)?.blockingElement;

  return {
    id,
    timestamp: result.timestamp,
    type,
    severity,
    description: `Visual health check failed for ${profile.name}: ${description}`,
    url: result.url,
    domSnapshot: result.domSnapshot,
    blockingElement: primaryBlocker,
    errorMessage: failedFlows[0]?.errorMessage,
  };
}

/**
 * Legacy wrapper for backward compatibility with the old API.
 */
export async function runVisualHealthCheck(
  config: AgentConfig
): Promise<HealthCheckResult> {
  const { SHOPDEMO_PROFILE } = await import("../types/site-profile.js");
  const profile = { ...SHOPDEMO_PROFILE, url: config.targetUrl };
  const result = await runPerception(profile, config);

  return {
    healthy: result.healthy,
    url: result.url,
    httpStatus: result.httpStatus,
    visualCheck: {
      loginClickable: result.flowResults.find(
        (f) => f.flow.name === "User Login"
      )?.passed ?? false,
      pageLoaded: result.httpStatus === 200,
      occlusionDetected: result.flowResults.some((f) => f.occlusionDetected),
      blockingElementSelector: result.flowResults.find(
        (f) => f.blockingElement
      )?.blockingElement,
      errorMessage: result.flowResults.find((f) => f.errorMessage)
        ?.errorMessage,
    },
    timestamp: result.timestamp,
  };
}

export function buildIncidentFromCheck(
  check: HealthCheckResult
): Incident | null {
  if (check.healthy) return null;

  const id = `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let type: IncidentType = "unknown";
  let severity: Incident["severity"] = "medium";

  if (check.visualCheck.occlusionDetected) {
    type = "visual_occlusion";
    severity = "critical";
  } else if (!check.visualCheck.loginClickable) {
    type = "element_unclickable";
    severity = "high";
  } else if (!check.visualCheck.pageLoaded) {
    type = "content_missing";
    severity = "high";
  }

  return {
    id,
    timestamp: check.timestamp,
    type,
    severity,
    description: `Visual health check failed: ${check.visualCheck.errorMessage ?? "unknown reason"}`,
    url: check.url,
    blockingElement: check.visualCheck.blockingElementSelector,
    errorMessage: check.visualCheck.errorMessage,
  };
}
