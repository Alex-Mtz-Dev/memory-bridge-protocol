/**
 * Cumulative float-to-int error predictor — no external dependencies.
 *
 * Predicts the confidence error that accumulates over 50 AutoGen → LangGraph
 * exchanges when the JS agent uses Math.round() instead of parseFloat() to
 * read the confidence field of a BeliefEnvelope.
 *
 * Run (TypeScript):   npx ts-node --esm error-analysis.ts
 * Run (compiled JS):  node dist/error-analysis.js
 * Run (Bun):          bun run error-analysis.ts
 *
 * Why this matters
 * ────────────────
 * The BeliefEnvelope schema defines confidence as a float in [0, 1].
 * Model-class actors (autogen_belief_writer, source_trust_class = "model")
 * are capped at 0.40 by the bridge. Every value in [0.10, 0.40] satisfies:
 *
 *     Math.round(v) = 0  for all v < 0.5
 *
 * So the buggy agent maps EVERY model-class confidence to integer 0, which
 * the downstream system interprets as "no confidence at all". The error is
 * not a rounding artefact — it is a complete loss of belief signal.
 *
 * Cumulative error formula
 * ────────────────────────
 *     error_i       = |original_i − Math.round(original_i)|
 *                   = original_i           (since Math.round(c) = 0 for c < 0.5)
 *     cumulative(n) = Σ error_i  for i = 1..n
 *
 * For the schedule defined below (mean ≈ 0.317):
 *     cumulative(50) = 15.8950 confidence units  (verified by Node.js run)
 *
 * After the fix (parseFloat):
 *     error_i = 0  for all i  →  cumulative(50) = 0.0000
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExchangeRecord {
  exchange:            number;
  original_confidence: number;   // float written by AutoGen
  buggy_confidence:    number;   // after Math.round (the bug)
  fixed_confidence:    number;   // after parseFloat (the fix)
  per_exchange_error:  number;   // |original − buggy|
  cumulative_error:    number;   // running total
}

interface ErrorReport {
  records:          ExchangeRecord[];
  total_exchanges:  number;
  cumulative_error: number;
  mean_error:       number;
  max_error:        number;
  min_error:        number;
  zero_confidence_exchanges: number;   // how many were mapped to 0 by the bug
  signal_loss_pct:  number;            // % of original signal destroyed
}

// ---------------------------------------------------------------------------
// Confidence schedule
//
// Must be kept in sync with integrations/autogen/belief_writer.py
//   simulate_confidence_schedule() and
// integrations/langgraph/langgraph-agent.ts
//   generateConfidenceSchedule()
//
// All values are in [0.10, 0.40] — the model-class operating range.
// ---------------------------------------------------------------------------

function generateConfidenceSchedule(n: number): number[] {
  const base = [0.35, 0.27, 0.38, 0.31, 0.29, 0.40, 0.22, 0.36, 0.33, 0.28];
  return Array.from({ length: n }, (_, i) => {
    const b      = base[i % base.length];
    const jitter = ((i * 0.007) % 0.05) - 0.025;
    // Round to 4 decimal places to match Python's round(..., 4)
    return Math.round(Math.max(0.10, Math.min(0.40, b + jitter)) * 10_000) / 10_000;
  });
}

// ---------------------------------------------------------------------------
// Error predictor
// ---------------------------------------------------------------------------

function predictCumulativeError(confidences: number[]): ErrorReport {
  const records: ExchangeRecord[] = [];
  let cumulative   = 0;
  let signalSum    = 0;
  let errorSum     = 0;
  let maxErr       = 0;
  let minErr       = Infinity;
  let zeroCount    = 0;

  for (let i = 0; i < confidences.length; i++) {
    const original = confidences[i];
    // THE BUG:  integer coercion
    const buggy    = Math.round(original);
    // THE FIX:  float preservation
    const fixed    = parseFloat(String(original));

    const error    = Math.abs(original - buggy);
    cumulative    += error;
    signalSum     += original;
    errorSum      += error;
    if (error > maxErr)    maxErr  = error;
    if (error < minErr)    minErr  = error;
    if (buggy === 0 && original > 0) zeroCount++;

    records.push({
      exchange:            i + 1,
      original_confidence: original,
      buggy_confidence:    buggy,
      fixed_confidence:    fixed,
      per_exchange_error:  parseFloat(error.toFixed(6)),
      cumulative_error:    parseFloat(cumulative.toFixed(6)),
    });
  }

  return {
    records,
    total_exchanges:           confidences.length,
    cumulative_error:          parseFloat(cumulative.toFixed(6)),
    mean_error:                parseFloat((errorSum / confidences.length).toFixed(6)),
    max_error:                 parseFloat(maxErr.toFixed(6)),
    min_error:                 parseFloat(minErr.toFixed(6)),
    zero_confidence_exchanges: zeroCount,
    signal_loss_pct:           parseFloat(((errorSum / signalSum) * 100).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Console report
// ---------------------------------------------------------------------------

function printReport(report: ErrorReport): void {
  const W = 78;
  const hr = "─".repeat(W);

  console.log("\n" + hr);
  console.log("Memory Bridge Protocol — Float-to-Int Confidence Error Analysis");
  console.log(`Exchanges: ${report.total_exchanges}  |  Source trust class: model (bridge ceiling: 0.40)`);
  console.log(hr);

  // Per-exchange table
  console.log(
    "Exc │ Original │ Buggy │ Fixed  │ Per-err │ Cumulative │ Loss",
  );
  console.log("────┼──────────┼───────┼────────┼─────────┼────────────┼──────");

  for (const r of report.records) {
    const loss = r.per_exchange_error > 0 ? "✗ LOST" : "✓ OK";
    console.log(
      `${String(r.exchange).padStart(3)} │ ` +
      `${r.original_confidence.toFixed(4)}   │ ` +
      `${String(r.buggy_confidence).padEnd(5)} │ ` +
      `${r.fixed_confidence.toFixed(4)} │ ` +
      `${r.per_exchange_error.toFixed(4)}  │ ` +
      `${r.cumulative_error.toFixed(4)}     │ ` +
      loss,
    );
  }

  // Summary
  console.log("\n" + hr);
  console.log("SUMMARY");
  console.log(hr);
  console.log(`Total exchanges:                ${report.total_exchanges}`);
  console.log(`Exchanges with signal loss:     ${report.zero_confidence_exchanges} / ${report.total_exchanges} (${((report.zero_confidence_exchanges / report.total_exchanges) * 100).toFixed(1)}%)`);
  console.log(`Cumulative error (buggy path):  ${report.cumulative_error.toFixed(4)} confidence units`);
  console.log(`Mean error per exchange:        ${report.mean_error.toFixed(4)}`);
  console.log(`Max error (single exchange):    ${report.max_error.toFixed(4)}`);
  console.log(`Min error (single exchange):    ${report.min_error.toFixed(4)}`);
  console.log(`Signal destroyed:               ${report.signal_loss_pct}% of total confidence signal`);
  console.log(`Cumulative error (fixed path):  0.0000 (parseFloat preserves all values)`);

  console.log("\n" + hr);
  console.log("ROOT CAUSE");
  console.log(hr);
  console.log("  The JS LangGraph agent calls Math.round(Number(belief.confidence)).");
  console.log("  Model-class beliefs are bounded by the bridge at 0.40 < 0.5,");
  console.log("  so Math.round maps every value in [0.10, 0.40] to integer 0.");
  console.log("  This is not a precision loss — it is complete belief annihilation.");
  console.log();
  console.log("FIX (applied in langgraph-agent.ts fixedParseConfidence())");
  console.log(hr);
  console.log("  Replace:  Math.round(Number(v))");
  console.log("  With:     parseFloat(String(v))");
  console.log("  Validate: isFinite(parsed) && parsed >= 0 && parsed <= 1");
  console.log();
  console.log("SCHEMA FIX (BeliefEnvelope.v0.1.json)");
  console.log(hr);
  console.log('  confidence.$comment now prohibits Math.round, parseInt, toFixed(0).');
  console.log('  confidence.x-float-only: true signals to validators/codegen tools');
  console.log("  that integer coercion must be rejected at the adapter layer.\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const schedule = generateConfidenceSchedule(50);
const report   = predictCumulativeError(schedule);
printReport(report);

// Machine-readable JSON to stdout if piped
if (!process.stdout.isTTY) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
