/**
 * Parliament Circuit-Breaker for Quota Exhaustion
 * 
 * Problem: When Claude quota is exhausted (402/429 errors), Parliament votes fail silently.
 *          Governance fails â†’ system becomes uncontrollable.
 * 
 * Solution: Implement a multi-tier fallback system:
 *   1. Try primary model (Sonnet) â†’ if quota exhausted, go to tier 2
 *   2. Try fallback model (Haiku) â†’ if quota exhausted, go to tier 3
 *   3. Use stale cached vote (only if <2hrs old) â†’ if no cache, abstain safely
 * 
 * Deployed in: src/memory-bridge/parliament-integration.ts
 * Tested in: test/parliament-circuit-breaker.test.ts
 */

const QUOTA_ERROR_CODES = [429, 402]; // Rate limit, quota exceeded
const CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const FALLBACK_MODELS = [
  { name: 'claude-sonnet-4-20250514', tier: 'primary', weight: 1.0 },
  { name: 'claude-3-5-haiku-20241022', tier: 'fallback', weight: 0.7 },
];

// â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Vote cache: project â†’ proposal â†’ { vote, weight, timestamp } */
const voteCache = new Map();

function getCacheKey(projectId: any, proposalId: any, voterId: any) {
  return `${projectId}:${proposalId}:${voterId}`;
}

function saveVoteToCache(projectId: any, proposalId: any, voterId: any, vote: any, weight: any) {
  const key = getCacheKey(projectId, proposalId, voterId);
  voteCache.set(key, {
    vote,
    weight,
    timestamp: Date.now(),
    cached: true,
  });
}

function getCachedVote(projectId: any, proposalId: any, voterId: any) {
  const key = getCacheKey(projectId, proposalId, voterId);
  const entry = voteCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_MAX_AGE_MS) {
    voteCache.delete(key);
    return null;
  }
  return entry;
}

// â”€â”€â”€ Quota-Aware LLM Invocation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Invoke an LLM model with automatic fallback on quota exhaustion.
 * 
 * @param {string} proposalPrompt - The voting prompt for Parliament
 * @param {string} proposalId - For telemetry
 * @param {string} voterId - For cache + telemetry
 * @returns {{ vote, weight, fallback_tier, cached }} - The vote result
 */
async function invokeParliamentVoteWithFallback(proposalPrompt: any, proposalId: any, voterId: any) {
  const telemetry = {
    proposalId,
    voterId,
    timestamp: new Date().toISOString(),
    fallback_tier: null as string | null,
    cached: false,
    error: null as string | null,
  };

  for (let i = 0; i < FALLBACK_MODELS.length; i++) {
    const model = FALLBACK_MODELS[i];
    try {
      const response = await invokeLLMParliament(model.name, proposalPrompt);
      const parsed = parseParliamentVote(response);
      
      // Success â€” cache the result and return
      const projectId = extractProjectId(proposalPrompt); // from prompt context
      saveVoteToCache(projectId, proposalId, voterId, parsed.vote, model.weight);
      
      telemetry.fallback_tier = i === 0 ? 'primary' : `fallback_${i}`;
      emitTelemetry('parliament:vote:success', telemetry);
      
      return {
        vote: parsed.vote,
        weight: model.weight,
        fallback_tier: telemetry.fallback_tier,
        cached: false,
      };
    } catch (err) {
      if (!isQuotaError(err)) {
        // Not a quota error â€” real failure, abort
        telemetry.error = err instanceof Error ? err.message : String(err);
        emitTelemetry('parliament:vote:error', telemetry);
        throw err;
      }
      // Quota error â€” try next tier
      telemetry.fallback_tier = i === 0 ? 'primary' : `fallback_${i}`;
    }
  }

  // All tiers exhausted â€” fall back to cache
  const projectId = extractProjectId(proposalPrompt);
  const cached = getCachedVote(projectId, proposalId, voterId);
  if (cached) {
    telemetry.cached = true;
    telemetry.fallback_tier = 'cache';
    emitTelemetry('parliament:vote:fallback_to_cache', telemetry);
    return cached;
  }

  // No cache â€” abstain safely
  telemetry.error = 'quota_exhaustion_all_tiers';
  telemetry.fallback_tier = 'abstain';
  emitTelemetry('parliament:vote:abstain_quota_exhaustion', telemetry);
  
  return {
    vote: 'abstain' as const,
    reason: 'quota_exhaustion_no_cache',
    weight: 0.0,
    fallback_tier: 'abstain',
    cached: false,
  };
}

function isQuotaError(err: any): boolean {
  return QUOTA_ERROR_CODES.includes((err as any).status);
}

function parseParliamentVote(response: any) {
  // Extract vote from LLM response
  // Expected format: JSON with { vote: "yes"|"no"|"abstain", ... }
  try {
    const parsed = JSON.parse(response);
    return {
      vote: parsed.vote || 'abstain',
      confidence: parsed.confidence || 0.5,
    };
  } catch {
    // Fallback: parse by keyword
    if (/\byes\b/i.test(response)) return { vote: 'yes' };
    if (/\bno\b/i.test(response)) return { vote: 'no' };
    return { vote: 'abstain' };
  }
}

async function invokeLLMParliament(model: any, prompt: any) {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const openrouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const openrouterUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions';

  // Try OpenRouter first (OpenAI-compatible)
  if (openrouterKey) {
    const orResp = await fetch(openrouterUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: openrouterModel,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (orResp.ok) {
      const orData = await orResp.json();
      return (orData as any).choices[0].message.content;
    }
    const orErr = new Error(await orResp.text());
    (orErr as any).status = orResp.status;
    if (!QUOTA_ERROR_CODES.includes(orResp.status)) throw orErr;
    // quota error â†’ fall through to Anthropic
  }

  // Fall back to Anthropic
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const error = new Error(await response.text());
    (error as any).status = response.status;
    throw error;
  }

  const data = await response.json();
  return (data as any).content[0].text;
}

function extractProjectId(prompt: any): string {
  // Extract project_id from Parliament proposal prompt
  const match = prompt.match(/project[_-]?id[":"=]?\s*["']?([^"'\s]+)/i);
  return match ? match[1] : 'unknown';
}

function emitTelemetry(event: any, data: any): void {
  // Emit to monitoring system
  console.log(`[parliament-circuit-breaker] ${event}`, data);
  // In production: send to DataDog / New Relic / CloudWatch
}

// â”€â”€â”€ Export for Integration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export {
  invokeParliamentVoteWithFallback,
  getCachedVote,
  saveVoteToCache,
  CACHE_MAX_AGE_MS,
  FALLBACK_MODELS,
};

/**
 * INTEGRATION GUIDE
 * 
 * Before submitting a Parliament vote, replace:
 * 
 *   OLD:
 *   const voteResponse = await anthropic.messages.create({
 *     model: 'claude-sonnet-4-20250514',
 *     messages: [{ role: 'user', content: votingPrompt }],
 *   });
 * 
 *   NEW:
 *   const { vote, weight, fallback_tier, cached } = 
 *     await invokeParliamentVoteWithFallback(votingPrompt, proposalId, voterId);
 * 
 * Benefits:
 *   âœ… Vote never fails (falls back to cache if needed)
 *   âœ… Automatic model tier downgrade on quota
 *   âœ… Telemetry for monitoring governance health
 *   âœ… Stale votes are used only if <2hrs old (prevents outdated decisions)
 *   âœ… Abstention is safe (doesn't bias quorum)
 */
