/**
 * Parliament Integration Layer with Circuit-Breaker Fallback
 * 
 * PHASE 3: Parliament Circuit-Breaker Integration
 * 
 * This layer wraps all Parliament vote submissions with automatic fallback:
 *   1. Try primary model (Sonnet) â†’ if quota exhausted, go to tier 2
 *   2. Try fallback model (Haiku) â†’ if quota exhausted, go to tier 3
 *   3. Use stale cached vote (< 2hrs old) â†’ if no cache, abstain
 * 
 * Usage pattern:
 *   // OLD: risk of silent failure on quota exhaustion
 *   const vote = await parliament.submitVote(proposalId, voterId, prompt);
 *   
 *   // NEW: guaranteed response with fallback
 *   const vote = await submitParliamentVoteWithFallback(proposalId, voterId, prompt);
 * 
 * Integration points:
 *   - memory_invoke tool (submit task to Parliament vote gate)
 *   - task orchestration (where votes determine task approval)
 *   - Agentic workers (where Parliament consensus is required)
 */

import { invokeParliamentVoteWithFallback, getCachedVote } from './parliament-circuit-breaker.js';

export interface ParliamentVoteResult {
  vote: 'yes' | 'no' | 'abstain';
  weight: number;
  fallback_tier?: string; // 'primary' | 'fallback_1' | 'cache' | 'abstain'
  cached?: boolean;
  confidence?: number;
}

/**
 * Submit a Parliament vote with automatic fallback protection
 * 
 * Wraps invokeParliamentVoteWithFallback and adds telemetry/logging
 */
export async function submitParliamentVoteWithFallback(
  projectId: string,
  proposalId: string,
  voterId: string,
  proposalPrompt: string,
): Promise<ParliamentVoteResult> {
  try {
    const result = await invokeParliamentVoteWithFallback(proposalPrompt, proposalId, voterId);
    
    // Log voting decision for audit trail
    console.log(`[parliament-integration] Vote submitted: project=${projectId}, proposal=${proposalId}, voter=${voterId}, vote=${result.vote}, tier=${result.fallback_tier}`);
    
    return {
      vote: result.vote as 'yes' | 'no' | 'abstain',
      weight: result.weight,
      fallback_tier: result.fallback_tier,
      cached: result.cached,
    };
  } catch (error) {
    // Final fallback: return abstain
    console.error(`[parliament-integration] Vote submission failed, abstaining: ${error instanceof Error ? error.message : String(error)}`);
    return {
      vote: 'abstain',
      weight: 0.0,
      fallback_tier: 'error_abstain',
    };
  }
}

/**
 * Integration checklist for Phase 3:
 * 
 * [ ] Find all existing Parliament.submitVote() calls in codebase
 * [ ] Replace with submitParliamentVoteWithFallback()
 * [ ] Add to memory_invoke handler in mcp-handler.ts
 * [ ] Add telemetry/metrics collection
 * [ ] Test fallback under simulated quota exhaustion
 * [ ] Validate cached vote logic
 * 
 * Files to search:
 *   - src/memory-bridge/mcp-handler.ts (vote submission entry point)
 *   - Agentic/aik-parliament.js (parliament worker)
 *   - src/team/runtime.ts (team-level parliament calls)
 *   - All files importing Parliament or parliamentary functions
 */
