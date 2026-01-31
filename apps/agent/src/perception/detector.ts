import { Stagehand } from "@browserbasehq/stagehand";
import type {
  Incident,
  VisualCheckResult,
  HealthCheckResult,
  AgentConfig,
} from "../types/index.js";

/**
 * The Perception Layer.
 *
 * Uses Stagehand (backed by Browserbase) to interact with the target app
 * as a real user would. Detects visual regressions that HTTP health checks miss.
 */

export async function runVisualHealthCheck(
  config: AgentConfig
): Promise<HealthCheckResult> {
  const timestamp = new Date().toISOString();

  // First, prove that traditional monitoring sees nothing wrong
  let httpStatus: number | undefined;
  try {
    const res = await fetch(`${config.targetUrl}/api/health`);
    httpStatus = res.status;
  } catch {
    httpStatus = undefined;
  }

  // Now do what traditional monitoring can't: check visually
  const visualCheck = await runStagehandCheck(config);

  return {
    healthy: visualCheck.loginClickable && visualCheck.pageLoaded,
    url: config.targetUrl,
    httpStatus,
    visualCheck,
    timestamp,
  };
}

async function runStagehandCheck(
  config: AgentConfig
): Promise<VisualCheckResult> {
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
    await page.goto(config.targetUrl, { waitUntil: "networkidle" });

    // Check if page loaded by looking for key elements
    const pageLoaded = await page
      .locator('[data-testid="health-ok"]')
      .count()
      .then((c) => c > 0)
      .catch(() => false);

    // The critical test: try to click the login button
    let loginClickable = false;
    let occlusionDetected = false;
    let blockingElementSelector: string | undefined;
    let errorMessage: string | undefined;

    try {
      // Use Stagehand's natural language action
      await stagehand.act({ action: "Click the login button" });

      // Verify the click actually worked by checking for success feedback
      const successVisible = await page
        .locator('[data-testid="login-success"]')
        .isVisible()
        .catch(() => false);

      loginClickable = successVisible;

      if (!successVisible) {
        // The act() didn't throw but the click didn't register
        occlusionDetected = true;
        errorMessage = "Click action completed but no response from button";
      }
    } catch (error: any) {
      const msg = error?.message ?? String(error);
      errorMessage = msg;

      if (
        msg.includes("not clickable at point") ||
        msg.includes("intercept") ||
        msg.includes("obscured") ||
        msg.includes("other element would receive")
      ) {
        occlusionDetected = true;

        // Try to identify the blocking element
        blockingElementSelector = await identifyBlockingElement(page);
      }
    }

    return {
      loginClickable,
      pageLoaded,
      occlusionDetected,
      blockingElementSelector,
      errorMessage,
    };
  } finally {
    await stagehand.close().catch(() => {});
  }
}

async function identifyBlockingElement(page: any): Promise<string | undefined> {
  try {
    // Use Playwright's evaluate to find what's on top at the login button's position
    return await page.evaluate(() => {
      const loginBtn = document.querySelector('[data-testid="login-btn"]');
      if (!loginBtn) return undefined;

      const rect = loginBtn.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const topElement = document.elementFromPoint(centerX, centerY);
      if (!topElement || topElement === loginBtn) return undefined;

      // Build a selector for the blocking element
      const id = topElement.id ? `#${topElement.id}` : "";
      const classes = topElement.className
        ? `.${String(topElement.className).split(" ").join(".")}`
        : "";
      const tag = topElement.tagName.toLowerCase();

      return `${tag}${id}${classes}`;
    });
  } catch {
    return undefined;
  }
}

export function buildIncidentFromCheck(
  check: HealthCheckResult
): Incident | null {
  if (check.healthy) return null;

  const id = `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let type: Incident["type"] = "unknown";
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
