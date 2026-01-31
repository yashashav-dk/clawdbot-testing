import Redis from "ioredis";
import type { IncidentMemory, Incident } from "../types/index.js";

/**
 * The Memory Layer.
 *
 * Redis-backed storage for incident history and learned remediation strategies.
 * Implements both short-term context (active incident thread) and long-term
 * knowledge (past incident memories for retrieval).
 */

const INCIDENT_PREFIX = "sre:incident:";
const MEMORY_PREFIX = "sre:memory:";
const THREAD_PREFIX = "sre:thread:";
const MEMORY_INDEX = "sre:memories";

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
    // Auto-expire threads after 1 hour
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

  async storeMemory(memory: IncidentMemory): Promise<void> {
    const key = `${MEMORY_PREFIX}${memory.incidentId}`;
    await this.redis.hset(key, {
      data: JSON.stringify(memory),
      type: memory.type,
      score: String(memory.score),
      timestamp: memory.timestamp,
    });
    // Add to the sorted set for retrieval, scored by recency
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

  async findSimilarIncidents(
    type: string,
    limit = 5
  ): Promise<IncidentMemory[]> {
    // Simple type-based retrieval. In production, this would use
    // RedisVL vector similarity search with embeddings.
    const allIds = await this.redis.zrevrange(MEMORY_INDEX, 0, 50);
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

  // === Utility ===

  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }
}
