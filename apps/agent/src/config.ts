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
  return {
    targetUrl: env("TARGET_URL"),
    browserbaseApiKey: env("BROWSERBASE_API_KEY"),
    browserbaseProjectId: env("BROWSERBASE_PROJECT_ID"),
    vercelToken: env("VERCEL_TOKEN"),
    vercelProjectId: env("VERCEL_PROJECT_ID"),
    vercelTeamId: env("VERCEL_TEAM_ID", false),
    vercelGoodDeploymentId: env("VERCEL_GOOD_DEPLOYMENT_ID"),
    redisUrl: env("REDIS_URL"),
    openaiApiKey: env("OPENAI_API_KEY"),
    weaveProject: env("WEAVE_PROJECT", false) || "sre-dreamer",
    cerebrasApiKey: env("CEREBRAS_API_KEY", false),
  };
}
