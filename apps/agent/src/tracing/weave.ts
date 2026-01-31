import * as weave from "weave";
import OpenAI from "openai";
import type { AgentConfig } from "../types/index.js";

/**
 * Weave Tracing Layer.
 *
 * Initializes W&B Weave and provides traced (instrumented) versions of
 * all core agent functions. Every traced function appears in the Weave
 * Trace Tree UI with inputs, outputs, latency, and token usage.
 *
 * Usage:
 *   const { traced, openai } = await initWeave(config);
 *   // Then use traced.* instead of direct function calls
 */

let _initialized = false;
let _wrappedOpenAI: OpenAI | null = null;

export async function initWeave(config: AgentConfig): Promise<void> {
  if (_initialized) return;

  await weave.init(config.weaveProject);
  _initialized = true;

  console.log(`[WEAVE] Initialized project: ${config.weaveProject}`);
}

/**
 * Returns an OpenAI client wrapped with Weave's automatic LLM call tracking.
 * All chat completions and embedding calls are traced automatically.
 */
export function getTracedOpenAI(config: AgentConfig): OpenAI {
  if (_wrappedOpenAI) return _wrappedOpenAI;

  const baseClient = config.cerebrasApiKey
    ? new OpenAI({
        apiKey: config.cerebrasApiKey,
        baseURL: "https://api.cerebras.ai/v1",
      })
    : new OpenAI({ apiKey: config.openaiApiKey });

  _wrappedOpenAI = weave.wrapOpenAI(baseClient);
  return _wrappedOpenAI;
}

/**
 * Returns an OpenAI client for embeddings (always OpenAI, not Cerebras).
 * Wrapped with Weave tracing.
 */
export function getTracedEmbeddingClient(config: AgentConfig): OpenAI {
  return weave.wrapOpenAI(new OpenAI({ apiKey: config.openaiApiKey }));
}

// ── Traced Operations ────────────────────────────────────────────────
// Each weave.op() call creates a traced span in the Weave Trace Tree.
// Naming convention: descriptive function names become span labels.

/**
 * Wraps an async function as a Weave-traced operation.
 * The function name becomes the span name in the trace tree.
 */
export function traceOp<T extends (...args: any[]) => any>(fn: T): T {
  if (!_initialized) return fn;
  return weave.op(fn) as T;
}

// ── Evaluation Framework ─────────────────────────────────────────────

export interface WeaveScoreResult {
  reachability: number;
  visualIntegrity: number;
  safety: number;
  latency: number;
  aggregate: number;
}

/**
 * Creates a Weave Evaluation for scoring dream results.
 * This shows up as a formal evaluation in the Weave dashboard.
 */
export async function runWeaveEvaluation(
  dreamResults: Array<{
    strategy: string;
    scores: WeaveScoreResult;
  }>
): Promise<void> {
  if (!_initialized) return;

  try {
    const dataset = new weave.Dataset({
      id: "dream-strategies",
      rows: dreamResults.map((d) => ({
        strategy: d.strategy,
        expected_success: true,
      })),
    });

    const reachabilityScorer = weave.op(
      function scoreReachability(args: {
        modelOutput: WeaveScoreResult;
      }): { reachability: number } {
        return { reachability: args.modelOutput.reachability };
      }
    );

    const safetyScorer = weave.op(
      function scoreSafety(args: {
        modelOutput: WeaveScoreResult;
      }): { safety: number } {
        return { safety: args.modelOutput.safety };
      }
    );

    const aggregateScorer = weave.op(
      function scoreAggregate(args: {
        modelOutput: WeaveScoreResult;
      }): { aggregate: number } {
        return { aggregate: args.modelOutput.aggregate };
      }
    );

    const evaluation = new weave.Evaluation({
      dataset,
      scorers: [reachabilityScorer, safetyScorer, aggregateScorer],
    });

    const model = weave.op(async function dreamModel(args: {
      strategy: string;
    }): Promise<WeaveScoreResult> {
      const result = dreamResults.find((d) => d.strategy === args.strategy);
      return result?.scores ?? {
        reachability: 0,
        visualIntegrity: 0,
        safety: 0,
        latency: 0,
        aggregate: 0,
      };
    });

    await evaluation.evaluate({ model });
    console.log("[WEAVE] Evaluation logged to dashboard");
  } catch (err) {
    console.warn("[WEAVE] Evaluation logging failed:", err);
  }
}
