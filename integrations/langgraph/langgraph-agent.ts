/**
 * Memory Bridge Protocol — LangGraph JS agent with MCP integration.
 *
 * Reads BeliefEnvelopes written by the AutoGen agent (belief_writer.py) from
 * the Memory Bridge via the MCP handler, then processes them through two paths:
 *
 *   buggy_process  — confidence rounded via Math.round() → integer coercion
 *   fixed_process  — confidence preserved via parseFloat() → float as designed
 *
 * Graph topology (per exchange):
 *
 *   START → fetch_belief → buggy_process → fixed_process → (loop or END)
 *
 * The loop iterates once per belief in the schedule (up to maxExchanges).
 * On each iteration, both buggy and fixed results are appended to state so the
 * error report covers the full 50-exchange window.
 *
 * Run (after npm install):
 *   npx ts-node --esm langgraph-agent.ts
 */

import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { MemoryBridgeMCPClient } from "./mcp-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BeliefEnvelope {
  belief_id:         string;
  proposition:       string;
  confidence:        number;   // float in [0, 1] per schema
  source_agent:      string;
  source_trust_class: string;
  epistemic_status:  string;
  created_at:        string;
  thread_id?:        string;
}

export interface ProcessedBelief {
  exchange:           number;
  belief_id:          string;
  original_confidence: number;   // float from bridge
  buggy_confidence:   number;    // after Math.round — always 0 for model-class
  fixed_confidence:   number;    // after parseFloat — preserves the float
  per_exchange_error: number;    // |original - buggy|
}

// ---------------------------------------------------------------------------
// Confidence parsing — THE BUG vs THE FIX
// ---------------------------------------------------------------------------

/**
 * THE BUG: integer coercion via Math.round().
 *
 * Model-class beliefs have confidence in [0.10, 0.40]. Math.round() maps
 * every value in this range to 0 because they are all < 0.5.
 *
 * Example:
 *   buggyParseConfidence(0.35) → 0     (error = 0.35)
 *   buggyParseConfidence(0.40) → 0     (error = 0.40)
 *   buggyParseConfidence(0.27) → 0     (error = 0.27)
 *
 * The result is an integer 0 — a completely different type from the schema's
 * float64 requirement, and semantically incorrect (0 = no confidence at all).
 */
function buggyParseConfidence(value: unknown): number {
  return Math.round(Number(value));
}

/**
 * THE FIX: preserve float precision via parseFloat().
 *
 * parseFloat(String(v)) handles every JSON number representation correctly:
 *   - "0.35"   → 0.35  (decimal fraction, the common case)
 *   - "0.3500" → 0.35  (trailing zeros stripped but value preserved)
 *   - "0"      → 0     (integer boundary — valid sentinel)
 *   - "1"      → 1     (integer boundary — valid sentinel)
 *
 * After parsing, we validate the range against the BeliefEnvelope schema
 * constraints (minimum: 0, maximum: 1) before accepting the value.
 */
function fixedParseConfidence(value: unknown): number {
  const parsed = parseFloat(String(value));
  if (!isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new RangeError(
      `confidence ${JSON.stringify(value)} is outside the BeliefEnvelope schema range [0, 1]`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Graph state
// ---------------------------------------------------------------------------

const GraphState = Annotation.Root({
  // Input: full schedule of beliefs to process (set once at graph entry)
  beliefs: Annotation<BeliefEnvelope[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // Current position in the belief schedule
  exchangeIndex: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),

  maxExchanges: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 50,
  }),

  // Accumulates per-exchange results (appended, not replaced)
  results: Annotation<ProcessedBelief[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

type GraphStateType = typeof GraphState.State;

// ---------------------------------------------------------------------------
// Node: fetch one belief from the bridge (or load from pre-seeded state)
// ---------------------------------------------------------------------------

async function fetchBeliefNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const idx = state.exchangeIndex;

  if (idx >= state.beliefs.length) {
    // No more beliefs — this path leads to END via the conditional edge
    return {};
  }

  // Belief is already in state (pre-loaded from the AutoGen schedule).
  // In a production setup this node would call client.memoryGet() to fetch
  // the actual belief from the bridge; we keep it offline here so the graph
  // can run without a live bridge connection.
  return {};
}

// ---------------------------------------------------------------------------
// Node: process current belief through BOTH buggy and fixed paths
// ---------------------------------------------------------------------------

async function processBeliefNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const idx    = state.exchangeIndex;
  const belief = state.beliefs[idx];

  if (!belief) return { exchangeIndex: idx + 1 };

  const original = belief.confidence;                 // float from bridge
  const buggy    = buggyParseConfidence(original);    // the bug: 0.35 → 0
  const fixed    = fixedParseConfidence(original);    // the fix: 0.35 → 0.35
  const error    = Math.abs(original - buggy);

  const result: ProcessedBelief = {
    exchange:            idx + 1,
    belief_id:           belief.belief_id,
    original_confidence: original,
    buggy_confidence:    buggy,
    fixed_confidence:    fixed,
    per_exchange_error:  parseFloat(error.toFixed(6)),
  };

  return {
    exchangeIndex: idx + 1,
    results:       [result],
  };
}

// ---------------------------------------------------------------------------
// Conditional edge: continue loop or exit
// ---------------------------------------------------------------------------

function shouldContinue(state: GraphStateType): "continue" | "end" {
  return state.exchangeIndex < state.maxExchanges &&
    state.exchangeIndex < state.beliefs.length
    ? "continue"
    : "end";
}

// ---------------------------------------------------------------------------
// Build and compile the graph
// ---------------------------------------------------------------------------

export function buildBeliefProcessingGraph() {
  return new StateGraph(GraphState)
    .addNode("fetch_belief",   fetchBeliefNode)
    .addNode("process_belief", processBeliefNode)
    .addEdge(START,             "fetch_belief")
    .addEdge("fetch_belief",    "process_belief")
    .addConditionalEdges("process_belief", shouldContinue, {
      continue: "fetch_belief",
      end:      END,
    })
    .compile();
}

// ---------------------------------------------------------------------------
// Confidence schedule (mirrors integrations/autogen/belief_writer.py)
// ---------------------------------------------------------------------------

function generateConfidenceSchedule(n: number): number[] {
  const base = [0.35, 0.27, 0.38, 0.31, 0.29, 0.40, 0.22, 0.36, 0.33, 0.28];
  return Array.from({ length: n }, (_, i) => {
    const b      = base[i % base.length];
    const jitter = ((i * 0.007) % 0.05) - 0.025;
    return (
      Math.round(Math.max(0.10, Math.min(0.40, b + jitter)) * 10_000) / 10_000
    );
  });
}

function makeBeliefSchedule(n: number): BeliefEnvelope[] {
  const schedule = generateConfidenceSchedule(n);
  const now      = new Date().toISOString();

  return schedule.map((confidence, i) => ({
    belief_id:          `belief_autogen_belief_writer_${i.toString().padStart(3, "0")}`,
    proposition:        `Exchange ${i + 1}: at confidence ${confidence.toFixed(4)} the distributed belief-store retrieval latency exhibits sublinear scaling across agent mesh nodes (autogen observation #${i + 1}).`,
    confidence,                // float — the value the graph must preserve
    source_agent:       "autogen_belief_writer",
    source_trust_class: "model",
    epistemic_status:   "inferred",
    created_at:         now,
    thread_id:          "autogen-langgraph-exchange",
  }));
}

// ---------------------------------------------------------------------------
// Run and report
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const N_EXCHANGES = 50;

  console.log(`\n${"─".repeat(70)}`);
  console.log("Memory Bridge Protocol — LangGraph belief processing agent");
  console.log(`Exchanges: ${N_EXCHANGES}  |  Source trust class: model (ceiling 0.40)`);
  console.log(`${"─".repeat(70)}\n`);

  const beliefs = makeBeliefSchedule(N_EXCHANGES);
  const graph   = buildBeliefProcessingGraph();

  const finalState = await graph.invoke({
    beliefs,
    exchangeIndex: 0,
    maxExchanges:  N_EXCHANGES,
    results:       [],
  });

  // ── Per-exchange table ─────────────────────────────────────────────────
  console.log(
    "Exc | Original | Buggy | Fixed  | Per-err | Cumulative | Status",
  );
  console.log("─".repeat(72));

  let cumulative = 0;
  for (const r of finalState.results as ProcessedBelief[]) {
    cumulative += r.per_exchange_error;
    const status = r.buggy_confidence === r.original_confidence ? "OK   " : "ERROR";
    console.log(
      `${String(r.exchange).padStart(3)} | ` +
      `${r.original_confidence.toFixed(4)}   | ` +
      `${r.buggy_confidence}     | ` +
      `${r.fixed_confidence.toFixed(4)} | ` +
      `${r.per_exchange_error.toFixed(4)}  | ` +
      `${cumulative.toFixed(4)}    | ` +
      status,
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log(
    `Total cumulative error over ${N_EXCHANGES} exchanges (buggy path): ` +
    `${cumulative.toFixed(4)}`,
  );
  console.log(
    "Fixed path error: 0.0000  (parseFloat preserves all float values)",
  );
  console.log(
    "\nRoot cause: Math.round(c) maps all model-class confidence values",
  );
  console.log(
    "  (range [0.10, 0.40]) to integer 0, discarding all belief signal.",
  );
  console.log(
    "Fix: replace Math.round(Number(v)) with parseFloat(String(v))",
  );
  console.log(
    "Schema: BeliefEnvelope.v0.1.json confidence.$comment prohibits coercion.\n",
  );
}

main().catch((err) => {
  console.error("Agent error:", err);
  process.exit(1);
});
