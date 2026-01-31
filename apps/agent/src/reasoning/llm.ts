import OpenAI from "openai";
import type { AgentConfig, Incident } from "../types/index.js";
import type { SiteProfile } from "../types/site-profile.js";

/**
 * The LLM Reasoning Layer.
 *
 * Uses OpenAI (or Cerebras for speed) to perform root cause diagnosis,
 * strategy generation, visual assessment, and post-mortem summarization.
 *
 * This is the "brain" that makes the agent's decisions non-deterministic
 * and capable of reasoning about novel failure modes.
 */

let client: OpenAI | null = null;

export function getOpenAIClient(config: AgentConfig): OpenAI {
  if (!client) {
    // Use Cerebras if available for speed, otherwise OpenAI
    if (config.cerebrasApiKey) {
      client = new OpenAI({
        apiKey: config.cerebrasApiKey,
        baseURL: "https://api.cerebras.ai/v1",
      });
    } else {
      client = new OpenAI({ apiKey: config.openaiApiKey });
    }
  }
  return client;
}

function getModel(config: AgentConfig): string {
  return config.cerebrasApiKey ? "llama-3.3-70b" : "gpt-4o-mini";
}

// ── Root Cause Diagnosis ─────────────────────────────────────────────

export interface Diagnosis {
  rootCause: string;
  confidence: number;
  category: string;
  suggestedStrategies: string[];
  reasoning: string;
}

export async function diagnoseRootCause(
  incident: Incident,
  domSnapshot: string,
  profile: SiteProfile,
  config: AgentConfig
): Promise<Diagnosis> {
  const openai = getOpenAIClient(config);

  const knowledgeContext = profile.knowledgeBase.length > 0
    ? `\n\nRelevant knowledge:\n${profile.knowledgeBase.map((k, i) => `${i + 1}. ${k}`).join("\n")}`
    : "";

  const response = await openai.chat.completions.create({
    model: getModel(config),
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an expert SRE agent diagnosing visual regressions in web applications.
You analyze DOM snapshots and error messages to determine root causes.
Always respond with valid JSON.${knowledgeContext}`,
      },
      {
        role: "user",
        content: `Diagnose this incident:

Site: ${profile.name} (${profile.url})
Description: ${profile.description}

Incident:
- Type: ${incident.type}
- Error: ${incident.errorMessage ?? "none"}
- Blocking element: ${incident.blockingElement ?? "unknown"}

DOM snapshot (truncated):
${domSnapshot.slice(0, 4000)}

Respond with JSON:
{
  "rootCause": "Brief description of the root cause",
  "confidence": 0.0-1.0,
  "category": "z_index_overlap|missing_element|layout_shift|js_error|css_regression|unknown",
  "suggestedStrategies": ["strategy_name_1", "strategy_name_2"],
  "reasoning": "Step-by-step reasoning about why this is the root cause"
}

Valid strategies: css_patch_targeted, dom_removal, rollback_simulation, cache_clear, js_injection, style_override`,
      },
    ],
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");
    return {
      rootCause: parsed.rootCause ?? "Unknown",
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
      category: parsed.category ?? "unknown",
      suggestedStrategies: parsed.suggestedStrategies ?? ["rollback_simulation"],
      reasoning: parsed.reasoning ?? "",
    };
  } catch {
    return {
      rootCause: "Failed to parse LLM diagnosis",
      confidence: 0.3,
      category: "unknown",
      suggestedStrategies: ["rollback_simulation", "css_patch_targeted"],
      reasoning: "LLM response was not valid JSON. Falling back to default strategies.",
    };
  }
}

// ── Visual Assessment ────────────────────────────────────────────────

export interface VisualAssessment {
  pageAppearsFunctional: boolean;
  issuesFound: string[];
  overallScore: number;
  details: string;
}

export async function assessPageVisually(
  screenshotDescription: string,
  domSummary: string,
  profile: SiteProfile,
  config: AgentConfig
): Promise<VisualAssessment> {
  const openai = getOpenAIClient(config);

  const expectedElements = profile.expectedElements
    .map((e) => `- ${e.description}`)
    .join("\n");

  const response = await openai.chat.completions.create({
    model: getModel(config),
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a visual QA agent evaluating whether a web page appears functional.
You check for visual integrity, layout issues, and missing elements. Respond with JSON.`,
      },
      {
        role: "user",
        content: `Evaluate this page state:

Site: ${profile.name}
Expected elements:
${expectedElements || "- (none specified — use general web page expectations)"}

Page DOM summary:
${domSummary.slice(0, 3000)}

Page description/state:
${screenshotDescription}

Respond with JSON:
{
  "pageAppearsFunctional": true/false,
  "issuesFound": ["list of issues"],
  "overallScore": 0.0-1.0,
  "details": "Brief assessment"
}`,
      },
    ],
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");
    return {
      pageAppearsFunctional: parsed.pageAppearsFunctional ?? false,
      issuesFound: parsed.issuesFound ?? [],
      overallScore: Math.min(1, Math.max(0, parsed.overallScore ?? 0.5)),
      details: parsed.details ?? "",
    };
  } catch {
    return {
      pageAppearsFunctional: false,
      issuesFound: ["Failed to parse visual assessment"],
      overallScore: 0.5,
      details: "LLM assessment failed",
    };
  }
}

// ── Post-Mortem Summary ──────────────────────────────────────────────

export async function generatePostMortem(
  incident: Incident,
  diagnosis: Diagnosis,
  strategyUsed: string,
  success: boolean,
  config: AgentConfig
): Promise<string> {
  const openai = getOpenAIClient(config);

  const response = await openai.chat.completions.create({
    model: getModel(config),
    temperature: 0.3,
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content: "Write concise post-mortem summaries for SRE incidents. One paragraph, focus on: what happened, root cause, how it was fixed, and what to watch for next time.",
      },
      {
        role: "user",
        content: `Summarize this incident:
- Type: ${incident.type}
- URL: ${incident.url}
- Error: ${incident.errorMessage ?? "none"}
- Blocking element: ${incident.blockingElement ?? "unknown"}
- Root cause: ${diagnosis.rootCause} (${diagnosis.category})
- Strategy used: ${strategyUsed}
- Success: ${success}
- Reasoning: ${diagnosis.reasoning}`,
      },
    ],
  });

  return (
    response.choices[0].message.content ??
    `Incident ${incident.id}: ${incident.type} at ${incident.url}. Fixed via ${strategyUsed}.`
  );
}

// ── Embedding Generation ─────────────────────────────────────────────

export async function generateEmbedding(
  text: string,
  config: AgentConfig
): Promise<number[]> {
  // Embeddings always use OpenAI — Cerebras doesn't support them
  const openai = new OpenAI({ apiKey: config.openaiApiKey });

  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  return response.data[0].embedding;
}
