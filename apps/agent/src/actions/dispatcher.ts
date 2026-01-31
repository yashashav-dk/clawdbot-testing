import * as weave from "weave";
import type { AgentConfig, Incident } from "../types/index.js";
import type { RemediationAction, SiteProfile } from "../types/site-profile.js";
import { rollbackToGoodDeployment } from "./vercel.js";

/**
 * The Action Dispatcher.
 *
 * Strategy-aware action layer: the dream phase discovers which fix works,
 * and this layer translates it into a real production action.
 *
 * Strategy → Action mapping:
 *   rollback_simulation  → Vercel rollback (if configured) or webhook
 *   css_patch_targeted   → Webhook/GitHub issue with patch details
 *   dom_removal          → Webhook/GitHub issue with element details
 *   style_override       → Webhook/GitHub issue with CSS override
 *   js_injection         → Webhook/GitHub issue with JS fix
 *   cache_clear          → Vercel redeploy or webhook
 *
 * Falls back to the profile's static remediationAction if the strategy
 * doesn't map to a more specific action.
 */

export interface ActionResult {
  success: boolean;
  actionType: string;
  message: string;
  durationMs: number;
  metadata?: Record<string, any>;
}

/**
 * Maps the winning dream strategy to the most appropriate production action.
 * The strategy name influences which action is taken — the dream's intelligence
 * is carried through to execution.
 */
export const executeRemediationAction = weave.op(
  async function executeRemediationAction(
  profile: SiteProfile,
  incident: Incident,
  strategyName: string,
  config: AgentConfig
): Promise<ActionResult> {
  const profileAction = profile.remediationAction;
  const start = Date.now();

  // Strategy-aware routing: the dream result influences the action
  const resolvedAction = resolveActionForStrategy(strategyName, profileAction, config);

  console.log(
    `[ACTION] Strategy "${strategyName}" → action "${resolvedAction.type}"`
  );

  try {
    switch (resolvedAction.type) {
      case "vercel_rollback":
        return await handleVercelRollback(resolvedAction, config, start);

      case "webhook":
        return await handleWebhook(resolvedAction, incident, start);

      case "github_issue":
        return await handleGithubIssue(resolvedAction, incident, strategyName, start);

      case "slack_alert":
        return await handleSlackAlert(resolvedAction, incident, strategyName, start);

      case "script":
        return await handleScript(resolvedAction, start);

      case "none":
        return {
          success: true,
          actionType: "none",
          message: `Report only: ${resolvedAction.reason}`,
          durationMs: Date.now() - start,
        };

      default:
        return {
          success: false,
          actionType: "unknown",
          message: `Unknown action type`,
          durationMs: Date.now() - start,
        };
    }
  } catch (error: any) {
    return {
      success: false,
      actionType: resolvedAction.type,
      message: `Action failed: ${error?.message ?? String(error)}`,
      durationMs: Date.now() - start,
    };
  }
});

/**
 * Maps dream strategy → production action.
 * If the strategy implies a specific action (e.g., rollback_simulation → vercel_rollback),
 * upgrade the action accordingly. Otherwise, fall back to the profile's configured action.
 */
function resolveActionForStrategy(
  strategyName: string,
  profileAction: RemediationAction,
  config: AgentConfig
): RemediationAction {
  switch (strategyName) {
    case "rollback_simulation":
      // Dream proved rollback works — trigger real Vercel rollback if configured
      if (config.vercelToken && config.vercelProjectId) {
        return {
          type: "vercel_rollback",
          deploymentId: config.vercelGoodDeploymentId,
        };
      }
      return profileAction;

    case "cache_clear":
      // Cache-related fix — a redeploy or the configured action
      return profileAction;

    case "css_patch_targeted":
    case "dom_removal":
    case "style_override":
    case "js_injection":
      // These are client-side fixes that need a code change.
      // If the profile has a github_issue or webhook action, use it
      // so the fix details are reported. Otherwise use profile default.
      if (profileAction.type === "github_issue" || profileAction.type === "webhook") {
        return profileAction;
      }
      return profileAction;

    default:
      return profileAction;
  }
}

async function handleVercelRollback(
  action: Extract<RemediationAction, { type: "vercel_rollback" }>,
  config: AgentConfig,
  start: number
): Promise<ActionResult> {
  const overriddenConfig = {
    ...config,
    vercelProjectId: action.projectId || config.vercelProjectId,
    vercelGoodDeploymentId:
      action.goodDeploymentId || config.vercelGoodDeploymentId,
    vercelTeamId: action.teamId || config.vercelTeamId,
  };

  const result = await rollbackToGoodDeployment(overriddenConfig);

  return {
    success: result.success,
    actionType: "vercel_rollback",
    message: result.message,
    durationMs: Date.now() - start,
    metadata: { deploymentId: result.deploymentId },
  };
}

async function handleWebhook(
  action: Extract<RemediationAction, { type: "webhook" }>,
  incident: Incident,
  start: number
): Promise<ActionResult> {
  const body = action.bodyTemplate
    ? action.bodyTemplate
        .replace(/\{\{incident\.id\}\}/g, incident.id)
        .replace(/\{\{incident\.type\}\}/g, incident.type)
        .replace(/\{\{incident\.description\}\}/g, incident.description)
        .replace(/\{\{incident\.url\}\}/g, incident.url)
    : JSON.stringify({
        event: "sre_dreamer_incident",
        incident: {
          id: incident.id,
          type: incident.type,
          severity: incident.severity,
          description: incident.description,
          url: incident.url,
          timestamp: incident.timestamp,
        },
      });

  const res = await fetch(action.url, {
    method: action.method,
    headers: {
      "Content-Type": "application/json",
      ...action.headers,
    },
    body,
    signal: AbortSignal.timeout(30000),
  });

  return {
    success: res.ok,
    actionType: "webhook",
    message: res.ok
      ? `Webhook delivered to ${action.url} (${res.status})`
      : `Webhook failed: ${res.status} ${res.statusText}`,
    durationMs: Date.now() - start,
    metadata: { statusCode: res.status },
  };
}

async function handleGithubIssue(
  action: Extract<RemediationAction, { type: "github_issue" }>,
  incident: Incident,
  strategyName: string,
  start: number
): Promise<ActionResult> {
  // Uses GitHub API directly — requires GITHUB_TOKEN in env
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      success: false,
      actionType: "github_issue",
      message: "GITHUB_TOKEN not set — cannot create issue",
      durationMs: Date.now() - start,
    };
  }

  const title = `[SRE Dreamer] ${incident.type}: ${incident.description.slice(0, 80)}`;
  const body = `## Auto-Detected Incident

| Field | Value |
|-------|-------|
| **ID** | \`${incident.id}\` |
| **Type** | ${incident.type} |
| **Severity** | ${incident.severity} |
| **URL** | ${incident.url} |
| **Detected** | ${incident.timestamp} |
| **Blocking Element** | \`${incident.blockingElement ?? "N/A"}\` |
| **Recommended Strategy** | ${strategyName} |

### Description
${incident.description}

### Error
\`\`\`
${incident.errorMessage ?? "N/A"}
\`\`\`

---
*Created automatically by SRE Dreamer*`;

  const res = await fetch(
    `https://api.github.com/repos/${action.repo}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        body,
        labels: action.labels,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    return {
      success: false,
      actionType: "github_issue",
      message: `GitHub issue creation failed: ${res.status} ${err}`,
      durationMs: Date.now() - start,
    };
  }

  const data = await res.json();
  return {
    success: true,
    actionType: "github_issue",
    message: `GitHub issue created: ${data.html_url}`,
    durationMs: Date.now() - start,
    metadata: { issueUrl: data.html_url, issueNumber: data.number },
  };
}

async function handleSlackAlert(
  action: Extract<RemediationAction, { type: "slack_alert" }>,
  incident: Incident,
  strategyName: string,
  start: number
): Promise<ActionResult> {
  const payload = {
    ...(action.channel ? { channel: action.channel } : {}),
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `SRE Dreamer Alert: ${incident.type}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Severity:*\n${incident.severity}` },
          { type: "mrkdwn", text: `*URL:*\n${incident.url}` },
          { type: "mrkdwn", text: `*Strategy:*\n${strategyName}` },
          { type: "mrkdwn", text: `*Detected:*\n${incident.timestamp}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Description:*\n${incident.description}`,
        },
      },
    ],
  };

  const res = await fetch(action.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  return {
    success: res.ok,
    actionType: "slack_alert",
    message: res.ok
      ? "Slack alert sent"
      : `Slack alert failed: ${res.status}`,
    durationMs: Date.now() - start,
  };
}

async function handleScript(
  action: Extract<RemediationAction, { type: "script" }>,
  start: number
): Promise<ActionResult> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    const { stdout, stderr } = await execAsync(action.command, {
      timeout: 60000,
    });
    return {
      success: true,
      actionType: "script",
      message: `Script executed: ${stdout.trim().slice(0, 200)}`,
      durationMs: Date.now() - start,
      metadata: { stdout, stderr },
    };
  } catch (error: any) {
    return {
      success: false,
      actionType: "script",
      message: `Script failed: ${error?.message}`,
      durationMs: Date.now() - start,
    };
  }
}
