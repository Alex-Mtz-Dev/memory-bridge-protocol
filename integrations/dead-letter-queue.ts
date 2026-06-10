/**
 * Dead-Letter Queue Implementation
 * 
 * PHASE 4: Dead-Letter Queue (Depends on Phase 1)
 * 
 * Problem: Tasks that fail multiple times continue blocking the system.
 * No retry strategy or quarantine for problematic tasks.
 * 
 * Solution: After 3 failed reclaims/attempts, move task to dead-letter with reason.
 * Dead-letter tasks are:
 *   - Segregated from normal queue
 *   - Tagged with failure reason
 *   - Retryable only via explicit operator intervention
 *   - Tracked for SLO breach analysis
 * 
 * Status values: 'dead-letter' (terminal)
 * 
 * Dead-Letter Reasons:
 *   - max_retries_exceeded (reclaimed 3+ times without success)
 *   - claim_expired (lease never renewed, claim aged out)
 *   - trust_violation (actor not authorized)
 *   - network_error (bridge unreachable)
 *   - schema_violation (invalid task format)
 *   - timeout (exceeded max execution time)
 */

import type { TeamTask, TeamTaskV2 } from '../team/state.js';

export interface DeadLetterRecord extends TeamTaskV2 {
  status: 'dead-letter';
  failure_reason: string;
  retry_count: number;
  dead_lettered_at: string;
  last_error_message?: string;
}

/**
 * Write task to dead-letter queue
 * 
 * Called when:
 *   1. Reclaim count exceeds MAX_RETRIES (3)
 *   2. Trust violation detected (actor_trust_class !== 'human')
 *   3. Schema validation fails
 *   4. Lease expires without renewal
 */
export async function moveTaskToDeadLetter(
  task: TeamTaskV2,
  reason: string,
  errorMessage?: string,
): Promise<DeadLetterRecord> {
  const record: DeadLetterRecord = {
    ...task,
    status: 'dead-letter',
    failure_reason: reason,
    retry_count: task.retry_count ?? 0,
    dead_lettered_at: new Date().toISOString(),
    last_error_message: errorMessage,
  };

  // Write to dead-letter ledger (.aik/state/neural-bus/dead-letter-tasks.jsonl)
  // await appendDeadLetterRecord(record);

  return record;
}

/**
 * Integration checklist for Phase 4:
 * 
 * [ ] Create task-failures.jsonl append file in memory bridge store
 * [ ] Modify reclaimExpiredTaskClaim() to move to DLQ after 3 retries (âœ… DONE in Phase 1)
 * [ ] Modify handleCompleteTask() to validate owner before allowing complete
 * [ ] Add dead-letter tracking to monitor loop
 * [ ] Create SLO metric: % of tasks reaching dead-letter (target: < 1%)
 * [ ] Add operator API: moveTaskFromDeadLetter(taskId, reason) for manual recovery
 * [ ] Test: task reclaimed 3x â†’ verified in dead-letter.jsonl
 * [ ] Document recovery procedures
 * 
 * Files to modify:
 *   - src/memory-bridge/store.ts (add dead-letter writer)
 *   - src/team/state/tasks.ts (âœ… already started)
 *   - src/team/runtime.ts (add dead-letter tracking to recommendations)
 */
