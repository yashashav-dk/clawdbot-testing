import type { AgentConfig } from "../types/index.js";

/**
 * The Action Layer: Vercel integration.
 *
 * Handles programmatic rollback to a known-good deployment.
 */

interface RollbackResult {
  success: boolean;
  deploymentId: string;
  message: string;
  durationMs: number;
}

export async function rollbackToGoodDeployment(
  config: AgentConfig
): Promise<RollbackResult> {
  const start = Date.now();
  const deploymentId = config.vercelGoodDeploymentId;

  const url = new URL(
    `https://api.vercel.com/v9/projects/${config.vercelProjectId}/rollback/${deploymentId}`
  );
  if (config.vercelTeamId) {
    url.searchParams.set("teamId", config.vercelTeamId);
  }

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.vercelToken}`,
        "Content-Type": "application/json",
      },
    });

    const durationMs = Date.now() - start;

    if (!res.ok) {
      const body = await res.text();
      return {
        success: false,
        deploymentId,
        message: `Rollback API returned ${res.status}: ${body}`,
        durationMs,
      };
    }

    return {
      success: true,
      deploymentId,
      message: `Successfully triggered rollback to deployment ${deploymentId}`,
      durationMs,
    };
  } catch (error: any) {
    return {
      success: false,
      deploymentId,
      message: `Rollback failed: ${error?.message ?? String(error)}`,
      durationMs: Date.now() - start,
    };
  }
}

export async function getDeploymentStatus(
  config: AgentConfig,
  deploymentId: string
): Promise<{ state: string; url?: string }> {
  const url = new URL(
    `https://api.vercel.com/v13/deployments/${deploymentId}`
  );
  if (config.vercelTeamId) {
    url.searchParams.set("teamId", config.vercelTeamId);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.vercelToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to get deployment status: ${res.status}`);
  }

  const data = await res.json();
  return { state: data.readyState, url: data.url };
}

export async function listRecentDeployments(
  config: AgentConfig,
  limit = 5
): Promise<Array<{ id: string; url: string; state: string; created: string }>> {
  const url = new URL("https://api.vercel.com/v6/deployments");
  url.searchParams.set("projectId", config.vercelProjectId);
  url.searchParams.set("limit", String(limit));
  if (config.vercelTeamId) {
    url.searchParams.set("teamId", config.vercelTeamId);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.vercelToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to list deployments: ${res.status}`);
  }

  const data = await res.json();
  return data.deployments.map((d: any) => ({
    id: d.uid,
    url: d.url,
    state: d.readyState,
    created: d.created,
  }));
}
