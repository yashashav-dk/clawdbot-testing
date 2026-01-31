/**
 * Core types for the SRE Dreamer agent.
 */

export interface Incident {
  id: string;
  timestamp: string;
  type: IncidentType;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  url: string;
  domSnapshot?: string;
  errorMessage?: string;
  blockingElement?: string;
}

export type IncidentType =
  | "visual_occlusion"
  | "element_unclickable"
  | "layout_shift"
  | "content_missing"
  | "unknown";

export interface DreamStrategy {
  name: string;
  description: string;
  execute: (context: DreamContext) => Promise<DreamResult>;
}

export interface DreamContext {
  incident: Incident;
  targetUrl: string;
  pastIncidents: IncidentMemory[];
}

export interface DreamResult {
  strategy: string;
  success: boolean;
  score: number;
  sessionUrl?: string;
  detail: string;
  durationMs: number;
  sideEffects: string[];
}

export interface IncidentMemory {
  incidentId: string;
  timestamp: string;
  type: IncidentType;
  description: string;
  resolution: string;
  strategyUsed: string;
  score: number;
  embedding?: number[];
}

export interface HealthCheckResult {
  healthy: boolean;
  url: string;
  httpStatus?: number;
  visualCheck: VisualCheckResult;
  timestamp: string;
}

export interface VisualCheckResult {
  loginClickable: boolean;
  pageLoaded: boolean;
  occlusionDetected: boolean;
  blockingElementSelector?: string;
  errorMessage?: string;
}

export interface AgentConfig {
  targetUrl: string;
  browserbaseApiKey: string;
  browserbaseProjectId: string;
  vercelToken: string;
  vercelProjectId: string;
  vercelTeamId?: string;
  vercelGoodDeploymentId: string;
  redisUrl: string;
  openaiApiKey: string;
  weaveProject: string;
  cerebrasApiKey?: string;
}
