import Redis from "ioredis";
import type { IncidentMemory, Incident, AgentConfig } from "../types/index.js";

/**
 * The Memory Layer.
 *
 * Redis-backed storage for incident history and learned remediation strategies.
 * Implements:
 * - Short-term context (active incident thread)
 * - Long-term knowledge (past incident memories)
 * - Vector embeddings for semantic similarity search (self-improving)
 */

const MEMORY_PREFIX = "sre:memory:";
const THREAD_PREFIX = "sre:thread:";
const MEMORY_INDEX = "sre:memories";
const EMBEDDING_PREFIX = "sre:embedding:";

export class IncidentMemoryStore {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  // === Short-term context: Active incident thread ===

  async startThread(incidentId: string, incident: Incident): Promise<void> {
    const key = `${THREAD_PREFIX}${incidentId}`;
    await this.redis.hset(key, {
      incident: JSON.stringify(incident),
      startedAt: new Date().toISOString(),
      status: "active",
      attempts: "0",
    });
    await this.redis.expire(key, 3600);
  }

  async logThreadStep(
    incidentId: string,
    step: string,
    data: Record<string, any>
  ): Promise<void> {
    const key = `${THREAD_PREFIX}${incidentId}:steps`;
    await this.redis.rpush(
      key,
      JSON.stringify({
        step,
        timestamp: new Date().toISOString(),
        ...data,
      })
    );
    await this.redis.expire(key, 3600);
  }

  async getThreadSteps(incidentId: string): Promise<any[]> {
    const key = `${THREAD_PREFIX}${incidentId}:steps`;
    const steps = await this.redis.lrange(key, 0, -1);
    return steps.map((s) => JSON.parse(s));
  }

  async incrementAttempts(incidentId: string): Promise<number> {
    const key = `${THREAD_PREFIX}${incidentId}`;
    return this.redis.hincrby(key, "attempts", 1);
  }

  async hasTriedStrategy(
    incidentId: string,
    strategyName: string
  ): Promise<boolean> {
    const steps = await this.getThreadSteps(incidentId);
    return steps.some(
      (s) => s.step === "dream_executed" && s.strategy === strategyName
    );
  }

  // === Long-term knowledge: Incident memories ===

  async storeMemory(
    memory: IncidentMemory,
    embedding?: number[]
  ): Promise<void> {
    const key = `${MEMORY_PREFIX}${memory.incidentId}`;
    await this.redis.hset(key, {
      data: JSON.stringify(memory),
      type: memory.type,
      score: String(memory.score),
      timestamp: memory.timestamp,
    });

    // Store embedding separately if provided
    if (embedding && embedding.length > 0) {
      await this.redis.set(
        `${EMBEDDING_PREFIX}${memory.incidentId}`,
        JSON.stringify(embedding)
      );
      memory.embedding = embedding;
    }

    await this.redis.zadd(
      MEMORY_INDEX,
      Date.parse(memory.timestamp),
      memory.incidentId
    );
  }

  async getRecentMemories(limit = 10): Promise<IncidentMemory[]> {
    const ids = await this.redis.zrevrange(MEMORY_INDEX, 0, limit - 1);
    if (ids.length === 0) return [];

    const memories: IncidentMemory[] = [];
    for (const id of ids) {
      const raw = await this.redis.hget(`${MEMORY_PREFIX}${id}`, "data");
      if (raw) {
        memories.push(JSON.parse(raw));
      }
    }
    return memories;
  }

  /**
   * Find similar incidents using vector cosine similarity.
   * Falls back to type-based matching if embeddings aren't available.
   */
  async findSimilarIncidents(
    type: string,
    queryEmbedding?: number[],
    limit = 5
  ): Promise<IncidentMemory[]> {
    const allIds = await this.redis.zrevrange(MEMORY_INDEX, 0, 50);

    if (queryEmbedding && queryEmbedding.length > 0) {
      // Vector similarity search
      const scored: Array<{ memory: IncidentMemory; similarity: number }> = [];

      for (const id of allIds) {
        const [memoryData, embeddingData] = await Promise.all([
          this.redis.hget(`${MEMORY_PREFIX}${id}`, "data"),
          this.redis.get(`${EMBEDDING_PREFIX}${id}`),
        ]);

        if (!memoryData) continue;

        const memory: IncidentMemory = JSON.parse(memoryData);

        if (embeddingData) {
          const storedEmbedding: number[] = JSON.parse(embeddingData);
          const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);
          scored.push({ memory, similarity });
        } else {
          // No embedding — give partial score if type matches
          scored.push({
            memory,
            similarity: memory.type === type ? 0.5 : 0.1,
          });
        }
      }

      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, limit).map((s) => s.memory);
    }

    // Fallback: type-based matching
    const matches: IncidentMemory[] = [];
    for (const id of allIds) {
      const entry = await this.redis.hgetall(`${MEMORY_PREFIX}${id}`);
      if (entry.type === type && entry.data) {
        matches.push(JSON.parse(entry.data));
        if (matches.length >= limit) break;
      }
    }

    return matches;
  }

  async getMemoryCount(): Promise<number> {
    return this.redis.zcard(MEMORY_INDEX);
  }

  async getMemoryStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    withEmbeddings: number;
  }> {
    const allIds = await this.redis.zrevrange(MEMORY_INDEX, 0, -1);
    const byType: Record<string, number> = {};
    let withEmbeddings = 0;

    for (const id of allIds) {
      const entry = await this.redis.hgetall(`${MEMORY_PREFIX}${id}`);
      if (entry.type) {
        byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      }
      const hasEmbed = await this.redis.exists(`${EMBEDDING_PREFIX}${id}`);
      if (hasEmbed) withEmbeddings++;
    }

    return { total: allIds.length, byType, withEmbeddings };
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }
}

/**
 * Cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
