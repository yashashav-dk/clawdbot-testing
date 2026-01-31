import * as weave from "weave";
import OpenAI from "openai";
import type { AgentConfig, Incident } from "../types/index.js";
import type { SiteProfile } from "../types/site-profile.js";

/**
 * The LLM Reasoning Layer.
 *
 * Uses OpenAI (or Cerebras for speed) to perform root cause diagnosis,
 * strategy generation, visual assessment, and post-mortem summarization.
 *
 * All LLM calls are traced via Weave's wrapOpenAI — token usage, latency,
 * and request/response pairs appear in the Weave dashboard automatically.
 */

let _client: OpenAI | null = null;
let _embeddingClient: OpenAI | null = null;

export function getOpenAIClient(config: AgentConfig): OpenAI {
  if (!_client) {
    const base = config.cerebrasApiKey
      ? new OpenAI({
          apiKey: config.cerebrasApiKey,
          baseURL: "https://api.cerebras.ai/v1",
        })
      : new OpenAI({ apiKey: config.openaiApiKey });

    // Wrap with Weave for automatic LLM call tracing
    try {
      _client = weave.wrapOpenAI(base);
    } catch {
      _client = base;
    }
  }
  return _client;
}

function getEmbeddingClient(config: AgentConfig): OpenAI {
  if (!_embeddingClient) {
    const base = new OpenAI({ apiKey: config.openaiApiKey });
    try {
      _embeddingClient = weave.wrapOpenAI(base);
    } catch {
      _embeddingClient = base;
    }
  }
  return _embeddingClient;
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

/**
 * Diagnoses the root cause of an incident using LLM reasoning.
 * Traced as a Weave op — appears as "diagnoseRootCause" in the trace tree.
 */
export const diagnoseRootCause = weave.op(
  async function diagnoseRootCause(
    incident: Incident,
    domSnapshot: string,
    profile: SiteProfile,
    config: AgentConfig
  ): Promise<Diagnosis> {
    const openai = getOpenAIClient(config);

    const knowledgeContext =
      profile.knowledgeBase.length > 0
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
        suggestedStrategies:
          parsed.suggestedStrategies ?? ["rollback_simulation"],
        reasoning: parsed.reasoning ?? "",
      };
    } catch {
      return {
        rootCause: "Failed to parse LLM diagnosis",
        confidence: 0.3,
        category: "unknown",
        suggestedStrategies: ["rollback_simulation", "css_patch_targeted"],
        reasoning:
          "LLM response was not valid JSON. Falling back to default strategies.",
      };
    }
  }
);

// ── Visual Assessment ────────────────────────────────────────────────

export interface VisualAssessment {
  pageAppearsFunctional: boolean;
  issuesFound: string[];
  overallScore: number;
  details: string;
}

/**
 * Assesses page visual integrity using LLM reasoning.
 * When a screenshot is provided, uses gpt-4o vision to literally see the page.
 * Falls back to DOM-only analysis when no screenshot is available.
 * Traced as a Weave op — appears as "assessPageVisually" in the trace tree.
 */
export const assessPageVisually = weave.op(
  async function assessPageVisually(
    screenshotBase64: string | null,
    domSummary: string,
    profile: SiteProfile,
    config: AgentConfig
  ): Promise<VisualAssessment> {
    // Vision requires gpt-4o (not Cerebras) — use OpenAI directly for this call
    const visionClient = screenshotBase64
      ? (() => {
          const base = new OpenAI({ apiKey: config.openaiApiKey });
          try { return weave.wrapOpenAI(base); } catch { return base; }
        })()
      : getOpenAIClient(config);

    const expectedElements = profile.expectedElements
      .map((e) => `- ${e.description}`)
      .join("\n");

    const userPrompt = `Evaluate this page state:

Site: ${profile.name}
Expected elements:
${expectedElements || "- (none specified — use general web page expectations)"}

Page DOM summary:
${domSummary.slice(0, 3000)}

Respond with JSON:
{
  "pageAppearsFunctional": true/false,
  "issuesFound": ["list of issues"],
  "overallScore": 0.0-1.0,
  "details": "Brief assessment"
}`;

    // Build message content — include screenshot if available
    const userContent: any[] = [];

    if (screenshotBase64) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${screenshotBase64}`,
          detail: "low", // low detail keeps tokens reasonable
        },
      });
      userContent.push({
        type: "text",
        text: userPrompt,
      });
    } else {
      userContent.push({
        type: "text",
        text: userPrompt,
      });
    }

    const response = await visionClient.chat.completions.create({
      model: screenshotBase64 ? "gpt-4o" : getModel(config),
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a visual QA agent evaluating whether a web page appears functional.
You check for visual integrity, layout issues, and missing elements.${screenshotBase64 ? " You have been given a screenshot of the page — analyze it carefully for overlays, obscured elements, blank regions, or anything visually wrong." : ""} Respond with JSON.`,
        },
        {
          role: "user",
          content: userContent,
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
);

// ── Post-Mortem Summary ──────────────────────────────────────────────

/**
 * Generates an LLM post-mortem summary of an incident.
 * Traced as a Weave op — appears as "generatePostMortem" in the trace tree.
 */
export const generatePostMortem = weave.op(
  async function generatePostMortem(
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
          content:
            "Write concise post-mortem summaries for SRE incidents. One paragraph, focus on: what happened, root cause, how it was fixed, and what to watch for next time.",
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
);

// ── Embedding Generation ─────────────────────────────────────────────

/**
 * Generates a vector embedding for semantic memory search.
 * Uses text-embedding-3-small (always OpenAI, not Cerebras).
 * Traced via Weave's wrapOpenAI.
 */
export const generateEmbedding = weave.op(
  async function generateEmbedding(
    text: string,
    config: AgentConfig
  ): Promise<number[]> {
    const openai = getEmbeddingClient(config);

    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });

    return response.data[0].embedding;
  }
);
