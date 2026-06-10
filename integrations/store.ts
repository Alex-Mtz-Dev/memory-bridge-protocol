import { join, dirname } from "node:path";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface MemoryBridgeBaseRequest {
  project_id?: string;
  chatbot?: string;
  thread_id?: string;
}

export interface MemoryBridgeGetRequest extends MemoryBridgeBaseRequest {
  op: "get";
  task?: string;
  topics?: string[];
  limit?: number;
  include_system_events?: boolean;
}

export type MemoryBridgeActorTrustClass = "user" | "system" | "claude";

/** Origin of the input that produced this belief â€” critical for echo chamber detection. */
export type MemoryBridgeInputOrigin = "human" | "ai" | "unknown";

export type MemoryBridgeFactStatus =
  | "observed"
  | "asserted"
  | "contested"
  | "refuted"
  | "reported"
  | "self_state"
  | "inferred"
  | "hypothesis"
  | "verified"
  | "rejected";

export type MemoryBridgeLoopState = "open" | "resolved" | "refuted" | "superseded";

export interface MemoryBridgeSelfStateInput {
  active_mode?: string;
  confidence?: number;
  active_tension?: string;
  last_revision?: string;
}

export interface MemoryBridgeSelfState {
  active_mode: string;
  confidence: number;
  active_tension: string;
  last_revision: string;
  updated_at: string;
}

export interface MemoryBridgePolicyRevisionInput {
  revision_id?: string;
  summary?: string;
  policy_patch?: string[];
  tension_version?: string;
}

export interface MemoryBridgePolicyRevision {
  revision_id: string;
  timestamp: string;
  summary: string;
  policy_patch: string[];
  tension_version?: string;
  caused_by_event_id?: string;
  previous_revision?: string;
}

/** Max confidence allowed per actor trust class (synthesis: Claude=0.75, Codex=0.40 â†’ use 0.40 as more conservative) */
export const ACTOR_CONFIDENCE_CEILING: Record<MemoryBridgeActorTrustClass, number> = {
  user: 1.0,
  system: 1.0,
  claude: 0.40,
};

export interface MemoryBridgePutRequest extends MemoryBridgeBaseRequest {
  op: "put";
  summary?: string;
  facts?: string[];
  decisions?: string[];
  open_loops?: string[];
  loop_state?: MemoryBridgeLoopState;
  resolved_by?: string;
  artifacts?: string[];
  confidence?: number;
  ttl_days?: number;
  refuted_by?: string[];
  source_trust?: number;
  task?: string;
  actor?: string;
  /** Structured trust class for actor â€” drives confidence ceiling and precedence. */
  actor_trust_class?: MemoryBridgeActorTrustClass;
  /** Epistemic status of these beliefs. claude-authored defaults to 'inferred'. */
  fact_status?: MemoryBridgeFactStatus;
  /** IDs of beliefs this entry was derived from â€” used for circular support detection. */
  derived_from?: string[];
  /** Origin of the input that produced this belief (human | ai | unknown). Drives echo chamber detection. */
  input_origin?: MemoryBridgeInputOrigin;
  /** Explicit session-continuity self-state persisted as first-class project state. */
  self_state?: MemoryBridgeSelfStateInput;
  /** Causal policy revision written by reflective passes and linked to triggering event IDs. */
  policy_revision?: MemoryBridgePolicyRevisionInput;
}

export interface MemoryBridgeCompactRequest extends MemoryBridgeBaseRequest {
  op: "compact";
}

export interface MemoryBridgeVersionedRequest {
  schema_version?: string;
  op: "get" | "put" | "compact";
  project_id?: string;
  chatbot?: string;
  thread_id?: string;
  task?: string;
  topics?: string[];
  limit?: number;
  include_system_events?: boolean;
  summary?: string;
  facts?: string[];
  decisions?: string[];
  open_loops?: string[];
  loop_state?: MemoryBridgeLoopState;
  resolved_by?: string;
  artifacts?: string[];
  confidence?: number;
  ttl_days?: number;
  refuted_by?: string[];
  source_trust?: number;
  actor?: string;
  actor_trust_class?: MemoryBridgeActorTrustClass;
  fact_status?: MemoryBridgeFactStatus;
  derived_from?: string[];
  input_origin?: MemoryBridgeInputOrigin;
  self_state?: MemoryBridgeSelfStateInput;
  policy_revision?: MemoryBridgePolicyRevisionInput;
}

export type MemoryBridgeRequest =
  | MemoryBridgeGetRequest
  | MemoryBridgePutRequest
  | MemoryBridgeCompactRequest;

export type MemoryBridgeCompatibilityMode = "legacy-request" | "versioned-request";

export interface NormalizedMemoryBridgeRequest {
  request: MemoryBridgeRequest;
  compatibility_mode: MemoryBridgeCompatibilityMode;
}

export interface MemoryBridgeEvent {
  event_id?: string;
  timestamp: string;
  project_id: string;
  chatbot: string;
  thread_id: string;
  task: string;
  summary: string;
  facts: string[];
  decisions: string[];
  open_loops: string[];
  loop_state?: MemoryBridgeLoopState;
  resolved_by?: string;
  artifacts: string[];
  confidence: number | null;
  ttl_days: number | null;
  refuted_by: string[];
  source_trust: number | null;
  actor?: string;
  /** Trust class of the actor â€” determines confidence ceiling and precedence. */
  actor_trust_class?: MemoryBridgeActorTrustClass;
  /** Epistemic status of the beliefs in this event. */
  fact_status?: MemoryBridgeFactStatus;
  /** Belief IDs this event was derived from (circular support detection). */
  derived_from?: string[];
  /** Origin of the input: human | ai | unknown. Auto-set from actor_trust_class if not provided. */
  input_origin?: MemoryBridgeInputOrigin;
  /** Optional introspective self snapshot attached to the cognitive output event. */
  self_state?: MemoryBridgeSelfState;
  /** Optional policy revision metadata emitted by reflective write-paths. */
  policy_revision?: MemoryBridgePolicyRevision;
  /** ISO timestamp set when this event was archived during a compact pass. Events with this field are dead and should be filtered from reads. */
  compacted_into?: string;
  /** ISO timestamp set when this event's beliefs were fully swept by the immune system (apoptosis executed). */
  swept_at?: string;
}

export type MemoryBridgeBeliefCellType =
  | "fact"
  | "decision"
  | "open_loop"
  | "artifact";

export type MemoryBridgeBeliefStatus = "active" | "contested" | "refuted";

export type MemoryBridgeImmuneApoptosisReason =
  | "ttl_expired"
  | "confidence_low"
  | "refutation_dominant";

export interface MemoryBridgeImmuneAnnotation {
  last_swept_at: string | null;
  ttl_expired: boolean;
  confidence_below_threshold: boolean;
  refutation_dominant: boolean;
  apoptosis_candidate: boolean;
  apoptosis_reason: MemoryBridgeImmuneApoptosisReason | null;
  apoptosis_eligible_after: string | null;
}

export interface MemoryBridgeBelief {
  belief_id: string;
  cell_type: MemoryBridgeBeliefCellType;
  text: string;
  status: MemoryBridgeBeliefStatus;
  loop_state?: MemoryBridgeLoopState;
  resolved_by_event_id?: string | null;
  score: number;
  support_count: number;
  refutation_count: number;
  first_seen_at: string;
  last_seen_at: string;
  last_compacted_at: string | null;
  ttl_days: number | null;
  supporting_events: string[];
  refuting_events: string[];
  /** Confidence from the most recent supporting event. Used by Immune scoring. */
  confidence?: number | null;
  /** Source trust from the most recent supporting event. */
  source_trust?: number | null;
  /** Trust class of the most recent author. Drives precedence and ceiling enforcement. */
  actor_trust_class?: MemoryBridgeActorTrustClass;
  /** Epistemic status of the most recent supporting event. */
  fact_status?: MemoryBridgeFactStatus;
  immune?: MemoryBridgeImmuneAnnotation;
}

export interface MemoryBridgeBeliefIndex {
  schema_version: string;
  updated_at: string;
  beliefs: Record<string, MemoryBridgeBelief>;
}

export type MemoryBridgeBeliefDeltaType = "new" | "reinforced" | "reopened";

export interface MemoryBridgeBeliefDelta {
  timestamp: string;
  project_id: string;
  belief_id: string;
  cell_type: MemoryBridgeBeliefCellType;
  delta_type: MemoryBridgeBeliefDeltaType;
  previous_score: number | null;
  next_score: number;
  cause: {
    event_id: string;
    reason: "first_observation" | "additional_support" | "immune_cleared";
  };
}

export interface MemoryBridgeMetabolicState {
  schema_version: string;
  project_id: string;
  last_event_cursor: number;
  last_task_detection_cursor: number;
  last_incremental_at: string | null;
  last_compaction_at: string | null;
  last_rebuild_at: string | null;
  archived_events: number;
  hot_events: number;
}

export interface MemoryBridgeMetabolicRunResult {
  ok: true;
  op: "metabolic";
  mode: "incremental";
  project_id: string;
  events_scanned: number;
  deltas_emitted: number;
  beliefs_active: number;
  beliefs_contested: number;
  cursor_before: number;
  cursor_after: number;
  tasks_detected: number;
}

/** A pending task extracted from a task event by the metabolic loop. */
export interface MemoryBridgePendingTask {
  correlation_id: string;
  task_type: string;
  event_id: string;
  detected_at: string;
  actor_trust_class: MemoryBridgeActorTrustClass | undefined;
  fact_status: MemoryBridgeFactStatus | undefined;
  confidence: number | null;
  caller_agent: string | null;
  raw_task_fact: string;
  // Neural Bus extension fields (set only on direct memory_invoke tasks)
  target_capability?: string;
  skill?: string;
  input?: string;
  priority?: number;
  ttl_hours?: number;
  expires_at?: string;
  created_by?: string;
  metadata?: Record<string, unknown>;
  original_target_capability?: string;
  routing_annotation?: string;
}

export interface MemoryBridgeImmuneState {
  schema_version: string;
  project_id: string;
  last_belief_cursor: number;
  last_sweep_at: string | null;
  last_full_sweep_at: string | null;
  candidates_marked: number;
  candidates_cleared: number;
  apoptosis_events_pending: number;
}

export interface MemoryBridgeImmuneRunResult {
  ok: true;
  op: "immune";
  mode: "sweep";
  project_id: string;
  beliefs_scanned: number;
  candidates_marked: number;
  candidates_cleared: number;
  reopened_deltas_emitted: number;
  cursor_before: number;
  cursor_after: number;
}

export interface MemoryBridgeImmuneFullSweepRunResult {
  ok: true;
  op: "immune";
  mode: "full-sweep";
  project_id: string;
  beliefs_scanned: number;
  candidates_marked: number;
  candidates_cleared: number;
  reopened_deltas_emitted: number;
  events_swept: number;
}

export interface MemoryBridgeSummary {
  facts: string[];
  decisions: string[];
  open_loops: string[];
  artifacts: string[];
  updated_at: string;
  last_summary: string;
}

export interface MemoryBridgeThreadState {
  chatbot: string;
  thread_id: string;
  project_id: string;
  updated_at: string;
  last_task: string;
  last_summary: string;
  open_loops: string[];
}

export interface MemoryBridgeGetResponse {
  ok: true;
  op: "get";
  project_id: string;
  chatbot: string;
  thread_id: string;
  memory: {
    summary: MemoryBridgeSummary;
    thread: MemoryBridgeThreadState;
    relevant_events: MemoryBridgeEvent[];
  };
}

export interface MemoryBridgePutResponse {
  ok: true;
  op: "put";
  project_id: string;
  chatbot: string;
  thread_id: string;
  stored: {
    summary_path: string;
    thread_path: string;
    events_path: string;
    event_count: number;
  };
}

export interface MemoryBridgeCompactResponse {
  ok: true;
  op: "compact";
  project_id: string;
  chatbot: string;
  thread_id: string;
  compacted: {
    events_path: string;
    summary_path: string;
    event_count: number;
  };
}

export type MemoryBridgeResponse =
  | MemoryBridgeGetResponse
  | MemoryBridgePutResponse
  | MemoryBridgeCompactResponse;

export interface MemoryBridgeSuccessEnvelope {
  schema_version: string;
  timestamp: string;
  ok: true;
  operation: MemoryBridgeRequest["op"];
  data: MemoryBridgeResponse;
  meta?: {
    compatibility_mode?: MemoryBridgeCompatibilityMode | "legacy-response" | "versioned-response" | "cli";
  };
}

export interface MemoryBridgeErrorEnvelope {
  schema_version: string;
  timestamp: string;
  ok: false;
  operation: MemoryBridgeRequest["op"] | "unknown";
  error: {
    code: string;
    message: string;
    supported_schema_versions?: string[];
    details?: Record<string, unknown>;
  };
}

export const MEMORY_BRIDGE_SCHEMA_VERSION = "1.0";
export const SUPPORTED_MEMORY_BRIDGE_SCHEMA_VERSIONS = [
  MEMORY_BRIDGE_SCHEMA_VERSION,
] as const;

const DEFAULT_PROJECT_ID = "default";
const DEFAULT_CHATBOT = "claude";
const DEFAULT_THREAD_ID = "default";
const DEFAULT_LIMIT = 8;
const DEFAULT_BELIEF_CONFIDENCE = 0.6;
const DEFAULT_SOURCE_TRUST = 0.5;

/** Default confidence to store per actor trust class when LLM omits it. */
const DEFAULT_CONFIDENCE_BY_TRUST_CLASS: Record<MemoryBridgeActorTrustClass, number> = {
  user: 0.80,
  system: 0.70,
  claude: 0.35,
};

/** Default source_trust to store per actor trust class when LLM omits it. */
const DEFAULT_SOURCE_TRUST_BY_TRUST_CLASS: Record<MemoryBridgeActorTrustClass, number> = {
  user: 0.90,
  system: 0.80,
  claude: 0.60,
};

/**
 * Default TTL in days per fact_status.
 * - verified: permanent (null = no expiry)
 * - observed: 180d â€” direct observation, stable but may be superseded
 * - asserted: 120d â€” durable claim pending broader corroboration
 * - contested: 21d â€” active disagreement, keep short-lived for reconciliation
 * - refuted: 14d â€” disproven, retain briefly as audit trail
 * - reported: 60d â€” external report, medium decay
 * - self_state: 45d â€” reflective internal state snapshot, useful but perishable
 * - inferred: 90d â€” derived belief, may drift
 * - hypothesis: 30d â€” speculative, high decay
 * - rejected: 14d â€” audit trail only, short retention
 */
const DEFAULT_TTL_DAYS_BY_FACT_STATUS: Record<MemoryBridgeFactStatus, number | null> = {
  verified: null,   // permanent â€” highest confidence status
  observed: 180,
  asserted: 120,
  contested: 21,
  refuted: 14,
  reported: 60,
  self_state: 45,
  inferred: 90,
  hypothesis: 30,
  rejected: 14,
};

/** Fallback TTL by actor trust class when fact_status is unknown. */
const DEFAULT_TTL_DAYS_BY_TRUST_CLASS: Record<MemoryBridgeActorTrustClass, number> = {
  user: 180,
  system: 90,
  claude: 30,
};
const BELIEF_ACTIVE_THRESHOLD = 0.65;
const BELIEF_REFUTED_THRESHOLD = 0.4;
const IMMUNE_APOPTOSIS_FLOOR = 0.3;
const IMMUNE_GRACE_DAYS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryBridgeOperation(value: unknown): value is MemoryBridgeRequest["op"] {
  return value === "get" || value === "put" || value === "compact";
}

function validateSchemaVersion(schemaVersion: string | undefined): void {
  const normalized = schemaVersion?.trim();
  if (!normalized) return;
  if (SUPPORTED_MEMORY_BRIDGE_SCHEMA_VERSIONS.some((version) => version === normalized)) return;
  throw new Error(
    `Unsupported Memory Bridge schema_version: ${normalized}. Supported versions: ${SUPPORTED_MEMORY_BRIDGE_SCHEMA_VERSIONS.join(", ")}`,
  );
}

export function normalizeMemoryBridgeRequest(
  input: unknown,
  expectedOperation?: MemoryBridgeRequest["op"],
): NormalizedMemoryBridgeRequest {
  if (!isRecord(input)) {
    throw new Error("Memory Bridge request must be a JSON object.");
  }

  const operation = input.op;
  if (!isMemoryBridgeOperation(operation)) {
    throw new Error("Memory Bridge request must include op=get|put|compact.");
  }
  if (expectedOperation && operation !== expectedOperation) {
    throw new Error(
      `Memory Bridge request op=${operation} does not match subcommand ${expectedOperation}.`,
    );
  }

  const schemaVersion =
    typeof input.schema_version === "string" ? input.schema_version : undefined;
  validateSchemaVersion(schemaVersion);
  const { schema_version: _schemaVersion, ...requestPayload } = input;

  return {
    request: { ...requestPayload, op: operation } as unknown as MemoryBridgeRequest,
    compatibility_mode: schemaVersion ? "versioned-request" : "legacy-request",
  };
}

export function buildMemoryBridgeSuccessEnvelope(
  response: MemoryBridgeResponse,
  meta?: MemoryBridgeSuccessEnvelope["meta"],
): MemoryBridgeSuccessEnvelope {
  return {
    schema_version: MEMORY_BRIDGE_SCHEMA_VERSION,
    timestamp: nowIso(),
    ok: true,
    operation: response.op,
    data: response,
    ...(meta ? { meta } : {}),
  };
}

export function buildMemoryBridgeErrorEnvelope(
  code: string,
  message: string,
  options: {
    operation?: MemoryBridgeErrorEnvelope["operation"];
    details?: Record<string, unknown>;
  } = {},
): MemoryBridgeErrorEnvelope {
  return {
    schema_version: MEMORY_BRIDGE_SCHEMA_VERSION,
    timestamp: nowIso(),
    ok: false,
    operation: options.operation ?? "unknown",
    error: {
      code,
      message,
      supported_schema_versions: [...SUPPORTED_MEMORY_BRIDGE_SCHEMA_VERSIONS],
      ...(options.details ? { details: options.details } : {}),
    },
  };
}

export function resolveMemoryBridgeRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.AIK_MEMORY_BRIDGE_HOME?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) {
    throw new Error("Unable to resolve home directory for memory bridge store.");
  }
  return join(home, ".aik", "memory-bridge");
}

function normalizeId(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const normalized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizeLoopState(value: unknown): MemoryBridgeLoopState | undefined {
  return value === "open" || value === "resolved" || value === "refuted" || value === "superseded"
    ? value
    : undefined;
}

function uniqueStrings(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values ?? []) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function mergeUnique(...groups: Array<string[] | undefined>): string[] {
  return uniqueStrings(groups.flatMap((group) => group ?? []));
}

function normalizeProbability(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(value, 1));
}

function normalizeTtlDays(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const days = Math.floor(value);
  return days > 0 ? days : null;
}

function normalizeSelfState(
  input: MemoryBridgeSelfStateInput | undefined,
  options: {
    timestamp: string;
    fallbackConfidence: number;
    confidenceCeiling: number;
    fallbackLastRevision?: string;
  },
): MemoryBridgeSelfState | undefined {
  if (!input) return undefined;
  const activeMode = normalizeText(input.active_mode) || "default";
  const activeTension = normalizeText(input.active_tension) || "thoroughness|efficiency:0.50";
  const lastRevision = normalizeText(input.last_revision) || options.fallbackLastRevision || "none";
  const confidenceRaw = normalizeProbability(input.confidence);
  const confidence = confidenceRaw !== null
    ? Math.min(confidenceRaw, options.confidenceCeiling)
    : options.fallbackConfidence;
  return {
    active_mode: activeMode,
    confidence,
    active_tension: activeTension,
    last_revision: lastRevision,
    updated_at: options.timestamp,
  };
}

function normalizePolicyRevision(
  input: MemoryBridgePolicyRevisionInput | undefined,
  timestamp: string,
  previousRevision?: string,
): MemoryBridgePolicyRevision | undefined {
  if (!input) return undefined;
  const summary = normalizeText(input.summary);
  const policyPatch = uniqueStrings(input.policy_patch);
  if (!summary && policyPatch.length === 0) return undefined;
  const revisionId = normalizeText(input.revision_id) || randomUUID();
  const tensionVersion = normalizeText(input.tension_version);
  return {
    revision_id: revisionId,
    timestamp,
    summary,
    policy_patch: policyPatch,
    ...(tensionVersion ? { tension_version: tensionVersion } : {}),
    ...(previousRevision ? { previous_revision: previousRevision } : {}),
  };
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(value, 1));
}

function nowIso(): string {
  return new Date().toISOString();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendJsonLines(path: string, values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  await appendFile(
    path,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    "utf8",
  );
}

async function writeJsonLines(path: string, values: unknown[]): Promise<void> {
  const payload = values.map((value) => JSON.stringify(value)).join("\n");
  await writeFile(path, payload.length > 0 ? `${payload}\n` : "", "utf8");
}

async function acquireProjectLock(lockPath: string): Promise<boolean> {
  const STALE_THRESHOLD_MS = 30 * 60 * 1000;
  try {
    const raw = await readFile(lockPath, "utf8");
    const lock = JSON.parse(raw) as { pid: number; started_at: string };
    const ageMs = Date.now() - new Date(lock.started_at).getTime();
    if (ageMs < STALE_THRESHOLD_MS) return false;
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch {
      // PID gone â€” break stale lock
    }
  } catch {
    // No lock file exists
  }
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, started_at: nowIso() }), "utf8");
  return true;
}

async function releaseProjectLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // Ignore if already gone
  }
}

async function readEvents(path: string): Promise<MemoryBridgeEvent[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MemoryBridgeEvent);
  } catch {
    return [];
  }
}

async function readLatestJsonLine<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]!) as T;
  } catch {
    return null;
  }
}

async function appendEvent(path: string, event: MemoryBridgeEvent): Promise<number> {
  const events = await readEvents(path);
  events.push(event);
  const payload = events.map((item) => JSON.stringify(item)).join("\n");
  await writeFile(path, payload.length > 0 ? `${payload}\n` : "", "utf8");
  return events.length;
}

async function appendSweepCompletionTelemetry(
  eventsPath: string,
  options: {
    projectId: string;
    op: "metabolic" | "immune";
    mode: "incremental" | "sweep" | "full-sweep";
    summary: string;
    facts: string[];
    decisions?: string[];
    artifacts?: string[];
  },
): Promise<void> {
  const event: MemoryBridgeEvent = {
    timestamp: nowIso(),
    project_id: options.projectId,
    chatbot: "system",
    thread_id: "sweep-telemetry",
    task: `${options.op}:${options.mode}:completion`,
    summary: options.summary,
    facts: uniqueStrings(options.facts),
    decisions: uniqueStrings(options.decisions ?? []),
    open_loops: [],
    artifacts: uniqueStrings(options.artifacts ?? []),
    confidence: 0.99,
    ttl_days: 30,
    refuted_by: [],
    source_trust: 1,
    actor: "system",
    actor_trust_class: "system",
    fact_status: "observed",
    input_origin: "unknown",
  };

  await appendEvent(eventsPath, event);
}

function buildEmptyBeliefIndex(updatedAt = nowIso()): MemoryBridgeBeliefIndex {
  return {
    schema_version: MEMORY_BRIDGE_SCHEMA_VERSION,
    updated_at: updatedAt,
    beliefs: {},
  };
}

function buildEmptyMetabolicState(projectId: string): MemoryBridgeMetabolicState {
  return {
    schema_version: MEMORY_BRIDGE_SCHEMA_VERSION,
    project_id: projectId,
    last_event_cursor: 0,
    last_task_detection_cursor: 0,
    last_incremental_at: null,
    last_compaction_at: null,
    last_rebuild_at: null,
    archived_events: 0,
    hot_events: 0,
  };
}

function buildEmptyImmuneState(projectId: string): MemoryBridgeImmuneState {
  return {
    schema_version: MEMORY_BRIDGE_SCHEMA_VERSION,
    project_id: projectId,
    last_belief_cursor: 0,
    last_sweep_at: null,
    last_full_sweep_at: null,
    candidates_marked: 0,
    candidates_cleared: 0,
    apoptosis_events_pending: 0,
  };
}

function normalizeBeliefSlug(text: string): string {
  const normalized = normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "empty";
}

function buildBeliefId(cellType: MemoryBridgeBeliefCellType, text: string): string {
  return `${cellType}:${normalizeBeliefSlug(text)}`;
}

function buildBeliefStatus(score: number): MemoryBridgeBeliefStatus {
  if (score < BELIEF_REFUTED_THRESHOLD) return "refuted";
  if (score < BELIEF_ACTIVE_THRESHOLD) return "contested";
  return "active";
}

function mergeNullableMax(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function buildBeliefScore(
  event: MemoryBridgeEvent,
  supportCount: number,
  refutationCount: number,
): number {
  const confidence = event.confidence ?? DEFAULT_BELIEF_CONFIDENCE;
  const sourceTrust = event.source_trust ?? DEFAULT_SOURCE_TRUST;
  const corroboration = Math.min(1, Math.max(0, supportCount - 1) / 4);
  const recency = 1;
  const refutation = Math.min(1, refutationCount / 2);
  return clampProbability(
    0.45 * confidence +
      0.3 * sourceTrust +
      0.15 * corroboration +
      0.1 * recency -
      0.4 * refutation,
  );
}

function collectBeliefCells(
  event: MemoryBridgeEvent,
): Array<{ cell_type: MemoryBridgeBeliefCellType; text: string }> {
  return [
    ...event.facts.map((text) => ({ cell_type: "fact" as const, text })),
    ...event.decisions.map((text) => ({ cell_type: "decision" as const, text })),
    ...event.open_loops.map((text) => ({ cell_type: "open_loop" as const, text })),
    ...event.artifacts.map((text) => ({ cell_type: "artifact" as const, text })),
  ];
}

function buildOpenLoopProjection(
  events: MemoryBridgeEvent[],
  options: { threadId?: string } = {},
): Map<string, MemoryBridgeLoopState> {
  const projection = new Map<string, MemoryBridgeLoopState>();

  for (const event of events) {
    if (options.threadId && event.thread_id !== options.threadId) {
      continue;
    }
    const loopState = event.loop_state ?? "open";
    for (const loopText of event.open_loops) {
      projection.set(loopText, loopState);
    }
  }

  return projection;
}

function projectVisibleOpenLoops(
  storedOpenLoops: string[],
  events: MemoryBridgeEvent[],
  threadId?: string,
): string[] {
  const projection = buildOpenLoopProjection(events, threadId ? { threadId } : {});
  if (projection.size === 0) {
    return uniqueStrings(storedOpenLoops.filter((loopText) => normalizeText(loopText).length > 0));
  }
  const activeOpenLoops = [...projection.entries()]
    .filter(([, state]) => state === "open")
    .map(([text]) => text);

  return mergeUnique(
    storedOpenLoops.filter((loopText) => projection.get(loopText) === "open"),
    activeOpenLoops,
  );
}

function collectBeliefIds(event: MemoryBridgeEvent): string[] {
  return uniqueStrings(
    collectBeliefCells(event).map((cell) => buildBeliefId(cell.cell_type, cell.text)),
  );
}

function applyEventToBeliefIndex(
  beliefIndex: MemoryBridgeBeliefIndex,
  event: MemoryBridgeEvent,
  eventId: string,
  includeBeliefIds?: Set<string>,
): MemoryBridgeBeliefDelta[] {
  const deltas: MemoryBridgeBeliefDelta[] = [];
  let updated = false;

  for (const cell of collectBeliefCells(event)) {
    const beliefId = buildBeliefId(cell.cell_type, cell.text);
    if (includeBeliefIds && !includeBeliefIds.has(beliefId)) {
      continue;
    }
    const existing = beliefIndex.beliefs[beliefId];
    const loopState = cell.cell_type === "open_loop" ? (event.loop_state ?? "open") : undefined;

    if (cell.cell_type === "open_loop" && loopState !== "open") {
      const resolvedByEventId = normalizeText(event.resolved_by) || event.event_id || eventId;
      const refutingEvents = mergeUnique(existing?.refuting_events, [resolvedByEventId]);

      beliefIndex.beliefs[beliefId] = {
        belief_id: beliefId,
        cell_type: cell.cell_type,
        text: existing?.text ?? cell.text,
        status: "refuted",
        loop_state: loopState,
        resolved_by_event_id: resolvedByEventId,
        score: 0,
        support_count: existing?.support_count ?? 0,
        refutation_count: refutingEvents.length,
        first_seen_at: existing?.first_seen_at ?? event.timestamp,
        last_seen_at: event.timestamp,
        last_compacted_at: existing?.last_compacted_at ?? null,
        ttl_days: mergeNullableMax(existing?.ttl_days ?? null, event.ttl_days),
        supporting_events: existing?.supporting_events ?? [],
        refuting_events: refutingEvents,
        confidence: event.confidence ?? existing?.confidence ?? null,
        source_trust: event.source_trust ?? existing?.source_trust ?? null,
        ...(event.actor_trust_class
          ? { actor_trust_class: event.actor_trust_class }
          : existing?.actor_trust_class
            ? { actor_trust_class: existing.actor_trust_class }
            : {}),
        ...(event.fact_status
          ? { fact_status: event.fact_status }
          : existing?.fact_status
            ? { fact_status: existing.fact_status }
            : {}),
        immune: existing?.immune,
      };
      updated = true;
      continue;
    }

    const supportCount = (existing?.support_count ?? 0) + 1;
    const refutingEvents = mergeUnique(existing?.refuting_events, event.refuted_by);
    const refutationCount = refutingEvents.length;
    const nextScore = buildBeliefScore(event, supportCount, refutationCount);

    beliefIndex.beliefs[beliefId] = {
      belief_id: beliefId,
      cell_type: cell.cell_type,
      text: existing?.text ?? cell.text,
      status: buildBeliefStatus(nextScore),
      ...(loopState ? { loop_state: loopState, resolved_by_event_id: null } : {}),
      score: nextScore,
      support_count: supportCount,
      refutation_count: refutationCount,
      first_seen_at: existing?.first_seen_at ?? event.timestamp,
      last_seen_at: event.timestamp,
      last_compacted_at: existing?.last_compacted_at ?? null,
      ttl_days: mergeNullableMax(existing?.ttl_days ?? null, event.ttl_days),
      supporting_events: mergeUnique(existing?.supporting_events, [eventId]),
      refuting_events: refutingEvents,
      confidence: event.confidence ?? existing?.confidence ?? null,
      source_trust: event.source_trust ?? existing?.source_trust ?? null,
      ...(event.actor_trust_class
        ? { actor_trust_class: event.actor_trust_class }
        : existing?.actor_trust_class
          ? { actor_trust_class: existing.actor_trust_class }
          : {}),
      ...(event.fact_status
        ? { fact_status: event.fact_status }
        : existing?.fact_status
          ? { fact_status: existing.fact_status }
          : {}),
      immune: existing?.immune,
    };
    updated = true;

    deltas.push({
      timestamp: event.timestamp,
      project_id: event.project_id,
      belief_id: beliefId,
      cell_type: cell.cell_type,
      delta_type: existing ? "reinforced" : "new",
      previous_score: existing?.score ?? null,
      next_score: nextScore,
      cause: {
        event_id: eventId,
        reason: existing ? "additional_support" : "first_observation",
      },
    });
  }

  if (updated) {
    beliefIndex.updated_at = event.timestamp;
  }

  return deltas;
}

function rebuildAffectedBeliefsFromEvents(
  beliefIndex: MemoryBridgeBeliefIndex,
  events: MemoryBridgeEvent[],
  affectedBeliefIds: Set<string>,
  timestamp: string,
): { refreshed: number; removed: number } {
  if (affectedBeliefIds.size === 0) {
    return { refreshed: 0, removed: 0 };
  }

  const replay = buildEmptyBeliefIndex(timestamp);

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const eventId = event.event_id ?? `evt_${i + 1}`;
    applyEventToBeliefIndex(replay, { ...event, event_id: eventId }, eventId, affectedBeliefIds);
  }

  let refreshed = 0;
  let removed = 0;

  for (const beliefId of affectedBeliefIds) {
    const previous = beliefIndex.beliefs[beliefId];
    const next = replay.beliefs[beliefId];

    if (next) {
      if (previous?.immune) {
        next.immune = previous.immune;
      }
      beliefIndex.beliefs[beliefId] = next;
      refreshed += 1;
      continue;
    }

    if (previous) {
      delete beliefIndex.beliefs[beliefId];
      removed += 1;
    }
  }

  beliefIndex.updated_at = timestamp;
  return { refreshed, removed };
}

function scoreEvent(event: MemoryBridgeEvent, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = [
    event.task,
    event.summary,
    ...event.facts,
    ...event.decisions,
    ...event.open_loops,
    ...event.artifacts,
    ...(event.refuted_by ?? []),
  ]
    .join(" \n ")
    .toLowerCase();
  return queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function isSystemTelemetryEvent(event: MemoryBridgeEvent): boolean {
  if (event.actor_trust_class !== "system") return false;
  if (event.task?.endsWith(":completion")) return true;
  return event.facts.some(
    (fact) =>
      fact.includes("sweep_confirmed=") ||
      fact.includes("metabolic_sweep:ok") ||
      fact.includes("immune_sweep:ok") ||
      fact.includes("compaction_run:ok"),
  );
}

function buildSummaryFromEvents(events: MemoryBridgeEvent[]): MemoryBridgeSummary {
  const latest = events.at(-1);
  return {
    facts: mergeUnique(...events.map((event) => event.facts)),
    decisions: mergeUnique(...events.map((event) => event.decisions)),
    open_loops: projectVisibleOpenLoops([], events),
    artifacts: mergeUnique(...events.map((event) => event.artifacts)),
    updated_at: latest?.timestamp ?? nowIso(),
    last_summary: latest?.summary ?? "",
  };
}

const COMPACT_FACT_THRESHOLD = 0.65;
const COMPACT_DECISION_THRESHOLD = 0.70;
const COMPACT_OPEN_LOOP_THRESHOLD = 0.45;
const COMPACT_ARTIFACT_THRESHOLD = 0.60;

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function addDaysIso(timestamp: string, days: number): string {
  const next = new Date(timestamp);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function ageInDays(fromTimestamp: string, toTimestamp: string): number {
  const from = parseIsoTimestamp(fromTimestamp);
  const to = parseIsoTimestamp(toTimestamp);
  if (from === null || to === null) return 0;
  return Math.max(0, (to - from) / (24 * 60 * 60 * 1000));
}

function buildImmuneStatus(
  belief: MemoryBridgeBelief,
  flags: Pick<
    MemoryBridgeImmuneAnnotation,
    "ttl_expired" | "confidence_below_threshold" | "refutation_dominant"
  >,
): MemoryBridgeBeliefStatus {
  if (flags.refutation_dominant || flags.confidence_below_threshold) {
    return "refuted";
  }
  if (flags.ttl_expired) {
    return belief.status === "active" ? "contested" : belief.status;
  }
  return buildBeliefStatus(belief.score);
}

function buildImmuneAnnotation(
  belief: MemoryBridgeBelief,
  sweepTimestamp: string,
): MemoryBridgeImmuneAnnotation {
  const ttlExpired =
    belief.ttl_days !== null && ageInDays(belief.first_seen_at, sweepTimestamp) > belief.ttl_days;
  const confidenceBelowThreshold = belief.score < IMMUNE_APOPTOSIS_FLOOR;
  const refutationDominant = belief.refutation_count > belief.support_count;
  const apoptosisCandidate = ttlExpired || confidenceBelowThreshold || refutationDominant;
  const apoptosisReason = ttlExpired
    ? "ttl_expired"
    : confidenceBelowThreshold
      ? "confidence_low"
      : refutationDominant
        ? "refutation_dominant"
        : null;
  const wasCandidate = belief.immune?.apoptosis_candidate ?? false;
  const apoptosisEligibleAfter = apoptosisCandidate
    ? wasCandidate && belief.immune?.apoptosis_eligible_after
      ? belief.immune.apoptosis_eligible_after
      : addDaysIso(sweepTimestamp, IMMUNE_GRACE_DAYS)
    : null;

  return {
    last_swept_at: sweepTimestamp,
    ttl_expired: ttlExpired,
    confidence_below_threshold: confidenceBelowThreshold,
    refutation_dominant: refutationDominant,
    apoptosis_candidate: apoptosisCandidate,
    apoptosis_reason: apoptosisReason,
    apoptosis_eligible_after: apoptosisEligibleAfter,
  };
}

function isBeliefProjectedInCompact(
  belief: MemoryBridgeBelief,
  nowTimestamp = Date.now(),
): boolean {
  if (!belief.immune?.apoptosis_candidate) return true;
  const eligibleAfter = parseIsoTimestamp(belief.immune.apoptosis_eligible_after);
  if (eligibleAfter === null) return true;
  return eligibleAfter > nowTimestamp;
}

function isBeliefArchiveBlockedByImmuneGate(
  belief: MemoryBridgeBelief,
  nowTimestamp = Date.now(),
): boolean {
  if (!belief.immune?.apoptosis_candidate) return false;
  const eligibleAfter = parseIsoTimestamp(belief.immune.apoptosis_eligible_after);
  if (eligibleAfter === null) return true;
  return eligibleAfter > nowTimestamp;
}

function isBeliefArchiveEligibleByImmuneGate(
  belief: MemoryBridgeBelief,
  nowTimestamp = Date.now(),
): boolean {
  if (!belief.immune?.apoptosis_candidate) return false;
  const eligibleAfter = parseIsoTimestamp(belief.immune.apoptosis_eligible_after);
  if (eligibleAfter === null) return false;
  return eligibleAfter <= nowTimestamp;
}

function isEventArchiveEligibleInCompact(
  event: MemoryBridgeEvent,
  beliefIndex: MemoryBridgeBeliefIndex,
  nowTimestamp = Date.now(),
  latestTwoEventRefs?: Set<MemoryBridgeEvent>,
): boolean {
  // Keep hot: event has explicit refutations that still need to be tracked.
  if ((event.refuted_by?.length ?? 0) > 0) return false;
  // Keep hot: event is one of the latest 2 events for its thread.
  if (latestTwoEventRefs && latestTwoEventRefs.has(event)) return false;
  const beliefIds = collectBeliefIds(event);
  if (beliefIds.length === 0) return false;
  const beliefs = beliefIds
    .map((beliefId) => beliefIndex.beliefs[beliefId])
    .filter((belief): belief is MemoryBridgeBelief => belief !== undefined);
  if (beliefs.length === 0) return false;
  // Keep hot: event anchors a live (active or contested) open_loop belief.
  const anchorsLiveOpenLoop = beliefs.some(
    (b) => b.cell_type === "open_loop" && (b.status === "active" || b.status === "contested"),
  );
  if (anchorsLiveOpenLoop) return false;
  if (beliefs.some((belief) => isBeliefArchiveBlockedByImmuneGate(belief, nowTimestamp))) {
    return false;
  }
  return beliefs.every(
    (belief) =>
      isBeliefProjectedInCompact(belief, nowTimestamp) ||
      isBeliefArchiveEligibleByImmuneGate(belief, nowTimestamp),
  );
}

function buildArchiveSegmentName(timestamp: string): string {
  const normalized = timestamp
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "-");
  return `events-${normalized}.jsonl`;
}

function buildSummaryFromBeliefs(
  beliefIndex: MemoryBridgeBeliefIndex,
  events: MemoryBridgeEvent[],
): MemoryBridgeSummary {
  const beliefs = Object.values(beliefIndex.beliefs);
  const facts = beliefs
    .filter(
      (b) =>
        isBeliefProjectedInCompact(b) &&
        b.cell_type === "fact" &&
        b.score >= COMPACT_FACT_THRESHOLD,
    )
    .sort((a, b) => b.score - a.score)
    .map((b) => b.text);
  const decisions = beliefs
    .filter(
      (b) =>
        isBeliefProjectedInCompact(b) &&
        b.cell_type === "decision" &&
        b.score >= COMPACT_DECISION_THRESHOLD,
    )
    .sort((a, b) => b.score - a.score)
    .map((b) => b.text);
  const open_loops = beliefs
    .filter(
      (b) =>
        isBeliefProjectedInCompact(b) &&
        b.cell_type === "open_loop" &&
        b.score >= COMPACT_OPEN_LOOP_THRESHOLD &&
        (b.status === "active" || b.status === "contested"),
    )
    .sort((a, b) => b.score - a.score)
    .map((b) => b.text);
  const artifacts = beliefs
    .filter(
      (b) =>
        isBeliefProjectedInCompact(b) &&
        b.cell_type === "artifact" &&
        b.score >= COMPACT_ARTIFACT_THRESHOLD,
    )
    .sort((a, b) => b.score - a.score)
    .map((b) => b.text);
  const latest = events.at(-1);
  return {
    facts,
    decisions,
    open_loops,
    artifacts,
    updated_at: beliefIndex.updated_at,
    last_summary: latest?.summary ?? "",
  };
}

function buildEmptySummary(): MemoryBridgeSummary {
  return {
    facts: [],
    decisions: [],
    open_loops: [],
    artifacts: [],
    updated_at: nowIso(),
    last_summary: "",
  };
}

function buildEmptyThreadState(
  projectId: string,
  chatbot: string,
  threadId: string,
): MemoryBridgeThreadState {
  return {
    chatbot,
    thread_id: threadId,
    project_id: projectId,
    updated_at: nowIso(),
    last_task: "",
    last_summary: "",
    open_loops: [],
  };
}

function resolvePaths(root: string, projectId: string, chatbot: string, threadId: string) {
  const projectDir = join(root, "projects", projectId);
  const threadDir = join(root, "threads", chatbot);
  return {
    projectDir,
    threadDir,
    archiveDir: join(projectDir, "archive"),
    summaryPath: join(projectDir, "summary.json"),
    eventsPath: join(projectDir, "events.jsonl"),
    selfStatePath: join(projectDir, "self-state.json"),
    policyRevisionsPath: join(projectDir, "policy-revisions.jsonl"),
    beliefsPath: join(projectDir, "beliefs.json"),
    beliefDeltasPath: join(projectDir, "belief-deltas.jsonl"),
    immuneStatePath: join(projectDir, "immune-state.json"),
    immuneLockPath: join(projectDir, "immune.lock"),
    metabolicStatePath: join(projectDir, "metabolic-state.json"),
    metabolicLockPath: join(projectDir, "metabolic.lock"),
    threadPath: join(threadDir, `${threadId}.json`),
  };
}

async function syncDerivedBeliefs(
  paths: ReturnType<typeof resolvePaths>,
  event: MemoryBridgeEvent,
  eventCount: number,
): Promise<void> {
  const beliefIndex = await readJsonFile<MemoryBridgeBeliefIndex>(
    paths.beliefsPath,
    buildEmptyBeliefIndex(event.timestamp),
  );
  const eventId = `evt_${eventCount}`;
  const deltas = applyEventToBeliefIndex(beliefIndex, { ...event, event_id: eventId }, eventId);
  if (deltas.length === 0 && beliefIndex.updated_at !== event.timestamp) return;
  await writeJsonFile(paths.beliefsPath, beliefIndex);
  if (deltas.length > 0) {
    await appendJsonLines(paths.beliefDeltasPath, deltas);
  }
  // Advance the metabolic cursor so incremental passes skip already-processed events.
  const state = await readJsonFile<MemoryBridgeMetabolicState>(
    paths.metabolicStatePath,
    buildEmptyMetabolicState(event.project_id),
  );
  state.last_event_cursor = eventCount;
  await writeJsonFile(paths.metabolicStatePath, state);
}

function normalizeRequest(request: MemoryBridgeRequest) {
  const projectId = normalizeId(request.project_id, DEFAULT_PROJECT_ID);
  const chatbot = normalizeId(request.chatbot, DEFAULT_CHATBOT);
  const threadId = normalizeId(request.thread_id, DEFAULT_THREAD_ID);
  return { projectId, chatbot, threadId };
}

export async function handleMemoryBridgeRequest(
  request: MemoryBridgeRequest,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeResponse> {
  const rootDir = options.rootDir ?? resolveMemoryBridgeRoot();
  const { projectId, chatbot, threadId } = normalizeRequest(request);
  const paths = resolvePaths(rootDir, projectId, chatbot, threadId);

  await ensureDir(paths.projectDir);
  await ensureDir(paths.threadDir);

  if (request.op === "get") {
    const storedSummary = await readJsonFile<MemoryBridgeSummary>(
      paths.summaryPath,
      buildEmptySummary(),
    );
    const storedThread = await readJsonFile<MemoryBridgeThreadState>(
      paths.threadPath,
      buildEmptyThreadState(projectId, chatbot, threadId),
    );
    const events = await readEvents(paths.eventsPath);
    const summary = {
      ...storedSummary,
      open_loops: projectVisibleOpenLoops(storedSummary.open_loops, events),
    };
    const thread = {
      ...storedThread,
      open_loops: projectVisibleOpenLoops(storedThread.open_loops, events, threadId),
    };
    const queryTokens = uniqueStrings([
      normalizeText(request.task),
      ...(request.topics ?? []),
      ...summary.open_loops,
      thread.last_task,
    ]).flatMap((value) => tokenize(value));
    const limit = Math.max(1, Math.min(Number(request.limit ?? DEFAULT_LIMIT), 20));
    const includeSystemEvents = request.include_system_events === true;
    const beliefIndex = await readJsonFile<MemoryBridgeBeliefIndex>(
      paths.beliefsPath,
      buildEmptyBeliefIndex(),
    );
    const liveEvents = events.filter((event) => {
      // Filter tombstoned events: compacted into archive or swept by immune system.
      if (event.compacted_into || event.swept_at) return false;
      // Filter all-refuted events: every belief cell is refuted in the index.
      const beliefIds = collectBeliefIds(event);
      if (beliefIds.length === 0) return true;
      const beliefs = beliefIds
        .map((id) => beliefIndex.beliefs[id])
        .filter((b): b is MemoryBridgeBelief => b !== undefined);
      if (beliefs.length === 0) return true;
      return !beliefs.every((b) => b.status === "refuted");
    });
    const rankedRelevantEvents = [...liveEvents]
      .map((event) => ({ event, score: scoreEvent(event, queryTokens) }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return right.event.timestamp.localeCompare(left.event.timestamp);
      })
      .filter((item, index) => item.score > 0 || index < limit)
      .slice(0, limit)
      .map((item) => item.event);

    const systemTelemetryEvents = includeSystemEvents
      ? liveEvents
          .filter((event) => isSystemTelemetryEvent(event))
          .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
          .slice(0, limit)
      : [];

    const relevantEvents = includeSystemEvents
      ? mergeEventsByIdentity(systemTelemetryEvents, rankedRelevantEvents).slice(0, limit)
      : rankedRelevantEvents;

    return {
      ok: true,
      op: "get",
      project_id: projectId,
      chatbot,
      thread_id: threadId,
      memory: {
        summary,
        thread,
        relevant_events: relevantEvents,
      },
    };
  }

  if (request.op === "put") {
    const currentSummary = await readJsonFile<MemoryBridgeSummary>(
      paths.summaryPath,
      buildEmptySummary(),
    );
    const timestamp = nowIso();
    const currentSelfState = await readJsonFile<MemoryBridgeSelfState | null>(
      paths.selfStatePath,
      null,
    );
    // Resolve actor trust class and apply confidence ceiling
    const actorTrustClass: MemoryBridgeActorTrustClass | undefined =
      request.actor_trust_class ??
      (request.actor === "user" ? "user" : request.actor === "system" ? "system" : request.actor === "claude" ? "claude" : undefined);
    const ceiling = actorTrustClass !== undefined ? ACTOR_CONFIDENCE_CEILING[actorTrustClass] : 1.0;
    const rawConfidence = normalizeProbability(request.confidence);
    const defaultConfidence = actorTrustClass !== undefined
      ? DEFAULT_CONFIDENCE_BY_TRUST_CLASS[actorTrustClass]
      : DEFAULT_BELIEF_CONFIDENCE;
    const boundedConfidence = rawConfidence !== null ? Math.min(rawConfidence, ceiling) : defaultConfidence;

    // Default fact_status by actor trust class: claudeâ†’inferred, userâ†’observed, systemâ†’reported
    const factStatus: MemoryBridgeFactStatus | undefined =
      request.fact_status ??
      (actorTrustClass === "claude" ? "inferred" : actorTrustClass === "user" ? "observed" : actorTrustClass === "system" ? "reported" : undefined);

    // Resolve input_origin: auto-assign from actor_trust_class if not explicitly set
    const inputOrigin: MemoryBridgeInputOrigin =
      request.input_origin ??
      (actorTrustClass === "user" ? "human" : actorTrustClass === "claude" ? "ai" : "unknown");

    let nextSelfState = normalizeSelfState(request.self_state, {
      timestamp,
      fallbackConfidence: boundedConfidence,
      confidenceCeiling: ceiling,
      fallbackLastRevision: currentSelfState?.last_revision,
    });
    const policyRevision = normalizePolicyRevision(
      request.policy_revision,
      timestamp,
      currentSelfState?.last_revision,
    );
    if (!nextSelfState && policyRevision && currentSelfState) {
      nextSelfState = {
        ...currentSelfState,
        last_revision: policyRevision.revision_id,
        updated_at: timestamp,
      };
    }
    if (nextSelfState && policyRevision) {
      nextSelfState = {
        ...nextSelfState,
        last_revision: policyRevision.revision_id,
      };
    }

    const event: MemoryBridgeEvent = {
      timestamp,
      project_id: projectId,
      chatbot,
      thread_id: threadId,
      task: normalizeText(request.task),
      summary: normalizeText(request.summary),
      facts: uniqueStrings(request.facts),
      decisions: uniqueStrings(request.decisions),
      open_loops: uniqueStrings(request.open_loops),
      ...(normalizeLoopState(request.loop_state) ? { loop_state: normalizeLoopState(request.loop_state) } : {}),
      ...(normalizeText(request.resolved_by) ? { resolved_by: normalizeText(request.resolved_by) } : {}),
      artifacts: uniqueStrings(request.artifacts),
      confidence: boundedConfidence,
      ttl_days: normalizeTtlDays(request.ttl_days) ??
        (factStatus !== undefined
          ? DEFAULT_TTL_DAYS_BY_FACT_STATUS[factStatus]
          : actorTrustClass !== undefined
            ? DEFAULT_TTL_DAYS_BY_TRUST_CLASS[actorTrustClass]
            : null),
      refuted_by: uniqueStrings(request.refuted_by),
      source_trust: normalizeProbability(request.source_trust) ??
        (actorTrustClass !== undefined ? DEFAULT_SOURCE_TRUST_BY_TRUST_CLASS[actorTrustClass] : DEFAULT_SOURCE_TRUST),
      ...(request.actor?.trim() ? { actor: request.actor.trim() } : {}),
      ...(actorTrustClass ? { actor_trust_class: actorTrustClass } : {}),
      ...(factStatus ? { fact_status: factStatus } : {}),
      ...(request.derived_from?.length ? { derived_from: uniqueStrings(request.derived_from) } : {}),
      input_origin: inputOrigin,
      ...(nextSelfState ? { self_state: nextSelfState } : {}),
      ...(policyRevision ? { policy_revision: policyRevision } : {}),
    };
    const nextSummary: MemoryBridgeSummary = {
      facts: mergeUnique(currentSummary.facts, event.facts),
      decisions: mergeUnique(currentSummary.decisions, event.decisions),
      open_loops:
        event.loop_state === undefined || event.loop_state === "open"
          ? mergeUnique(currentSummary.open_loops, event.open_loops)
          : currentSummary.open_loops,
      artifacts: mergeUnique(currentSummary.artifacts, event.artifacts),
      updated_at: timestamp,
      last_summary: event.summary,
    };
    const nextThread: MemoryBridgeThreadState = {
      chatbot,
      thread_id: threadId,
      project_id: projectId,
      updated_at: timestamp,
      last_task: event.task,
      last_summary: event.summary,
      open_loops:
        event.loop_state === undefined || event.loop_state === "open" ? event.open_loops : [],
    };

    await writeJsonFile(paths.summaryPath, nextSummary);
    await writeJsonFile(paths.threadPath, nextThread);
    const eventCount = await appendEvent(paths.eventsPath, event);
    if (nextSelfState) {
      await writeJsonFile(paths.selfStatePath, nextSelfState);
    }
    if (policyRevision) {
      await appendJsonLines(paths.policyRevisionsPath, [
        {
          ...policyRevision,
          caused_by_event_id: `evt_${eventCount}`,
        } satisfies MemoryBridgePolicyRevision,
      ]);
    }
    await syncDerivedBeliefs(paths, event, eventCount);

    return {
      ok: true,
      op: "put",
      project_id: projectId,
      chatbot,
      thread_id: threadId,
      stored: {
        summary_path: paths.summaryPath,
        thread_path: paths.threadPath,
        events_path: paths.eventsPath,
        event_count: eventCount,
      },
    };
  }

  const events = await readEvents(paths.eventsPath);
  const beliefIndex = await readJsonFile<MemoryBridgeBeliefIndex>(
    paths.beliefsPath,
    buildEmptyBeliefIndex(),
  );
  const compactedAt = nowIso();
  const compactedAtTimestamp = parseIsoTimestamp(compactedAt) ?? Date.now();
  const hasBeliefs = Object.keys(beliefIndex.beliefs).length > 0;

  // Build a set of the latest 2 event objects per thread (by reference identity)
  // so the archive gate can enforce the spec "latest-thread-event retention" heuristic.
  // We use object references rather than event_id because put-written events have no id.
  const latestTwoByThread = new Map<string, MemoryBridgeEvent[]>();
  for (const event of events) {
    const bucket = latestTwoByThread.get(event.thread_id) ?? [];
    bucket.push(event);
    latestTwoByThread.set(event.thread_id, bucket);
  }
  const latestTwoEventRefs = new Set<MemoryBridgeEvent>();
  for (const bucket of latestTwoByThread.values()) {
    for (const event of bucket.slice(-2)) {
      latestTwoEventRefs.add(event);
    }
  }

  const compactedSummary = hasBeliefs
    ? buildSummaryFromBeliefs(beliefIndex, events)
    : buildSummaryFromEvents(events);
  const archivedEvents = hasBeliefs
    ? events.filter((event) =>
        isEventArchiveEligibleInCompact(event, beliefIndex, compactedAtTimestamp, latestTwoEventRefs),
      )
    : [];
  const hotEvents =
    archivedEvents.length > 0
      ? events.filter(
          (event) => !isEventArchiveEligibleInCompact(event, beliefIndex, compactedAtTimestamp, latestTwoEventRefs),
        )
      : events;

  const archivedRefs = new Set(archivedEvents);
  const affectedBeliefIds = new Set<string>();
  for (const event of events) {
    if (!archivedRefs.has(event) && !event.swept_at) {
      continue;
    }
    for (const beliefId of collectBeliefIds(event)) {
      affectedBeliefIds.add(beliefId);
    }
  }

  if (hasBeliefs && affectedBeliefIds.size > 0) {
    const liveHotEvents = hotEvents.filter((event) => !event.swept_at && !event.compacted_into);
    rebuildAffectedBeliefsFromEvents(
      beliefIndex,
      liveHotEvents,
      affectedBeliefIds,
      compactedAt,
    );
  }

  if (hasBeliefs) {
    for (const belief of Object.values(beliefIndex.beliefs)) {
      if (
        isBeliefProjectedInCompact(belief, compactedAtTimestamp) ||
        isBeliefArchiveEligibleByImmuneGate(belief, compactedAtTimestamp)
      ) {
        belief.last_compacted_at = compactedAt;
      }
    }
    await writeJsonFile(paths.beliefsPath, beliefIndex);
  }

  if (archivedEvents.length > 0) {
    await ensureDir(paths.archiveDir);
    const archiveSegment = buildArchiveSegmentName(compactedAt);
    await writeJsonLines(
      join(paths.archiveDir, archiveSegment),
      archivedEvents.map((e) => ({ ...e, compacted_into: archiveSegment })),
    );
    await writeJsonLines(paths.eventsPath, hotEvents);
  }

  await writeJsonFile(paths.summaryPath, compactedSummary);
  const metabolicState = await readJsonFile<MemoryBridgeMetabolicState>(
    paths.metabolicStatePath,
    buildEmptyMetabolicState(projectId),
  );
  metabolicState.last_compaction_at = compactedAt;
  metabolicState.archived_events += archivedEvents.length;
  metabolicState.hot_events = hotEvents.length;
  await writeJsonFile(paths.metabolicStatePath, metabolicState);
  return {
    ok: true,
    op: "compact",
    project_id: projectId,
    chatbot,
    thread_id: threadId,
    compacted: {
      events_path: paths.eventsPath,
      summary_path: paths.summaryPath,
      event_count: hotEvents.length,
    },
  };
}

function mergeEventsByIdentity(
  primary: MemoryBridgeEvent[],
  secondary: MemoryBridgeEvent[],
): MemoryBridgeEvent[] {
  const merged: MemoryBridgeEvent[] = [];
  const seen = new Set<string>();

  const append = (event: MemoryBridgeEvent) => {
    const key = event.event_id
      ? `event_id:${event.event_id}`
      : `fingerprint:${event.timestamp}:${event.task}:${event.summary}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(event);
  };

  for (const event of primary) append(event);
  for (const event of secondary) append(event);

  return merged;
}

export async function handleMetabolicPass(
  projectId: string,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeMetabolicRunResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const projectDir = join(root, "projects", normalizedProjectId);
  const eventsPath = join(projectDir, "events.jsonl");
  const beliefsPath = join(projectDir, "beliefs.json");
  const beliefDeltasPath = join(projectDir, "belief-deltas.jsonl");
  const metabolicStatePath = join(projectDir, "metabolic-state.json");
  const metabolicLockPath = join(projectDir, "metabolic.lock");
  const logsDir = join(root, "logs");
  const metabolicRunsLogPath = join(logsDir, "metabolic-runs.jsonl");

  await ensureDir(projectDir);
  await ensureDir(logsDir);

  const lockAcquired = await acquireProjectLock(metabolicLockPath);
  if (!lockAcquired) {
    throw new Error(
      `METABOLIC_LOCK_HELD: metabolic pass for ${normalizedProjectId} is already running.`,
    );
  }

  const startedAt = Date.now();
  let eventsScanned = 0;
  let deltasEmitted = 0;

  try {
    const state = await readJsonFile<MemoryBridgeMetabolicState>(
      metabolicStatePath,
      buildEmptyMetabolicState(normalizedProjectId),
    );
    const cursorBefore = state.last_event_cursor;

    const events = await readEvents(eventsPath);
    const newEvents = events.slice(cursorBefore);
    eventsScanned = newEvents.length;

    const beliefIndex = await readJsonFile<MemoryBridgeBeliefIndex>(
      beliefsPath,
      buildEmptyBeliefIndex(),
    );
    const allDeltas: MemoryBridgeBeliefDelta[] = [];

    for (let i = 0; i < newEvents.length; i++) {
      const event = newEvents[i]!;
      const globalEventIndex = cursorBefore + i;
      const eventId = event.event_id ?? `evt_${globalEventIndex + 1}`;
      const deltas = applyEventToBeliefIndex(beliefIndex, { ...event, event_id: eventId }, eventId);
      allDeltas.push(...deltas);
    }

    deltasEmitted = allDeltas.length;

    const now = nowIso();
    if (newEvents.length > 0) {
      beliefIndex.updated_at = now;
      await writeJsonFile(beliefsPath, beliefIndex);
      if (allDeltas.length > 0) {
        await appendJsonLines(beliefDeltasPath, allDeltas);
      }
    }

    state.last_event_cursor = events.length;
    state.last_incremental_at = now;
    state.hot_events = Math.max(0, events.length - state.archived_events);
    await writeJsonFile(metabolicStatePath, state);

    const beliefs = Object.values(beliefIndex.beliefs);
    const beliefsActive = beliefs.filter((b) => b.status === "active").length;
    const beliefsContested = beliefs.filter((b) => b.status === "contested").length;

    // â”€â”€ Task detection: scan ALL events since last task detection cursor â”€â”€
    // NOTE: This uses last_task_detection_cursor, NOT last_event_cursor.
    // syncDerivedBeliefs advances last_event_cursor so the belief pass skips
    // already-processed events. But task detection must run independently â€”
    // it scans events since the last time task detection ran, not the belief cursor.
    const taskCursorBefore = state.last_task_detection_cursor ?? 0;
    const taskEvents = events.slice(taskCursorBefore);
    const pendingTasksPath = join(projectDir, "pending-tasks.jsonl");
    const detectedTasks: MemoryBridgePendingTask[] = [];

    for (let i = 0; i < taskEvents.length; i++) {
      const event = taskEvents[i]!;
      const facts = event.facts ?? [];
      const isPendingTask =
        facts.some((f) => f.startsWith("[TASK]")) &&
        facts.some((f) => f.includes("task.status=pending"));
      if (!isPendingTask) continue;

      const rawTaskFact = facts.find((f) => f.startsWith("[TASK]")) ?? "";
      // Parse: "[TASK] <task_type>/<correlation_id>"
      const taskFacetMatch = rawTaskFact.match(/^\[TASK\]\s+([^/]+)\/(.+)$/);
      const taskType = taskFacetMatch?.[1]?.trim() ?? "unknown";
      const correlationId = taskFacetMatch?.[2]?.trim() ?? `unknown-${taskCursorBefore + i}`;

      // Parse all key=value decisions into a lookup map
      const decisionMap: Record<string, string> = {};
      for (const d of event.decisions ?? []) {
        const eqIdx = d.indexOf("=");
        if (eqIdx > 0) {
          const k = d.slice(0, eqIdx).trim();
          const v = d.slice(eqIdx + 1).trim();
          decisionMap[k] = v;
        }
      }

      const callerAgent = decisionMap["caller_agent"] ?? null;
      // task_prompt / task_input â†’ surfaced as `input` for worker dispatch
      const taskInput = decisionMap["task_prompt"] ?? decisionMap["task_input"] ?? null;
      // task_skill overrides task_type if explicitly set
      const taskSkill = decisionMap["task_skill"] ?? null;

      const globalIdx = taskCursorBefore + i;
      const eventId = event.event_id ?? `evt_${globalIdx + 1}`;

      detectedTasks.push({
        correlation_id: correlationId,
        task_type: taskSkill ?? taskType,
        event_id: eventId,
        detected_at: now,
        actor_trust_class: event.actor_trust_class,
        fact_status: event.fact_status,
        confidence: event.confidence ?? null,
        caller_agent: callerAgent,
        raw_task_fact: rawTaskFact,
        ...(taskInput !== null && { input: taskInput }),
        ...(taskSkill !== null && { skill: taskSkill }),
      });
    }

    // Advance the task detection cursor to the full event list length
    state.last_task_detection_cursor = events.length;
    await writeJsonFile(metabolicStatePath, state);

    if (detectedTasks.length > 0) {
      await ensureDir(projectDir);
      await appendJsonLines(pendingTasksPath, detectedTasks);
    }
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const result: MemoryBridgeMetabolicRunResult = {
      ok: true,
      op: "metabolic",
      mode: "incremental",
      project_id: normalizedProjectId,
      events_scanned: eventsScanned,
      deltas_emitted: deltasEmitted,
      beliefs_active: beliefsActive,
      beliefs_contested: beliefsContested,
      cursor_before: cursorBefore,
      cursor_after: events.length,
      tasks_detected: detectedTasks.length,
    };

    await appendJsonLines(metabolicRunsLogPath, [
      {
        timestamp: now,
        project_id: normalizedProjectId,
        mode: "incremental",
        events_scanned: eventsScanned,
        deltas_emitted: deltasEmitted,
        beliefs_active: beliefsActive,
        beliefs_contested: beliefsContested,
        events_archived: state.archived_events,
        duration_ms: Date.now() - startedAt,
        ok: true,
        error: null,
      },
    ]);

    await appendSweepCompletionTelemetry(eventsPath, {
      projectId: normalizedProjectId,
      op: "metabolic",
      mode: "incremental",
      summary:
        "Metabolic sweep completed and persisted with explicit telemetry metrics.",
      facts: [
        `sweep_confirmed=metabolic`,
        `metabolic_sweep:ok`,
        `metabolic_sweep:ok:mode=incremental`,
        `metabolic_sweep_project=${normalizedProjectId}`,
        `metabolic_cursor=${events.length}`,
        `metabolic_compacted=0`,
        `metabolic_purged=0`,
        `metabolic_events_scanned=${eventsScanned}`,
        `metabolic_deltas_emitted=${deltasEmitted}`,
        `metabolic_beliefs_active=${beliefsActive}`,
        `metabolic_beliefs_contested=${beliefsContested}`,
        `metabolic_cursor_before=${cursorBefore}`,
        `metabolic_cursor_after=${events.length}`,
        `metabolic_tasks_detected=${detectedTasks.length}`,
      ],
      decisions: [`cursor=${events.length}`, `compacted=0`, `purged=0`],
      artifacts: ["logs/metabolic-runs.jsonl", "projects/*/metabolic-state.json"],
    });

    return result;
  } finally {
    await releaseProjectLock(metabolicLockPath);
  }
}

export async function handleImmuneSweep(
  projectId: string,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeImmuneRunResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const projectDir = join(root, "projects", normalizedProjectId);
  const eventsPath = join(projectDir, "events.jsonl");
  const beliefsPath = join(projectDir, "beliefs.json");
  const beliefDeltasPath = join(projectDir, "belief-deltas.jsonl");
  const immuneStatePath = join(projectDir, "immune-state.json");
  const immuneLockPath = join(projectDir, "immune.lock");
  const logsDir = join(root, "logs");
  const immuneRunsLogPath = join(logsDir, "immune-runs.jsonl");

  await ensureDir(projectDir);
  await ensureDir(logsDir);

  const lockAcquired = await acquireProjectLock(immuneLockPath);
  if (!lockAcquired) {
    throw new Error(
      `IMMUNE_LOCK_HELD: immune sweep for ${normalizedProjectId} is already running.`,
    );
  }

  const startedAt = Date.now();

  try {
    const immuneState = await readJsonFile<MemoryBridgeImmuneState>(
      immuneStatePath,
      buildEmptyImmuneState(normalizedProjectId),
    );
    const beliefIndex = await readJsonFile<MemoryBridgeBeliefIndex>(
      beliefsPath,
      buildEmptyBeliefIndex(),
    );
    const sweepTimestamp = nowIso();
    const lastSweepAtTimestamp = parseIsoTimestamp(immuneState.last_sweep_at);
    const beliefs = Object.values(beliefIndex.beliefs);
    const beliefsToSweep = beliefs.filter((belief) => {
      if (!belief.immune?.last_swept_at) return true;
      if (lastSweepAtTimestamp === null) return true;
      const lastSeenAt = parseIsoTimestamp(belief.last_seen_at);
      return lastSeenAt !== null && lastSeenAt > lastSweepAtTimestamp;
    });

    let candidatesMarked = 0;
    let candidatesCleared = 0;
    const reopenedDeltas: MemoryBridgeBeliefDelta[] = [];

    for (const belief of beliefsToSweep) {
      const previousCandidate = belief.immune?.apoptosis_candidate ?? false;
      const nextImmune = buildImmuneAnnotation(belief, sweepTimestamp);
      if (!previousCandidate && nextImmune.apoptosis_candidate) candidatesMarked += 1;
      if (previousCandidate && !nextImmune.apoptosis_candidate) {
        candidatesCleared += 1;
        reopenedDeltas.push({
          timestamp: sweepTimestamp,
          project_id: normalizedProjectId,
          belief_id: belief.belief_id,
          cell_type: belief.cell_type,
          delta_type: "reopened",
          previous_score: belief.score,
          next_score: belief.score,
          cause: {
            event_id: "immune_sweep",
            reason: "immune_cleared",
          },
        });
      }
      belief.immune = nextImmune;
      belief.status = buildImmuneStatus(belief, nextImmune);
    }

    if (beliefsToSweep.length > 0) {
      beliefIndex.updated_at = sweepTimestamp;
      await writeJsonFile(beliefsPath, beliefIndex);
    }

    if (reopenedDeltas.length > 0) {
      await appendJsonLines(beliefDeltasPath, reopenedDeltas);
    }

    const cursorBefore = immuneState.last_belief_cursor;
    const cursorAfter = beliefs.length;
    const apoptosisEventsPending = beliefs.filter(
      (belief) => belief.immune?.apoptosis_candidate,
    ).length;

    immuneState.last_belief_cursor = cursorAfter;
    immuneState.last_sweep_at = sweepTimestamp;
    immuneState.candidates_marked = candidatesMarked;
    immuneState.candidates_cleared = candidatesCleared;
    immuneState.apoptosis_events_pending = apoptosisEventsPending;
    await writeJsonFile(immuneStatePath, immuneState);

    const result: MemoryBridgeImmuneRunResult = {
      ok: true,
      op: "immune",
      mode: "sweep",
      project_id: normalizedProjectId,
      beliefs_scanned: beliefsToSweep.length,
      candidates_marked: candidatesMarked,
      candidates_cleared: candidatesCleared,
      reopened_deltas_emitted: reopenedDeltas.length,
      cursor_before: cursorBefore,
      cursor_after: cursorAfter,
    };

    await appendJsonLines(immuneRunsLogPath, [
      {
        timestamp: sweepTimestamp,
        project_id: normalizedProjectId,
        mode: "sweep",
        beliefs_scanned: beliefsToSweep.length,
        candidates_marked: candidatesMarked,
        candidates_cleared: candidatesCleared,
        reopened_deltas_emitted: reopenedDeltas.length,
        apoptosis_events_pending: apoptosisEventsPending,
        duration_ms: Date.now() - startedAt,
        ok: true,
        error: null,
      },
    ]);

    const eventsRemainingHot = (await readEvents(eventsPath)).length;

    await appendSweepCompletionTelemetry(eventsPath, {
      projectId: normalizedProjectId,
      op: "immune",
      mode: "sweep",
      summary:
        "Immune sweep completed and persisted with explicit telemetry metrics.",
      facts: [
        `immune_sweep:ok:mode=sweep`,
        `immune_sweep_project=${normalizedProjectId}`,
        `immune_beliefs_scanned=${beliefsToSweep.length}`,
        `immune_candidates_marked=${candidatesMarked}`,
        `immune_candidates_cleared=${candidatesCleared}`,
        `immune_reopened_deltas_emitted=${reopenedDeltas.length}`,
        `immune_apoptosis_events_pending=${apoptosisEventsPending}`,
        `immune_cursor_before=${cursorBefore}`,
        `immune_cursor_after=${cursorAfter}`,
      ],
      artifacts: ["logs/immune-runs.jsonl", "projects/*/immune-state.json"],
    });

    return result;
  } finally {
    await releaseProjectLock(immuneLockPath);
  }
}

export async function handleImmuneFullSweep(
  projectId: string,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeImmuneFullSweepRunResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const projectDir = join(root, "projects", normalizedProjectId);
  const eventsPath = join(projectDir, "events.jsonl");
  const beliefsPath = join(projectDir, "beliefs.json");
  const beliefDeltasPath = join(projectDir, "belief-deltas.jsonl");
  const immuneStatePath = join(projectDir, "immune-state.json");
  const immuneLockPath = join(projectDir, "immune.lock");
  const logsDir = join(root, "logs");
  const immuneRunsLogPath = join(logsDir, "immune-runs.jsonl");

  await ensureDir(projectDir);
  await ensureDir(logsDir);

  const lockAcquired = await acquireProjectLock(immuneLockPath);
  if (!lockAcquired) {
    throw new Error(
      `IMMUNE_LOCK_HELD: immune full-sweep for ${normalizedProjectId} is already running.`,
    );
  }

  const startedAt = Date.now();

  try {
    const immuneState = await readJsonFile<MemoryBridgeImmuneState>(
      immuneStatePath,
      buildEmptyImmuneState(normalizedProjectId),
    );
    const beliefIndex = await readJsonFile<MemoryBridgeBeliefIndex>(
      beliefsPath,
      buildEmptyBeliefIndex(),
    );
    const sweepTimestamp = nowIso();

    // Full sweep re-evaluates every belief regardless of last_belief_cursor.
    const beliefs = Object.values(beliefIndex.beliefs);
    let candidatesMarked = 0;
    let candidatesCleared = 0;
    const reopenedDeltas: MemoryBridgeBeliefDelta[] = [];

    for (const belief of beliefs) {
      const previousCandidate = belief.immune?.apoptosis_candidate ?? false;
      const nextImmune = buildImmuneAnnotation(belief, sweepTimestamp);
      if (!previousCandidate && nextImmune.apoptosis_candidate) candidatesMarked += 1;
      if (previousCandidate && !nextImmune.apoptosis_candidate) {
        candidatesCleared += 1;
        reopenedDeltas.push({
          timestamp: sweepTimestamp,
          project_id: normalizedProjectId,
          belief_id: belief.belief_id,
          cell_type: belief.cell_type,
          delta_type: "reopened",
          previous_score: belief.score,
          next_score: belief.score,
          cause: {
            event_id: "immune_sweep",
            reason: "immune_cleared",
          },
        });
      }
      belief.immune = nextImmune;
      belief.status = buildImmuneStatus(belief, nextImmune);
    }

    if (beliefs.length > 0) {
      beliefIndex.updated_at = sweepTimestamp;
      await writeJsonFile(beliefsPath, beliefIndex);
    }

    if (reopenedDeltas.length > 0) {
      await appendJsonLines(beliefDeltasPath, reopenedDeltas);
    }

    const apoptosisEventsPending = beliefs.filter(
      (belief) => belief.immune?.apoptosis_candidate,
    ).length;

    // Execute apoptosis: stamp swept_at on events whose ALL belief cells are past apoptosis_eligible_after.
    const nowTs = parseIsoTimestamp(sweepTimestamp) ?? Date.now();
    const sweptBeliefIds = new Set(
      beliefs
        .filter((b) => {
          if (!b.immune?.apoptosis_candidate) return false;
          const eligible = parseIsoTimestamp(b.immune.apoptosis_eligible_after);
          return eligible !== null && eligible <= nowTs;
        })
        .map((b) => b.belief_id),
    );
    let eventsSwept = 0;
    if (sweptBeliefIds.size > 0) {
      const hotEvents = await readEvents(eventsPath);
      let didStamp = false;
      const stamped = hotEvents.map((event) => {
        if (event.swept_at || event.compacted_into) return event;
        const ids = collectBeliefIds(event);
        if (ids.length > 0 && ids.every((id) => sweptBeliefIds.has(id))) {
          didStamp = true;
          eventsSwept += 1;
          return { ...event, swept_at: sweepTimestamp };
        }
        return event;
      });
      if (didStamp) {
        await writeJsonLines(eventsPath, stamped);
      }
    }

    immuneState.last_full_sweep_at = sweepTimestamp;
    immuneState.last_sweep_at = sweepTimestamp;
    immuneState.last_belief_cursor = beliefs.length;
    immuneState.candidates_marked = candidatesMarked;
    immuneState.candidates_cleared = candidatesCleared;
    immuneState.apoptosis_events_pending = apoptosisEventsPending;
    await writeJsonFile(immuneStatePath, immuneState);

    const result: MemoryBridgeImmuneFullSweepRunResult = {
      ok: true,
      op: "immune",
      mode: "full-sweep",
      project_id: normalizedProjectId,
      beliefs_scanned: beliefs.length,
      candidates_marked: candidatesMarked,
      candidates_cleared: candidatesCleared,
      reopened_deltas_emitted: reopenedDeltas.length,
      events_swept: eventsSwept,
    };

    await appendJsonLines(immuneRunsLogPath, [
      {
        timestamp: sweepTimestamp,
        project_id: normalizedProjectId,
        mode: "full-sweep",
        beliefs_scanned: beliefs.length,
        candidates_marked: candidatesMarked,
        candidates_cleared: candidatesCleared,
        reopened_deltas_emitted: reopenedDeltas.length,
        apoptosis_events_pending: apoptosisEventsPending,
        duration_ms: Date.now() - startedAt,
        ok: true,
        error: null,
      },
    ]);

    const eventsRemainingHot = (await readEvents(eventsPath)).length;

    await appendSweepCompletionTelemetry(eventsPath, {
      projectId: normalizedProjectId,
      op: "immune",
      mode: "full-sweep",
      summary:
        "Immune full sweep completed and persisted with explicit telemetry metrics.",
      facts: [
        `immune_sweep:ok:mode=full-sweep`,
        `immune_sweep_project=${normalizedProjectId}`,
        `immune_beliefs_scanned=${beliefs.length}`,
        `immune_candidates_marked=${candidatesMarked}`,
        `immune_candidates_cleared=${candidatesCleared}`,
        `immune_reopened_deltas_emitted=${reopenedDeltas.length}`,
        `immune_apoptosis_events_pending=${apoptosisEventsPending}`,
        `immune_events_swept=${eventsSwept}`,
        `immune_events_remaining_hot=${eventsRemainingHot}`,
      ],
      artifacts: ["logs/immune-runs.jsonl", "projects/*/events.jsonl"],
    });

    return result;
  } finally {
    await releaseProjectLock(immuneLockPath);
  }
}

// ---------------------------------------------------------------------------
// Proactive context surface â€” returns top active beliefs for a task/topics
// without requiring a prior PUT. This is the "bridge interrupts before you ask"
// endpoint: call it at session start to surface relevant memory automatically.
// ---------------------------------------------------------------------------

export interface MemoryBridgeContextRequest {
  project_id?: string;
  task?: string;
  topics?: string[];
  limit?: number;
  min_score?: number;
}

export interface MemoryBridgeContextResponse {
  ok: true;
  op: "context";
  project_id: string;
  task: string;
  beliefs: Array<{
    belief_id: string;
    cell_type: MemoryBridgeBeliefCellType;
    text: string;
    status: MemoryBridgeBeliefStatus;
    score: number;
  }>;
  summary: MemoryBridgeSummary;
  normalized_open_loops: {
    live: string[];
    blocked_external: string[];
    deferred: string[];
  };
  self_state: MemoryBridgeSelfState | null;
  latest_policy_revision: MemoryBridgePolicyRevision | null;
}

export async function handleContextRequest(
  request: MemoryBridgeContextRequest,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeContextResponse> {
  const rootDir = options.rootDir ?? resolveMemoryBridgeRoot();
  const projectId = normalizeId(request.project_id, DEFAULT_PROJECT_ID);
  const projectDir = join(rootDir, "projects", projectId);
  const beliefsPath = join(projectDir, "beliefs.json");
  const summaryPath = join(projectDir, "summary.json");
  const eventsPath = join(projectDir, "events.jsonl");
  const selfStatePath = join(projectDir, "self-state.json");
  const policyRevisionsPath = join(projectDir, "policy-revisions.jsonl");

  const beliefIndex = await readJsonFile<MemoryBridgeBeliefIndex>(
    beliefsPath,
    buildEmptyBeliefIndex(),
  );
  const storedSummary = await readJsonFile<MemoryBridgeSummary>(summaryPath, buildEmptySummary());
  const events = await readEvents(eventsPath);
  const normalizedOpenLoops = normalizeOpenLoopBuckets(
    projectVisibleOpenLoops(storedSummary.open_loops, events),
  );
  const summary = {
    ...storedSummary,
    open_loops: normalizedOpenLoops.all,
  };
  const selfState = await readJsonFile<MemoryBridgeSelfState | null>(selfStatePath, null);
  const latestPolicyRevision = await readLatestJsonLine<MemoryBridgePolicyRevision>(
    policyRevisionsPath,
  );

  const queryTokens = uniqueStrings([
    normalizeText(request.task),
    ...(request.topics ?? []),
    ...normalizedOpenLoops.all,
  ]).flatMap((v) => tokenize(v));

  const minScore = typeof request.min_score === "number" ? request.min_score : 0;
  const limit = Math.max(1, Math.min(Number(request.limit ?? DEFAULT_LIMIT), 50));

  function scorebelief(belief: MemoryBridgeBelief): number {
    const decisionWeight = belief.cell_type === "decision" ? 0.88 : 1;
    const contestedWeight = belief.status === "contested" ? 0.82 : 1;
    const verbosityWeight = Math.max(0.72, 1 - Math.max(0, belief.text.length - 240) / 1800);
    const ageDays = Math.max(0, (Date.now() - Date.parse(belief.last_seen_at)) / (24 * 60 * 60 * 1000));
    const recencyWeight = Math.max(0.55, 1 - ageDays / 60);
    const refutationWeight = Math.max(0.55, 1 - belief.refutation_count * 0.08);
    const repeatedContestWeight =
      belief.status === "contested" && belief.refutation_count >= belief.support_count && belief.refutation_count > 0
        ? 0.78
        : 1;
    const ownerWeight =
      belief.cell_type === "open_loop" && inferOpenLoopOwner(belief.text) !== "general"
        ? 1.08
        : 0.96;
    const evidenceWeight = belief.supporting_events.length > 0 ? 1.04 : 0.9;
    const baseWeight =
      decisionWeight *
      contestedWeight *
      verbosityWeight *
      recencyWeight *
      refutationWeight *
      repeatedContestWeight *
      ownerWeight *
      evidenceWeight;

    if (queryTokens.length === 0) {
      return belief.score * baseWeight;
    }

    const haystack = `${belief.text} ${belief.cell_type}`.toLowerCase();
    const match = queryTokens.reduce(
      (acc, token) => acc + (haystack.includes(token) ? 1 : 0),
      0,
    );
    return belief.score * (1 + 0.2 * match) * baseWeight;
  }

  const ranked = Object.values(beliefIndex.beliefs)
    .filter((b) => b.status !== "refuted" && b.score >= minScore)
    .map((b) => ({ belief: b, rank: scorebelief(b) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(({ belief }) => ({
      belief_id: belief.belief_id,
      cell_type: belief.cell_type,
      text: belief.text,
      status: belief.status,
      score: belief.score,
    }));

  return {
    ok: true,
    op: "context",
    project_id: projectId,
    task: normalizeText(request.task),
    beliefs: ranked,
    summary,
    normalized_open_loops: {
      live: normalizedOpenLoops.live,
      blocked_external: normalizedOpenLoops.blocked_external,
      deferred: normalizedOpenLoops.deferred,
    },
    self_state: selfState,
    latest_policy_revision: latestPolicyRevision,
  };
}

// ---------------------------------------------------------------------------
// .apm export â€” portable Agentic Project Memory archive
// Returns a self-contained JSON object that defines the store contents.
// The format is the publishable standard: manifest + events + beliefs + summary.
// ---------------------------------------------------------------------------

export interface ApmExport {
  apm_version: "1.0";
  exported_at: string;
  project_id: string;
  manifest: {
    schema_version: string;
    project_id: string;
    exported_at: string;
    generator: string;
  };
  summary: MemoryBridgeSummary;
  beliefs: MemoryBridgeBeliefIndex;
  events: MemoryBridgeEvent[];
}

export async function exportProject(
  projectId: string,
  options: { rootDir?: string } = {},
): Promise<ApmExport> {
  const rootDir = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const projectDir = join(rootDir, "projects", normalizedProjectId);
  const eventsPath = join(projectDir, "events.jsonl");
  const beliefsPath = join(projectDir, "beliefs.json");
  const summaryPath = join(projectDir, "summary.json");

  const [events, beliefIndex, summary] = await Promise.all([
    readEvents(eventsPath),
    readJsonFile<MemoryBridgeBeliefIndex>(beliefsPath, buildEmptyBeliefIndex()),
    readJsonFile<MemoryBridgeSummary>(summaryPath, buildEmptySummary()),
  ]);

  const exportedAt = nowIso();
  return {
    apm_version: "1.0",
    exported_at: exportedAt,
    project_id: normalizedProjectId,
    manifest: {
      schema_version: MEMORY_BRIDGE_SCHEMA_VERSION,
      project_id: normalizedProjectId,
      exported_at: exportedAt,
      generator: "aik-memory-bridge",
    },
    summary,
    beliefs: beliefIndex,
    events,
  };
}

// ---------------------------------------------------------------------------
// Task Dispatch API â€” append-only ledger approach
//
// Three files per project:
//   pending-tasks.jsonl  â€” written by metabolic loop (MemoryBridgePendingTask)
//   task-claims.jsonl    â€” written by /tasks/claim
//   task-results.jsonl   â€” written by /tasks/complete
//
// Effective task status is derived at read time:
//   correlation_id in results â†’ completed
//   correlation_id in claims but not results â†’ claimed
//   otherwise â†’ pending
//
// Trust gate: only system or user actor_trust_class tasks are execution-eligible.
// Claude-class tasks are listed but flagged as trust_blocked=true.
// ---------------------------------------------------------------------------

export type MemoryBridgeTaskStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "trust_blocked"
  | "expired"
  | "archived"
  | "dead_letter";

export interface MemoryBridgeTaskClaim {
  correlation_id: string;
  claimed_by: string;
  claimed_at: string;
  claimed_until?: string;
}

export interface MemoryBridgeTaskResult {
  correlation_id: string;
  completed_by: string;
  completed_at: string;
  output: string;
  exit_code: number;
}

export interface MemoryBridgeTaskLifecycleRecord {
  correlation_id: string;
  transition: "archived" | "requeued" | "dead_letter";
  reason: "stale_expired_no_worker_claim" | "stale_ttl_elapsed";
  target_capability: string;
  first_seen_at: string;
  last_seen_at: string;
  age_hours: number;
  recorded_at: string;
  retry_count: number;
  claimed_by?: string;
  claimed_at?: string;
  claimed_until?: string;
}

export interface MemoryBridgeTaskListItem extends MemoryBridgePendingTask {
  status: MemoryBridgeTaskStatus;
  claimed_by?: string;
  claimed_at?: string;
  completed_by?: string;
  completed_at?: string;
  output?: string;
  exit_code?: number;
  retry_count?: number;
  lifecycle_reason?: string;
}

export interface MemoryBridgeListTasksResult {
  ok: true;
  op: "tasks/list";
  project_id: string;
  tasks: MemoryBridgeTaskListItem[];
  counts: Record<MemoryBridgeTaskStatus, number>;
}

export interface MemoryBridgeClaimTaskResult {
  ok: true;
  op: "tasks/claim";
  project_id: string;
  correlation_id: string;
  claimed_by: string;
  claimed_at: string;
  claimed_until?: string;
}

export interface MemoryBridgeCompleteTaskResult {
  ok: true;
  op: "tasks/complete";
  project_id: string;
  correlation_id: string;
  completed_by: string;
  completed_at: string;
}

export interface MemoryBridgeSweepPendingTasksResult {
  ok: true;
  op: "tasks/sweep";
  project_id: string;
  archived: MemoryBridgeTaskLifecycleRecord[];
  requeued: MemoryBridgeTaskLifecycleRecord[];
  dead_lettered: MemoryBridgeTaskLifecycleRecord[];
}

function resolveTaskPaths(root: string, projectId: string) {
  const projectDir = join(root, "projects", projectId);
  return {
    projectDir,
    pendingTasksPath: join(projectDir, "pending-tasks.jsonl"),
    taskClaimsPath: join(projectDir, "task-claims.jsonl"),
    taskResultsPath: join(projectDir, "task-results.jsonl"),
    taskFailuresPath: join(projectDir, "task-failures.jsonl"),
    taskLifecyclePath: join(projectDir, "task-lifecycle.jsonl"),
    eventsPath: join(projectDir, "events.jsonl"),
  };
}

async function appendTaskFailureRecord(
  path: string,
  record: {
    correlation_id: string;
    stage: "claim" | "complete";
    reason: string;
    actor: string;
    timestamp: string;
    detail?: string;
  },
): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

function resolveTaskClaimTtlMinutes(): number {
  const configured = Number.parseInt(process.env.AIK_TASK_CLAIM_TTL_MINUTES ?? "", 10);
  if (!Number.isFinite(configured)) return 20;
  return Math.max(1, Math.min(240, configured));
}

function isClaimExpired(claim: Pick<MemoryBridgeTaskClaim, "claimed_until">, nowMs = Date.now()): boolean {
  if (!claim.claimed_until) return false;
  const expiryMs = Date.parse(claim.claimed_until);
  if (!Number.isFinite(expiryMs)) return false;
  return nowMs >= expiryMs;
}

function latestTimestamp(...values: Array<string | undefined>): string {
  const timestamps = values
    .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return nowIso();
  return new Date(Math.max(...timestamps)).toISOString();
}

function ageHoursBetween(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return Math.round(((endMs - startMs) / (60 * 60 * 1000)) * 10) / 10;
}

function buildLifecycleRecord(
  task: MemoryBridgePendingTask,
  claim: MemoryBridgeTaskClaim | undefined,
  transition: MemoryBridgeTaskLifecycleRecord["transition"],
  reason: MemoryBridgeTaskLifecycleRecord["reason"],
  retryCount: number,
): MemoryBridgeTaskLifecycleRecord {
  const recordedAt = nowIso();
  const lastSeenAt = latestTimestamp(task.detected_at, claim?.claimed_at, claim?.claimed_until, recordedAt);
  return {
    correlation_id: task.correlation_id,
    transition,
    reason,
    target_capability: task.target_capability ?? task.original_target_capability ?? "any",
    first_seen_at: task.detected_at,
    last_seen_at: lastSeenAt,
    age_hours: ageHoursBetween(task.detected_at, lastSeenAt),
    recorded_at: recordedAt,
    retry_count: retryCount,
    claimed_by: claim?.claimed_by,
    claimed_at: claim?.claimed_at,
    claimed_until: claim?.claimed_until,
  };
}

function normalizeOpenLoopText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ðŸ”´ðŸŸ¡ðŸ”µðŸŸ¤]/g, " ")
    .replace(/\b[a-f0-9]{8}-[a-f0-9-]{27,}\b/gi, "<id>")
    .replace(/^need\s+/i, "")
    .replace(/^await\s+/i, "")
    .replace(/^user should\s+/i, "")
    .replace(/[^a-z0-9\s:]/gi, " ")
    .replace(/\b(to|for|the|a|an|fresh|immediate)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function openLoopCategory(text: string): "live" | "blocked_external" | "deferred" {
  const normalized = normalizeOpenLoopText(text);
  if (!normalized || normalized === "none") return "blocked_external";
  if (normalized.includes("deferred") || text.includes("ðŸŸ¤")) return "deferred";
  if (
    /need user|await user|scan|rotate|quota|billing|credits|provider|real browser|extension enabled|operator intervention|user direction required|requires/.test(normalized)
  ) {
    return "blocked_external";
  }
  return "live";
}

function inferOpenLoopOwner(text: string): string {
  const normalized = normalizeOpenLoopText(text);
  if (/whatsapp|scan|pairing|dispatch/.test(normalized)) return "whatsapp";
  if (/pi|voice|vad|camera/.test(normalized)) return "pi";
  if (/provider|quota|billing|credits|anthropic|openrouter/.test(normalized)) return "provider";
  if (/browser|extension|claude continuity/.test(normalized)) return "extension";
  if (/infra|path|cursor|kimi|gemini|auth profile|cli/.test(normalized)) return "infra";
  return "general";
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeOpenLoopText(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeOpenLoopText(right).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function normalizeOpenLoopBuckets(openLoops: string[]): {
  all: string[];
  live: string[];
  blocked_external: string[];
  deferred: string[];
} {
  const taskFailures: string[] = [];
  const deduped: string[] = [];

  for (const loopText of openLoops) {
    const trimmed = normalizeText(loopText);
    if (!trimmed || normalizeOpenLoopText(trimmed) === "none") continue;
    const taskFailureMatch = /^task:([a-f0-9-]+):investigate-failure$/i.exec(trimmed);
    if (taskFailureMatch) {
      taskFailures.push(taskFailureMatch[1]);
      continue;
    }

    const duplicate = deduped.some((existing) => jaccardSimilarity(existing, trimmed) >= 0.72);
    if (!duplicate) deduped.push(trimmed);
  }

  if (taskFailures.length > 0) {
    const preview = taskFailures.slice(0, 3).join(", ");
    deduped.push(`Investigate failed tasks (${taskFailures.length})${preview ? `: ${preview}` : ""}`);
  }

  const live: string[] = [];
  const blockedExternal: string[] = [];
  const deferred: string[] = [];
  for (const loopText of deduped) {
    const category = openLoopCategory(loopText);
    if (category === "live") live.push(loopText);
    else if (category === "blocked_external") blockedExternal.push(loopText);
    else deferred.push(loopText);
  }

  return {
    all: [...live, ...blockedExternal, ...deferred],
    live,
    blocked_external: blockedExternal,
    deferred,
  };
}

async function resolveHealthyTargetCapability(
  projectId: string,
  targetCapability: string,
  fallbackTargetCapability: string | undefined,
  rootDir: string,
): Promise<{ target_capability: string; original_target_capability?: string; routing_annotation?: string }> {
  const requested = normalizeText(targetCapability) || "any";
  if (requested === "any") {
    return { target_capability: requested };
  }

  const activeCapabilities = await handleListCapabilities(projectId, { rootDir });
  if (activeCapabilities.count === 0) {
    return { target_capability: requested };
  }

  if (activeCapabilities.capabilities.some((cap) => cap.fn === requested)) {
    return { target_capability: requested };
  }

  const fallback = normalizeText(fallbackTargetCapability);
  if (fallback && activeCapabilities.capabilities.some((cap) => cap.fn === fallback)) {
    return {
      target_capability: fallback,
      original_target_capability: requested,
      routing_annotation: `rerouted_from=${requested};reason=target_capability_unhealthy`,
    };
  }

  throw new Error(`TARGET_CAPABILITY_UNHEALTHY: no healthy worker lease for ${requested}`);
}

interface TaskCompletionHint {
  correlation_id: string;
  completed_at: string;
  completed_by?: string;
  output?: string;
  exit_code?: number;
}

function extractCompletionHint(event: MemoryBridgeEvent): TaskCompletionHint | null {
  let correlationId = "";

  if (event.task?.startsWith("task-complete/")) {
    correlationId = event.task.slice("task-complete/".length).trim();
  }

  if (!correlationId) {
    const taskResultFact = (event.facts ?? []).find((f) => f.startsWith("[TASK-RESULT] "));
    if (taskResultFact) {
      correlationId = taskResultFact.slice("[TASK-RESULT] ".length).trim();
    }
  }

  if (!correlationId) {
    const compactFact = (event.facts ?? []).find((f) => f.startsWith("task-complete:"));
    if (compactFact) {
      correlationId = compactFact.slice("task-complete:".length).trim();
    }
  }

  if (!correlationId) return null;

  const completedByFact = (event.facts ?? []).find((f) => f.startsWith("completed_by="));
  const outputFact = (event.facts ?? []).find((f) => f.startsWith("result.output="));
  const exitFact = (event.facts ?? []).find((f) => f.startsWith("result.exit_code="));
  const parsedExit = exitFact ? Number.parseInt(exitFact.slice("result.exit_code=".length), 10) : NaN;

  return {
    correlation_id: correlationId,
    completed_at: event.timestamp,
    completed_by: completedByFact ? completedByFact.slice("completed_by=".length) : undefined,
    output: outputFact ? outputFact.slice("result.output=".length) : undefined,
    exit_code: Number.isFinite(parsedExit) ? parsedExit : undefined,
  };
}

async function readTaskJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: T[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        parsed.push(JSON.parse(trimmed) as T);
      } catch {
        // Skip malformed lines so one bad row does not hide all task state.
        continue;
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

export async function handleListPendingTasks(
  projectId: string,
  options: { rootDir?: string; status_filter?: MemoryBridgeTaskStatus[] } = {},
): Promise<MemoryBridgeListTasksResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const { pendingTasksPath, taskClaimsPath, taskResultsPath, taskLifecyclePath, eventsPath } =
    resolveTaskPaths(root, normalizedProjectId);

  await handleSweepPendingTasks(normalizedProjectId, { rootDir: root });

  const [rawPending, claims, results, lifecycle, events] = await Promise.all([
    readTaskJsonl<MemoryBridgePendingTask>(pendingTasksPath),
    readTaskJsonl<MemoryBridgeTaskClaim>(taskClaimsPath),
    readTaskJsonl<MemoryBridgeTaskResult>(taskResultsPath),
    readTaskJsonl<MemoryBridgeTaskLifecycleRecord>(taskLifecyclePath),
    readTaskJsonl<MemoryBridgeEvent>(eventsPath),
  ]);

  // Build lookup maps â€” last write wins (in case of re-claim / re-complete)
  const claimMap = new Map<string, MemoryBridgeTaskClaim>();
  for (const c of claims) claimMap.set(c.correlation_id, c);
  const resultMap = new Map<string, MemoryBridgeTaskResult>();
  for (const r of results) resultMap.set(r.correlation_id, r);

  // Backward-compat fallback: infer completion from events if task-results entries
  // are missing (for older bridges or partial migrations).
  const completionHintMap = new Map<string, TaskCompletionHint>();
  for (const event of events) {
    const hint = extractCompletionHint(event);
    if (!hint) continue;
    completionHintMap.set(hint.correlation_id, hint);
  }

  // Deduplicate pending tasks by correlation_id â€” last detection wins
  const pendingMap = new Map<string, MemoryBridgePendingTask>();
  for (const t of rawPending) pendingMap.set(t.correlation_id, t);
  const lifecycleMap = new Map<string, MemoryBridgeTaskLifecycleRecord>();
  for (const record of lifecycle) lifecycleMap.set(record.correlation_id, record);

  const tasks: MemoryBridgeTaskListItem[] = [];

  for (const task of pendingMap.values()) {
    const result = resultMap.get(task.correlation_id);
    const completionHint = completionHintMap.get(task.correlation_id);
    const claim = claimMap.get(task.correlation_id);
    const claimIsActive = Boolean(claim && !isClaimExpired(claim));
    const lifecycleRecord = lifecycleMap.get(task.correlation_id);

    // Trust gate: claude-class tasks cannot be executed
    const trustBlocked =
      task.actor_trust_class === "claude" || task.actor_trust_class === undefined;

    // TTL gate: a task whose expires_at has passed and was never completed is
    // surfaced as "expired" so polling workers don't keep re-evaluating it.
    const isExpired =
      !result &&
      !completionHint &&
      typeof task.expires_at === "string" &&
      Date.parse(task.expires_at) < Date.now();

    let status: MemoryBridgeTaskStatus;
    if (result || completionHint) {
      status = "completed";
    } else if (lifecycleRecord?.transition === "dead_letter") {
      status = "dead_letter";
    } else if (lifecycleRecord?.transition === "archived") {
      status = "archived";
    } else if (isExpired) {
      status = "expired";
    } else if (trustBlocked) {
      status = "trust_blocked";
    } else if (claimIsActive) {
      status = "claimed";
    } else {
      status = "pending";
    }

    const item: MemoryBridgeTaskListItem = { ...task, status };
    if (claim) {
      item.claimed_by = claim.claimed_by;
      item.claimed_at = claim.claimed_at;
    }
    if (lifecycleRecord) {
      item.retry_count = lifecycleRecord.retry_count;
      item.lifecycle_reason = lifecycleRecord.reason;
    }
    if (result) {
      item.completed_by = result.completed_by;
      item.completed_at = result.completed_at;
      item.output = result.output;
      item.exit_code = result.exit_code;
    } else if (completionHint) {
      item.completed_by = completionHint.completed_by;
      item.completed_at = completionHint.completed_at;
      item.output = completionHint.output;
      item.exit_code = completionHint.exit_code;
    }
    tasks.push(item);
  }

  // Apply status filter if provided
  const filtered =
    options.status_filter && options.status_filter.length > 0
      ? tasks.filter((t) => options.status_filter!.includes(t.status))
      : tasks;

  // Sort: pending first, then claimed, trust_blocked, expired, completed last;
  // within group by detected_at desc
  const order: MemoryBridgeTaskStatus[] = [
    "pending",
    "claimed",
    "trust_blocked",
    "expired",
    "archived",
    "dead_letter",
    "completed",
  ];
  filtered.sort((a, b) => {
    const oi = order.indexOf(a.status) - order.indexOf(b.status);
    if (oi !== 0) return oi;
    return b.detected_at.localeCompare(a.detected_at);
  });

  const counts: Record<MemoryBridgeTaskStatus, number> = {
    pending: 0,
    claimed: 0,
    completed: 0,
    trust_blocked: 0,
    expired: 0,
    archived: 0,
    dead_letter: 0,
  };
  for (const t of tasks) counts[t.status] += 1;

  return {
    ok: true,
    op: "tasks/list",
    project_id: normalizedProjectId,
    tasks: filtered,
    counts,
  };
}

export async function handleSweepPendingTasks(
  projectId: string,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeSweepPendingTasksResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const {
    projectDir,
    pendingTasksPath,
    taskClaimsPath,
    taskResultsPath,
    taskLifecyclePath,
  } = resolveTaskPaths(root, normalizedProjectId);
  const taskLockPath = join(projectDir, "tasks.lock");

  await ensureDir(projectDir);
  const lockAcquired = await acquireProjectLock(taskLockPath);
  if (!lockAcquired) throw new Error("TASK_LOCK_BUSY");

  try {
    const [rawPending, claims, results, lifecycle] = await Promise.all([
      readTaskJsonl<MemoryBridgePendingTask>(pendingTasksPath),
      readTaskJsonl<MemoryBridgeTaskClaim>(taskClaimsPath),
      readTaskJsonl<MemoryBridgeTaskResult>(taskResultsPath),
      readTaskJsonl<MemoryBridgeTaskLifecycleRecord>(taskLifecyclePath),
    ]);

    const pendingMap = new Map<string, MemoryBridgePendingTask>();
    for (const task of rawPending) pendingMap.set(task.correlation_id, task);
    const claimMap = new Map<string, MemoryBridgeTaskClaim>();
    for (const claim of claims) claimMap.set(claim.correlation_id, claim);
    const resultIds = new Set(results.map((result) => result.correlation_id));
    const lifecycleByCorrelation = new Map<string, MemoryBridgeTaskLifecycleRecord[]>();
    for (const record of lifecycle) {
      const entries = lifecycleByCorrelation.get(record.correlation_id) ?? [];
      entries.push(record);
      lifecycleByCorrelation.set(record.correlation_id, entries);
    }

    const archived: MemoryBridgeTaskLifecycleRecord[] = [];
    const requeued: MemoryBridgeTaskLifecycleRecord[] = [];
    const deadLettered: MemoryBridgeTaskLifecycleRecord[] = [];

    for (const task of pendingMap.values()) {
      if (resultIds.has(task.correlation_id)) continue;

      const records = lifecycleByCorrelation.get(task.correlation_id) ?? [];
      const latestRecord = records.at(-1);
      if (latestRecord?.transition === "archived" || latestRecord?.transition === "dead_letter") {
        continue;
      }

      const claim = claimMap.get(task.correlation_id);
      const taskExpired =
        typeof task.expires_at === "string" &&
        Number.isFinite(Date.parse(task.expires_at)) &&
        Date.parse(task.expires_at) < Date.now();

      if (!claim && taskExpired) {
        archived.push(buildLifecycleRecord(task, undefined, "archived", "stale_expired_no_worker_claim", 0));
        continue;
      }

      if (claim && !claim.claimed_until && taskExpired) {
        archived.push(buildLifecycleRecord(task, claim, "archived", "stale_ttl_elapsed", 0));
        continue;
      }

      if (!claim || !isClaimExpired(claim)) continue;

      const handledThisExpiry = records.some(
        (record) => record.claimed_until && record.claimed_until === claim.claimed_until,
      );
      if (handledThisExpiry) continue;

      const priorExpiredClaims = new Set(
        records
          .filter((record) => record.reason === "stale_ttl_elapsed" && record.claimed_until)
          .map((record) => record.claimed_until as string),
      );
      const retryCount = priorExpiredClaims.size + 1;
      const transition = priorExpiredClaims.size >= 1 ? "dead_letter" : "requeued";
      const nextRecord = buildLifecycleRecord(task, claim, transition, "stale_ttl_elapsed", retryCount);
      if (transition === "dead_letter") {
        deadLettered.push(nextRecord);
      } else {
        requeued.push(nextRecord);
      }
    }

    const nextRecords = [...archived, ...requeued, ...deadLettered];
    if (nextRecords.length > 0) {
      await appendFile(taskLifecyclePath, `${nextRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    }

    return {
      ok: true,
      op: "tasks/sweep",
      project_id: normalizedProjectId,
      archived,
      requeued,
      dead_lettered: deadLettered,
    };
  } finally {
    await releaseProjectLock(taskLockPath);
  }
}

export async function handleClaimTask(
  correlationId: string,
  claimedBy: string,
  projectId: string,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeClaimTaskResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const { projectDir, pendingTasksPath, taskClaimsPath, taskResultsPath, taskFailuresPath } =
    resolveTaskPaths(root, normalizedProjectId);
  const taskLockPath = join(projectDir, "tasks.lock");

  await ensureDir(projectDir);

  const lockAcquired = await acquireProjectLock(taskLockPath);
  if (!lockAcquired) throw new Error("TASK_LOCK_BUSY");

  try {

    // Verify task exists and is claimable
    const [rawPending, claims, results] = await Promise.all([
      readTaskJsonl<MemoryBridgePendingTask>(pendingTasksPath),
      readTaskJsonl<MemoryBridgeTaskClaim>(taskClaimsPath),
      readTaskJsonl<MemoryBridgeTaskResult>(taskResultsPath),
    ]);

    const task = rawPending.filter((t) => t.correlation_id === correlationId).at(-1);
    if (!task) {
      await appendTaskFailureRecord(taskFailuresPath, {
        correlation_id: correlationId,
        stage: "claim",
        reason: "task_not_found",
        actor: claimedBy,
        timestamp: nowIso(),
      });
      throw new Error(`TASK_NOT_FOUND: ${correlationId}`);
    }

    if (task.actor_trust_class === "claude" || task.actor_trust_class === undefined) {
      throw new Error(
        `TASK_TRUST_BLOCKED: task ${correlationId} has actor_trust_class=${task.actor_trust_class}. Only system/user tasks are executable.`,
      );
    }

    const alreadyCompleted = results.some((r) => r.correlation_id === correlationId);
    if (alreadyCompleted) {
      await appendTaskFailureRecord(taskFailuresPath, {
        correlation_id: correlationId,
        stage: "claim",
        reason: "task_already_completed",
        actor: claimedBy,
        timestamp: nowIso(),
      });
      throw new Error(`TASK_ALREADY_COMPLETED: ${correlationId}`);
    }

    const existing = claims.filter((c: MemoryBridgeTaskClaim) => c.correlation_id === correlationId).at(-1);
    if (existing) {
      if (!isClaimExpired(existing) && existing.claimed_by !== claimedBy) {
        await appendTaskFailureRecord(taskFailuresPath, {
          correlation_id: correlationId,
          stage: "claim",
          reason: "task_already_claimed",
          actor: claimedBy,
          timestamp: nowIso(),
          detail: `claimed_by=${existing.claimed_by}`,
        });
        throw new Error(
          `TASK_ALREADY_CLAIMED: ${correlationId} is already claimed by ${existing.claimed_by}`,
        );
      }
      if (!isClaimExpired(existing) && existing.claimed_by === claimedBy) {
        const claimedAt = nowIso();
        const claimTtlMinutes = resolveTaskClaimTtlMinutes();
        const claimedUntil = new Date(Date.now() + claimTtlMinutes * 60 * 1000).toISOString();
        const renewedClaim: MemoryBridgeTaskClaim = {
          correlation_id: correlationId,
          claimed_by: claimedBy,
          claimed_at: claimedAt,
          claimed_until: claimedUntil,
        };
        await appendFile(taskClaimsPath, `${JSON.stringify(renewedClaim)}\n`, "utf8");
        return {
          ok: true,
          op: "tasks/claim",
          project_id: normalizedProjectId,
          correlation_id: correlationId,
          claimed_by: renewedClaim.claimed_by,
          claimed_at: renewedClaim.claimed_at,
          claimed_until: renewedClaim.claimed_until,
        };
      }
    }

    const claimedAt = nowIso();
    const claimTtlMinutes = resolveTaskClaimTtlMinutes();
    const claimedUntil = new Date(Date.now() + claimTtlMinutes * 60 * 1000).toISOString();
    const claim: MemoryBridgeTaskClaim = {
      correlation_id: correlationId,
      claimed_by: claimedBy,
      claimed_at: claimedAt,
      claimed_until: claimedUntil,
    };
    await appendFile(
      taskClaimsPath,
      `${JSON.stringify(claim)}\n`,
      "utf8",
    );

    return {
      ok: true,
      op: "tasks/claim",
      project_id: normalizedProjectId,
      correlation_id: correlationId,
      claimed_by: claimedBy,
      claimed_at: claimedAt,
      claimed_until: claimedUntil,
    };
  } finally {
    await releaseProjectLock(taskLockPath);
  }
}

export async function handleCompleteTask(
  correlationId: string,
  completedBy: string,
  output: string,
  exitCode: number,
  projectId: string,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeCompleteTaskResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const { projectDir, pendingTasksPath, taskClaimsPath, taskResultsPath, taskFailuresPath } = resolveTaskPaths(root, normalizedProjectId);
  const taskLockPath = join(projectDir, "tasks.lock");

  await ensureDir(projectDir);

  const lockAcquired = await acquireProjectLock(taskLockPath);
  if (!lockAcquired) throw new Error("TASK_LOCK_BUSY");

  try {

    const [rawPending, claims, results] = await Promise.all([
      readTaskJsonl<MemoryBridgePendingTask>(pendingTasksPath),
      readTaskJsonl<MemoryBridgeTaskClaim>(taskClaimsPath),
      readTaskJsonl<MemoryBridgeTaskResult>(taskResultsPath),
    ]);

    const task = rawPending.filter((t) => t.correlation_id === correlationId).at(-1);
    if (!task) {
      await appendTaskFailureRecord(taskFailuresPath, {
        correlation_id: correlationId,
        stage: "complete",
        reason: "task_not_found",
        actor: completedBy,
        timestamp: nowIso(),
      });
      throw new Error(`TASK_NOT_FOUND: ${correlationId}`);
    }

    const alreadyCompleted = results.some((r) => r.correlation_id === correlationId);
    if (alreadyCompleted) {
      await appendTaskFailureRecord(taskFailuresPath, {
        correlation_id: correlationId,
        stage: "complete",
        reason: "task_already_completed",
        actor: completedBy,
        timestamp: nowIso(),
      });
      throw new Error(`TASK_ALREADY_COMPLETED: ${correlationId}`);
    }

    const claim = claims.filter((c) => c.correlation_id === correlationId).at(-1);
    if (!claim) {
      await appendTaskFailureRecord(taskFailuresPath, {
        correlation_id: correlationId,
        stage: "complete",
        reason: "task_not_claimed",
        actor: completedBy,
        timestamp: nowIso(),
      });
      throw new Error(`TASK_NOT_CLAIMED: ${correlationId}`);
    }
    if (isClaimExpired(claim)) {
      await appendTaskFailureRecord(taskFailuresPath, {
        correlation_id: correlationId,
        stage: "complete",
        reason: "task_claim_expired",
        actor: completedBy,
        timestamp: nowIso(),
      });
      throw new Error(`TASK_CLAIM_EXPIRED: ${correlationId}`);
    }
    if (claim.claimed_by !== completedBy) {
      await appendTaskFailureRecord(taskFailuresPath, {
        correlation_id: correlationId,
        stage: "complete",
        reason: "task_claim_ownership_mismatch",
        actor: completedBy,
        timestamp: nowIso(),
        detail: `claimed_by=${claim.claimed_by}`,
      });
      throw new Error(
        `TASK_CLAIM_OWNERSHIP_MISMATCH: ${correlationId} is claimed by ${claim.claimed_by}, not ${completedBy}`,
      );
    }

    const completedAt = nowIso();
    const result: MemoryBridgeTaskResult = {
      correlation_id: correlationId,
      completed_by: completedBy,
      completed_at: completedAt,
      output,
      exit_code: exitCode,
    };
    await appendFile(
      taskResultsPath,
      `${JSON.stringify(result)}\n`,
      "utf8",
    );

    // Write a result event to the memory store so the result is auditable and searchable
    const eventsPath = join(projectDir, "events.jsonl");
    const summaryPath = join(projectDir, "summary.json");

    const currentSummary = await readJsonFile<MemoryBridgeSummary>(summaryPath, buildEmptySummary());
    const timestamp = nowIso();
    const resultEvent: MemoryBridgeEvent = {
      timestamp,
      project_id: normalizedProjectId,
      chatbot: "aik-task-executor",
      thread_id: "tasks",
      task: `task-complete/${correlationId}`,
      summary: `Task completed: ${correlationId} by ${completedBy} (exit ${exitCode})`,
      facts: [
        `[TASK-RESULT] ${correlationId}`,
        `task.status=completed`,
        `result.output=${output.slice(0, 500)}`,
        `result.exit_code=${exitCode}`,
        `completed_by=${completedBy}`,
      ],
      decisions: [`correlation_id=${correlationId}`],
      open_loops: [],
      artifacts: [],
      confidence: 0.70,
      ttl_days: 30,
      refuted_by: [],
      source_trust: 0.80,
      actor: "aik-task-executor",
      actor_trust_class: "system",
      fact_status: "verified",
      input_origin: "unknown",
    };

    const nextSummary: MemoryBridgeSummary = {
      ...currentSummary,
      facts: mergeUnique(currentSummary.facts, resultEvent.facts),
      updated_at: timestamp,
      last_summary: resultEvent.summary,
    };

    await writeJsonFile(summaryPath, nextSummary);
    await appendEvent(eventsPath, resultEvent);

    return {
      ok: true,
      op: "tasks/complete",
      project_id: normalizedProjectId,
      correlation_id: correlationId,
      completed_by: completedBy,
      completed_at: completedAt,
    };
  } finally {
    await releaseProjectLock(taskLockPath);
  }
}

// ---------------------------------------------------------------------------
// Capability Registry â€” agents advertise what skills they can execute
//
// File: capabilities.jsonl â€” append-only; latest entry per (agent_id, fn) wins.
// TTL: entries older than ttl_seconds are excluded from GET results.
// Trust gate: only system/user actor_trust_class agents may register.
// ---------------------------------------------------------------------------

export interface MemoryBridgeCapability {
  agent_id: string;
  fn: string;
  endpoint: string;
  description: string;
  registered_at: string;
  ttl_seconds: number;
  actor_trust_class: MemoryBridgeActorTrustClass;
}

export interface MemoryBridgeRegisterCapabilityResult {
  ok: true;
  op: "capabilities/register";
  project_id: string;
  agent_id: string;
  fn: string;
  registered_at: string;
}

export interface MemoryBridgeListCapabilitiesResult {
  ok: true;
  op: "capabilities/list";
  project_id: string;
  capabilities: MemoryBridgeCapability[];
  count: number;
}

export async function handleRegisterCapability(
  capability: Omit<MemoryBridgeCapability, "registered_at">,
  projectId: string,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeRegisterCapabilityResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const projectDir = join(root, "projects", normalizedProjectId);
  const capabilitiesPath = join(projectDir, "capabilities.jsonl");

  await ensureDir(projectDir);

  if (capability.actor_trust_class === "claude") {
    throw new Error(
      "CAPABILITY_TRUST_BLOCKED: claude-class agents cannot register execution capabilities.",
    );
  }

  const registeredAt = nowIso();
  const entry: MemoryBridgeCapability = { ...capability, registered_at: registeredAt };
  await appendFile(capabilitiesPath, `${JSON.stringify(entry)}\n`, "utf8");

  return {
    ok: true,
    op: "capabilities/register",
    project_id: normalizedProjectId,
    agent_id: capability.agent_id,
    fn: capability.fn,
    registered_at: registeredAt,
  };
}

export async function handleListCapabilities(
  projectId: string,
  options: { rootDir?: string; fn?: string } = {},
): Promise<MemoryBridgeListCapabilitiesResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(projectId, DEFAULT_PROJECT_ID);
  const capabilitiesPath = join(
    root,
    "projects",
    normalizedProjectId,
    "capabilities.jsonl",
  );

  const all = await readTaskJsonl<MemoryBridgeCapability>(capabilitiesPath);

  // Deduplicate: latest entry per (agent_id, fn) wins
  const capMap = new Map<string, MemoryBridgeCapability>();
  for (const cap of all) capMap.set(`${cap.agent_id}:${cap.fn}`, cap);

  const now = Date.now();
  let active = [...capMap.values()].filter((cap) => {
    const age = (now - new Date(cap.registered_at).getTime()) / 1000;
    return age <= cap.ttl_seconds;
  });

  if (options.fn) {
    const fn = options.fn;
    active = active.filter((cap) => cap.fn === fn);
  }

  active.sort((a, b) => b.registered_at.localeCompare(a.registered_at));

  return {
    ok: true,
    op: "capabilities/list",
    project_id: normalizedProjectId,
    capabilities: active,
    count: active.length,
  };
}

// ---------------------------------------------------------------------------
// Neural Bus â€” memory_invoke: direct task creation
//
// Allows any MCP caller to submit a task directly to the pending-tasks queue
// without going through the metabolic detection loop.
// Created tasks use actor_trust_class="system" by default so VS Code can pick
// them up. The trust gate in handleClaimTask/handleListPendingTasks still
// applies â€” tasks submitted with actor_trust_class="claude" will be flagged
// as trust_blocked and will NOT be executed by the VS Code executor.
// ---------------------------------------------------------------------------

export interface MemoryBridgeInvokeTaskResult {
  ok: true;
  op: "tasks/invoke";
  project_id: string;
  correlation_id: string;
  target_capability: string;
  original_target_capability?: string;
  detected_at: string;
  expires_at: string | null;
}

export async function handleInvokeTask(
  params: {
    project_id?: string;
    target_capability: string;
    fallback_target_capability?: string;
    skill?: string;
    input: string;
    priority?: number;
    ttl_hours?: number;
    actor?: string;
    actor_trust_class?: MemoryBridgeActorTrustClass;
    metadata?: Record<string, unknown>;
  },
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeInvokeTaskResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const normalizedProjectId = normalizeId(params.project_id, DEFAULT_PROJECT_ID);
  const { projectDir, pendingTasksPath } = resolveTaskPaths(root, normalizedProjectId);

  await ensureDir(projectDir);

  const routedCapability = await resolveHealthyTargetCapability(
    normalizedProjectId,
    params.target_capability,
    params.fallback_target_capability,
    root,
  );

  const correlationId = randomUUID();
  const detectedAt = nowIso();
  const ttlHours = params.ttl_hours ?? 24;
  const expiresAt = ttlHours > 0
    ? new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString()
    : null;

  // Default to "system" trust so VS Code executor can pick it up.
  // Callers may override to "user" for highest priority.
  const actorTrustClass = params.actor_trust_class ?? "system";

  const task: MemoryBridgePendingTask = {
    correlation_id: correlationId,
    task_type: "direct-invoke",
    event_id: correlationId,
    detected_at: detectedAt,
    actor_trust_class: actorTrustClass,
    fact_status: "observed",
    confidence: 0.80,
    caller_agent: params.actor ?? "mcp-caller",
    raw_task_fact: params.input,
    target_capability: routedCapability.target_capability,
    skill: params.skill,
    input: params.input,
    priority: params.priority ?? 5,
    ttl_hours: ttlHours,
    expires_at: expiresAt ?? undefined,
    created_by: params.actor ?? "mcp-caller",
    metadata: params.metadata ? { ...params.metadata } : undefined,
    original_target_capability: routedCapability.original_target_capability,
    routing_annotation: routedCapability.routing_annotation,
  };

  await appendFile(pendingTasksPath, `${JSON.stringify(task)}\n`, "utf8");

  return {
    ok: true,
    op: "tasks/invoke",
    project_id: normalizedProjectId,
    correlation_id: correlationId,
    target_capability: routedCapability.target_capability,
    original_target_capability: routedCapability.original_target_capability,
    detected_at: detectedAt,
    expires_at: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Neural Bus â€” Skill Registry
//
// Skills are stored as markdown files under /data/skills/{name}.md.
// Any agent can fetch a skill by name. The VS Code AIK extension registers
// skills from ~/.config/Code/User/prompts/*.prompt.md on startup.
// ---------------------------------------------------------------------------

export interface MemoryBridgeFetchSkillResult {
  ok: true;
  op: "skills/fetch";
  name: string;
  content: string;
  size_bytes: number;
}

export interface MemoryBridgeRegisterSkillResult {
  ok: true;
  op: "skills/register";
  name: string;
  size_bytes: number;
  registered_at: string;
}

export async function handleFetchSkill(
  name: string,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeFetchSkillResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  const skillPath = join(root, "skills", `${safeName}.md`);

  const content = await readFile(skillPath, "utf8");
  return {
    ok: true,
    op: "skills/fetch",
    name: safeName,
    content,
    size_bytes: Buffer.byteLength(content, "utf8"),
  };
}

export async function handleRegisterSkill(
  name: string,
  content: string,
  options: { rootDir?: string } = {},
): Promise<MemoryBridgeRegisterSkillResult> {
  const root = options.rootDir ?? resolveMemoryBridgeRoot();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  const skillsDir = join(root, "skills");
  const skillPath = join(skillsDir, `${safeName}.md`);

  await mkdir(skillsDir, { recursive: true });
  await writeFile(skillPath, content, "utf8");

  return {
    ok: true,
    op: "skills/register",
    name: safeName,
    size_bytes: Buffer.byteLength(content, "utf8"),
    registered_at: nowIso(),
  };
}
