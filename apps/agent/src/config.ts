import "dotenv/config";
import type { AgentConfig } from "./types/index.js";

function env(key: string, required = true): string {
  const value = process.env[key];
  if (!value && required) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value ?? "";
}

export function loadConfig(): AgentConfig {
  // Core — required for any agent operation
  const config: AgentConfig = {
    targetUrl: env("TARGET_URL", false) || "http://localhost:3000",
    browserbaseApiKey: env("BROWSERBASE_API_KEY"),
    browserbaseProjectId: env("BROWSERBASE_PROJECT_ID"),
    openaiApiKey: env("OPENAI_API_KEY"),
    // Optional services — degrade gracefully if missing
    vercelToken: env("VERCEL_TOKEN", false),
    vercelProjectId: env("VERCEL_PROJECT_ID", false),
    vercelTeamId: env("VERCEL_TEAM_ID", false),
    vercelGoodDeploymentId: env("VERCEL_GOOD_DEPLOYMENT_ID", false),
    redisUrl: env("REDIS_URL", false) || "redis://localhost:6379",
    weaveProject: env("WEAVE_PROJECT", false) || "sre-dreamer",
    cerebrasApiKey: env("CEREBRAS_API_KEY", false),
  };

  // Warn about missing optional services so the user knows what's degraded
  const missing: string[] = [];
  if (!config.vercelToken) missing.push("VERCEL_TOKEN (rollback disabled)");
  if (!config.redisUrl || config.redisUrl === "redis://localhost:6379") {
    // Only warn if no explicit REDIS_URL was set
    if (!process.env.REDIS_URL) missing.push("REDIS_URL (memory disabled)");
  }
  if (!process.env.WANDB_API_KEY) missing.push("WANDB_API_KEY (Weave tracing disabled)");

  if (missing.length > 0) {
    console.warn(`[CONFIG] Optional services not configured: ${missing.join(", ")}`);
  }

  return config;
}
