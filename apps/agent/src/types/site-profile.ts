import { z } from "zod";

/**
 * Site Profile — Configurable definition of what "healthy" means for any website.
 *
 * Instead of hardcoding checks for our ShopDemo target, the agent accepts
 * a profile that describes what critical user flows to test, what elements
 * matter, and what actions to take on failure.
 *
 * This makes the SRE Dreamer testable against any website.
 */

export const CriticalFlowSchema = z.object({
  /** Human-readable name for this flow (e.g., "User Login") */
  name: z.string(),

  /** Natural language description of the action to perform via Stagehand */
  action: z.string(),

  /**
   * How to verify the action succeeded.
   * - "selector": Check for a specific DOM element appearing
   * - "visual": Ask the LLM if the expected result is visible
   * - "url_change": Verify the URL changed after the action
   * - "network": Check that a specific API call was made
   */
  verification: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("selector"),
      selector: z.string(),
      expectVisible: z.boolean().default(true),
    }),
    z.object({
      type: z.literal("visual"),
      expectation: z.string(), // e.g., "A success message should appear"
    }),
    z.object({
      type: z.literal("url_change"),
      expectedPattern: z.string(), // regex pattern for expected URL
    }),
    z.object({
      type: z.literal("network"),
      urlPattern: z.string(),
      method: z.string().default("GET"),
    }),
  ]),

  /** Priority: higher = more critical. Used to weight scoring. */
  priority: z.number().min(1).max(10).default(5),
});

export type CriticalFlow = z.infer<typeof CriticalFlowSchema>;

export const RemediationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("vercel_rollback"),
    projectId: z.string(),
    goodDeploymentId: z.string(),
    teamId: z.string().optional(),
  }),
  z.object({
    type: z.literal("webhook"),
    url: z.string().url(),
    method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
    headers: z.record(z.string()).optional(),
    bodyTemplate: z.string().optional(), // JSON template with {{incident}} placeholders
  }),
  z.object({
    type: z.literal("github_issue"),
    repo: z.string(), // "owner/repo"
    labels: z.array(z.string()).default(["bug", "auto-detected"]),
  }),
  z.object({
    type: z.literal("slack_alert"),
    webhookUrl: z.string().url(),
    channel: z.string().optional(),
  }),
  z.object({
    type: z.literal("script"),
    command: z.string(),
  }),
  z.object({
    type: z.literal("none"),
    reason: z.string().default("Report only — no automated remediation"),
  }),
]);

export type RemediationAction = z.infer<typeof RemediationActionSchema>;

export const SiteProfileSchema = z.object({
  /** Unique name for this profile */
  name: z.string(),

  /** Target URL to monitor */
  url: z.string().url(),

  /** Description of the site for LLM context */
  description: z.string(),

  /** Critical user flows to test */
  criticalFlows: z.array(CriticalFlowSchema).min(1),

  /**
   * Key visual elements that should always be present.
   * Used for visual integrity scoring.
   * Can be selectors OR natural language descriptions.
   */
  expectedElements: z.array(
    z.object({
      description: z.string(), // "Navigation bar", "Footer with copyright"
      selector: z.string().optional(), // Optional CSS selector for fast check
    })
  ).default([]),

  /** What to do when an issue is found and a fix is identified */
  remediationAction: RemediationActionSchema,

  /** Additional context for the LLM reasoning layer */
  knowledgeBase: z.array(z.string()).default([]),
});

export type SiteProfile = z.infer<typeof SiteProfileSchema>;

// ── Pre-built Profiles ──────────────────────────────────────────────

/**
 * The ShopDemo profile — our primary hackathon demo target.
 */
export const SHOPDEMO_PROFILE: SiteProfile = {
  name: "ShopDemo",
  url: process.env.TARGET_URL ?? "http://localhost:3000",
  description:
    "E-commerce demo application. Users browse products and click Login to authenticate. " +
    "Known vulnerability: CSS z-index ghost overlays that block all pointer events.",
  criticalFlows: [
    {
      name: "User Login",
      action: "Click the login button",
      verification: {
        type: "selector",
        selector: '[data-testid="login-success"]',
        expectVisible: true,
      },
      priority: 10,
    },
    {
      name: "Add to Cart",
      action: "Click the Add to Cart button on the first product",
      verification: {
        type: "visual",
        expectation: "The button should respond to the click with visual feedback",
      },
      priority: 7,
    },
    {
      name: "Navigation",
      action: "Click the Products navigation link",
      verification: {
        type: "visual",
        expectation: "The page should scroll or navigate to a products section",
      },
      priority: 5,
    },
  ],
  expectedElements: [
    { description: "Header with site name", selector: "header h1" },
    { description: "Navigation bar", selector: "nav" },
    { description: "Login button", selector: '[data-testid="login-btn"]' },
    { description: "Product cards", selector: "main" },
    { description: "Footer", selector: "footer" },
  ],
  remediationAction: {
    type: "vercel_rollback",
    projectId: process.env.VERCEL_PROJECT_ID ?? "",
    goodDeploymentId: process.env.VERCEL_GOOD_DEPLOYMENT_ID ?? "",
    teamId: process.env.VERCEL_TEAM_ID,
  },
  knowledgeBase: [
    "CSS Stacking Contexts are formed by elements with opacity < 1, transform, filter, will-change, or position: fixed/sticky.",
    "A z-index value only matters within its stacking context. z-index: 9999 inside a child context can still be below z-index: 1 in a parent context.",
    "Invisible overlays with pointer-events: auto will intercept all clicks even if they have no visible content.",
    "Common culprits: modal backdrops that weren't removed, toast notification containers, cookie consent overlays.",
    "In Next.js with Tailwind, dynamic components often create new stacking contexts unintentionally via transform or opacity transitions.",
  ],
};

/**
 * Generic profile factory — point the agent at any URL with minimal config.
 */
export function createGenericProfile(
  url: string,
  flows: Array<{ name: string; action: string; expectation: string }>,
  options?: {
    name?: string;
    description?: string;
    remediationAction?: RemediationAction;
  }
): SiteProfile {
  return {
    name: options?.name ?? new URL(url).hostname,
    url,
    description:
      options?.description ?? `Website at ${url}. Monitoring critical user flows.`,
    criticalFlows: flows.map((f, i) => ({
      name: f.name,
      action: f.action,
      verification: {
        type: "visual" as const,
        expectation: f.expectation,
      },
      priority: 10 - i, // First flow = highest priority
    })),
    expectedElements: [],
    remediationAction: options?.remediationAction ?? {
      type: "none",
      reason: "Generic profile — report only",
    },
    knowledgeBase: [],
  };
}
