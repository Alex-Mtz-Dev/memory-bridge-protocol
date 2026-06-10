/**
 * AIK Memory Bridge â€” MCP Streamable HTTP transport handler
 *
 * Exposes tools that Claude / ChatGPT / Gemini can call as a native Connector:
 *
 *   memory_get              â€” retrieve current project memory + relevant events
 *   memory_put              â€” write facts, decisions, open_loops, artifacts
 *   memory_context          â€” proactive belief surface for a task description
 *   memory_invoke           â€” submit a task to the Neural Bus queue
 *   memory_get_pending_tasks â€” poll for queued tasks (VS Code executor)
 *   memory_claim_task       â€” claim a queued task before executing it
 *   memory_complete_task    â€” mark a task done, write result as memory event
 *   memory_fetch_skill      â€” retrieve a skill prompt from the registry
 *   memory_register_skill   â€” upload a skill prompt to the registry
 *
 * Transport: MCP Streamable HTTP (2025-03-26 spec)
 *   POST /mcp  â€” JSON-RPC messages from Claude (initialize, tools/list, tools/call)
 *   GET  /mcp  â€” SSE stream for server-initiated messages (returns 405 â€” not needed)
 *
 * Auth: none â€” Claude registers this as a custom connector with no OAuth.
 *   To protect the endpoint on a shared server, mount behind the existing
 *   Bearer-token middleware OR deploy on a private Fly.io machine.
 *
 * Session management: stateless. We return a session ID but don't require it
 * on subsequent calls â€” this keeps the server horizontally scalable without
 * a session store.
 */

import { randomUUID } from "node:crypto";
import {
  handleContextRequest,
  handleMemoryBridgeRequest,
  handleInvokeTask,
  handleListPendingTasks,
  handleClaimTask,
  handleCompleteTask,
  handleSweepPendingTasks,
  handleFetchSkill,
  handleRegisterSkill,
  resolveMemoryBridgeRoot,
} from "./store.js";
import {
  generateConversationSummary,
  persistConversationToMemory,
} from "./chat-history-persistence.js";
import { submitParliamentVoteWithFallback } from "./parliament-integration.js";
import { logGovernanceRejection, logParliamentVote } from "../monitors/audit-logger.js";

// ---------------------------------------------------------------------------
// MCP protocol constants
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "aik-memory-bridge", version: "1.0.0" };
const conversationTurnCounter = new Map<string, number>();

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "memory_get",
    description:
      "Retrieve the current project memory: summary facts, decisions, open loops, artifacts, " +
      "and relevant past events. Call this at the start of a session or when context is needed. " +
      "Returns a structured MemoryBridgeGetResponse envelope.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          default: "alex-computer",
          description: "Project identifier. MUST be 'alex-computer'. Never use 'default'.",
        },
        thread_id: {
          type: "string",
          description: "Thread identifier for per-session state (default: 'default').",
        },
        task: {
          type: "string",
          description: "Current task description â€” used to rank relevant events.",
        },
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Additional topic keywords to bias retrieval.",
        },
        limit: {
          type: "integer",
          description: "Max number of relevant events to return (default: 8, max: 20).",
        },
        include_system_events: {
          type: "boolean",
          description: "Include system-authored telemetry events (for example metabolic/immune sweep confirmations) in relevant_events.",
        },
      },
    },
  },
  {
    name: "memory_put",
    description:
      "Persist memory: write facts, decisions, open loops, artifacts, and a summary to the " +
      "project store. Call this when the user reaches a decision, you learn something durable, " +
      "or an open question is resolved or opened. Actor identifies who is writing (e.g. 'claude').",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", default: "alex-computer", description: "Project identifier. MUST be 'alex-computer'. Never use 'default'." },
        thread_id: { type: "string", description: "Thread identifier (default: 'default')." },
        task: { type: "string", description: "Brief description of the current task." },
        summary: { type: "string", description: "One-sentence summary of what was decided or learned." },
        facts: {
          type: "array",
          items: { type: "string" },
          description: "Durable, undeniable facts observed in this session.",
        },
        decisions: {
          type: "array",
          items: { type: "string" },
          description: "Deliberate decisions made by the user or team.",
        },
        open_loops: {
          type: "array",
          items: { type: "string" },
          description: "Unresolved questions or pending tasks to track.",
        },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: "Key files, schemas, endpoints, or outputs produced.",
        },
        actor: {
          type: "string",
          description: "Who is writing this memory (e.g. 'claude', 'user', a team member name).",
        },
        actor_trust_class: {
          type: "string",
          enum: ["user", "system", "claude"],
          description: "Trust class of the actor. Determines confidence ceiling (claude: max 0.40) and precedence (user > system > claude). Inferred from actor field if omitted.",
        },
        fact_status: {
          type: "string",
          enum: [
            "observed",
            "asserted",
            "contested",
            "refuted",
            "reported",
            "self_state",
            "inferred",
            "hypothesis",
            "verified",
            "rejected",
          ],
          description: "Epistemic status of these beliefs. claude-authored entries default to 'inferred'; user-authored default to 'observed'. Use 'verified' only when externally corroborated.",
        },
        derived_from: {
          type: "array",
          items: { type: "string" },
          description: "Belief IDs this entry was derived from. Used for circular support detection â€” re-reading own beliefs must not increase confidence.",
        },
        input_origin: {
          type: "string",
          enum: ["human", "ai", "unknown"],
          description: "Origin of the input: 'human' for user-provided, 'ai' for AI-generated, 'unknown' if not determinable. Auto-inferred from actor_trust_class if omitted. Critical for echo chamber detection.",
        },
        confidence: {
          type: "number",
          description: "Confidence in this information, 0â€“1 (default: 0.6). Automatically capped at actor ceiling: claude=0.40, user/system=1.0.",
        },
        ttl_days: {
          type: "integer",
          description: "Optional TTL in days after which this memory becomes a candidate for eviction.",
        },
      },
    },
  },
  {
    name: "memory_context",
    description:
      "Proactive context surface â€” returns the top ranked active beliefs for a given task " +
      "description, without requiring a prior memory_put. Use this to proactively surface " +
      "relevant project context before the user asks. Returns scored beliefs and a current summary.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", default: "alex-computer", description: "Project identifier. MUST be 'alex-computer'. Never use 'default'." },
        task: {
          type: "string",
          description: "Current task description â€” used to score and rank beliefs.",
        },
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Additional keywords to bias belief retrieval.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of beliefs to return (default: 8, max: 50).",
        },
        min_score: {
          type: "number",
          description: "Minimum belief score threshold, 0â€“1 (default: 0).",
        },
      },
    },
  },
  // ---------------------------------------------------------------------------
  // Neural Bus tools
  // ---------------------------------------------------------------------------
  {
    name: "memory_invoke",
    description:
      "Submit a task to the AIK Neural Bus queue. Any AI (Claude, ChatGPT, Gemini) can " +
      "invoke this to delegate work to another agent or to VS Code. VS Code polls for tasks " +
      "tagged target_capability='vscode' and executes them locally. Other AIs poll for tasks " +
      "matching their capability. Returns correlation_id for later result lookup.",
    inputSchema: {
      type: "object",
      required: ["input", "target_capability"],
      properties: {
        project_id: { type: "string", default: "alex-computer", description: "Project identifier. MUST be 'alex-computer'. Never use 'default'." },
        target_capability: {
          type: "string",
          description: "Which agent should handle this task. Use 'vscode', 'chatgpt', 'claude', 'gemini', or 'any'.",
        },
        fallback_target_capability: {
          type: "string",
          description: "Optional fallback capability to reroute to when the requested target has no healthy registration.",
        },
        skill: {
          type: "string",
          description: "Optional skill name to fetch from the registry and apply to this task.",
        },
        input: {
          type: "string",
          description: "The task prompt or description. The executing agent will process this.",
        },
        priority: {
          type: "integer",
          description: "Priority 1 (low) to 10 (urgent), default 5.",
        },
        ttl_hours: {
          type: "integer",
          description: "Hours until the task expires if unclaimed, default 24.",
        },
        actor: {
          type: "string",
          description: "Who is submitting this task (e.g. 'claude', 'user').",
        },
        actor_trust_class: {
          type: "string",
          enum: ["user", "system", "claude"],
          description: "Trust class. 'claude'-class tasks are queued but marked trust_blocked (VS Code won't auto-execute). Default: 'system'.",
        },
        require_parliament_vote: {
          type: "boolean",
          description: "When true, gate task submission behind Parliament vote with circuit-breaker fallback.",
        },
        parliament_proposal_id: {
          type: "string",
          description: "Optional proposal id for Parliament gating (defaults to generated correlation id candidate).",
        },
        parliament_voter_id: {
          type: "string",
          description: "Optional voter identity for Parliament fallback/caching (default: memory-invoke-gate).",
        },
        parliament_prompt: {
          type: "string",
          description: "Optional explicit voting prompt. If omitted, a prompt is derived from input + target capability.",
        },
      },
    },
  },
  {
    name: "memory_get_pending_tasks",
    description:
      "Poll the Neural Bus queue for pending tasks. VS Code AIK extension calls this every " +
      "30 seconds to find tasks to execute locally. Other agents call it to find tasks " +
      "matching their capabilities. Returns tasks sorted by priority, with status overlay.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", default: "alex-computer", description: "Project identifier. MUST be 'alex-computer'. Never use 'default'." },
        status_filter: {
          type: "array",
          items: {
            type: "string",
            enum: ["pending", "claimed", "completed", "trust_blocked", "expired", "archived", "dead_letter"],
          },
          description: "Filter by status. Default: ['pending'] to get actionable tasks only.",
        },
      },
    },
  },
  {
    name: "memory_claim_task",
    description:
      "Claim a pending Neural Bus task before executing it. Workers should call this after " +
      "selecting a task from memory_get_pending_tasks so only one executor owns the task.",
    inputSchema: {
      type: "object",
      required: ["correlation_id", "claimed_by"],
      properties: {
        project_id: { type: "string", default: "alex-computer", description: "Project identifier. MUST be 'alex-computer'. Never use 'default'." },
        correlation_id: {
          type: "string",
          description: "The correlation_id returned by memory_invoke or listed by memory_get_pending_tasks.",
        },
        claimed_by: {
          type: "string",
          description: "Worker identifier claiming the task, for example 'vscode-aik-worker'.",
        },
      },
    },
  },
  {
    name: "memory_complete_task",
    description:
      "Mark a Neural Bus task as completed and write the result as a memory event. " +
      "Call this after executing a task retrieved via memory_get_pending_tasks. " +
      "The result is automatically stored in the project memory for future retrieval.",
    inputSchema: {
      type: "object",
      required: ["correlation_id", "output"],
      properties: {
        project_id: { type: "string", default: "alex-computer", description: "Project identifier. MUST be 'alex-computer'. Never use 'default'." },
        correlation_id: {
          type: "string",
          description: "The correlation_id returned by memory_invoke or memory_get_pending_tasks.",
        },
        completed_by: {
          type: "string",
          description: "Agent that completed the task (e.g. 'claude', 'vscode', 'chatgpt').",
        },
        output: {
          type: "string",
          description: "The result of the task execution.",
        },
        exit_code: {
          type: "integer",
          description: "Exit code: 0 for success, non-zero for failure. Default: 0.",
        },
      },
    },
  },
  {
    name: "memory_sweep_tasks",
    description:
      "Sweep the Neural Bus queue to archive stale unclaimed tasks, requeue the first expired claim, and dead-letter tasks on second claim expiry while preserving evidence.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", default: "alex-computer", description: "Project identifier. MUST be 'alex-computer'. Never use 'default'." },
      },
    },
  },
  {
    name: "memory_fetch_skill",
    description:
      "Retrieve a skill prompt from the registry by name. Skills are stored as markdown " +
      "on the server and shared across all AI agents. Use this before executing a task " +
      "that specifies a skill name. VS Code uploads skills from ~/.config/Code/User/prompts/.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "Skill name (e.g. 'creative-thinking'). Must match a registered skill.",
        },
      },
    },
  },
  {
    name: "memory_register_skill",
    description:
      "Upload or update a skill prompt in the shared registry. VS Code calls this to " +
      "make local .prompt.md files available to all AIs. Skills are stored as markdown " +
      "and returned verbatim by memory_fetch_skill.",
    inputSchema: {
      type: "object",
      required: ["name", "content"],
      properties: {
        name: {
          type: "string",
          description: "Skill identifier slug (e.g. 'creative-thinking'). Alphanumeric + hyphens.",
        },
        content: {
          type: "string",
          description: "Full markdown content of the skill prompt.",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function jsonRpcOk(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Remote bridge forward â€” when AIK_BRIDGE_URL is set, mirror put/complete_task
// writes to the remote HTTP bridge so Claude (Fly.io) and local stores stay in
// sync.  Errors are non-fatal: local write still succeeds.
// ---------------------------------------------------------------------------

async function forwardToRemoteBridge(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.AIK_BRIDGE_URL?.trim().replace(/\/+$/, "");
  if (!url) return;
  const token = process.env.AIK_BRIDGE_TOKEN?.trim() || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(`${url}/memory-bridge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payload, schema_version: "1.0" }),
      // No AbortSignal â€” AbortSignal.timeout() causes libuv assertion failures on Windows
      // when process.exit() is called while the timer is still pending.
    });
    // Consume body to release the socket before returning
    await res.text();
    if (!res.ok) {
      console.warn(`[mcp-handler] Remote bridge forward failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[mcp-handler] Remote bridge forward error (non-fatal): ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

/** Normalize project_id: only allow the canonical fleet namespace. */
const resolveProjectId = (_raw: unknown): string => "alex-computer";

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  rootDir: string,
): Promise<Array<{ type: "text"; text: string }>> {
  if (name === "memory_get") {
    const response = await handleMemoryBridgeRequest(
      {
        op: "get",
        project_id: resolveProjectId(args.project_id),
        chatbot: "claude",
        thread_id: typeof args.thread_id === "string" ? args.thread_id : undefined,
        task: typeof args.task === "string" ? args.task : undefined,
        topics: Array.isArray(args.topics) ? (args.topics as string[]) : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        include_system_events: args.include_system_events === true,
      },
      { rootDir },
    );
    return [{ type: "text", text: JSON.stringify(response, null, 2) }];
  }

  if (name === "memory_put") {
    // ---------------------------------------------------------------------------
    // Trust metadata enrichment â€” apply heuristics for any field the LLM omits.
    // Mirrors store.ts logic so both local writes and remote (Fly.io) forward
    // always receive fully-populated trust signals, even when the caller skips them.
    // ---------------------------------------------------------------------------
    const rawActor = typeof args.actor === "string" ? args.actor : "claude";
    // Derive actor_trust_class from actor name when LLM does not supply it
    const resolvedTrustClass: import("./store.js").MemoryBridgeActorTrustClass =
      (args.actor_trust_class === "user" || args.actor_trust_class === "system" || args.actor_trust_class === "claude")
        ? (args.actor_trust_class as import("./store.js").MemoryBridgeActorTrustClass)
        : rawActor === "user" ? "user"
        : rawActor === "system" ? "system"
        : "claude"; // conservative fallback â€” all MCP callers are AI unless stated
    // Derive fact_status from trust class when LLM omits it
    const resolvedFactStatus: import("./store.js").MemoryBridgeFactStatus =
      (
        typeof args.fact_status === "string" &&
        [
          "observed",
          "asserted",
          "contested",
          "refuted",
          "reported",
          "self_state",
          "inferred",
          "hypothesis",
          "verified",
          "rejected",
        ].includes(args.fact_status)
      )
        ? (args.fact_status as import("./store.js").MemoryBridgeFactStatus)
        : resolvedTrustClass === "user" ? "observed"
        : resolvedTrustClass === "system" ? "reported"
        : "inferred";
    // Derive input_origin from trust class when LLM omits it
    const resolvedInputOrigin: import("./store.js").MemoryBridgeInputOrigin =
      (args.input_origin === "human" || args.input_origin === "ai" || args.input_origin === "unknown")
        ? (args.input_origin as import("./store.js").MemoryBridgeInputOrigin)
        : resolvedTrustClass === "user" ? "human"
        : resolvedTrustClass === "claude" ? "ai"
        : "unknown";
    // Confidence ceiling per trust class; default when omitted
    const CONF_DEFAULTS: Record<import("./store.js").MemoryBridgeActorTrustClass, number> = { user: 0.80, system: 0.70, claude: 0.35 };
    const CONF_CEILINGS: Record<import("./store.js").MemoryBridgeActorTrustClass, number> = { user: 1.0, system: 1.0, claude: 0.40 };
    const resolvedConfidence = typeof args.confidence === "number"
      ? Math.min(args.confidence, CONF_CEILINGS[resolvedTrustClass])
      : CONF_DEFAULTS[resolvedTrustClass];
    // source_trust default per trust class
    const SOURCE_TRUST_DEFAULTS: Record<import("./store.js").MemoryBridgeActorTrustClass, number> = { user: 0.90, system: 0.80, claude: 0.60 };
    const resolvedSourceTrust = typeof args.source_trust === "number" ? args.source_trust : SOURCE_TRUST_DEFAULTS[resolvedTrustClass];

    const putPayload = {
      op: "put" as const,
      project_id: resolveProjectId(args.project_id),
      chatbot: "claude",
      thread_id: typeof args.thread_id === "string" ? args.thread_id : undefined,
      task: typeof args.task === "string" ? args.task : undefined,
      summary: typeof args.summary === "string" ? args.summary : undefined,
      facts: Array.isArray(args.facts) ? (args.facts as string[]) : undefined,
      decisions: Array.isArray(args.decisions) ? (args.decisions as string[]) : undefined,
      open_loops: Array.isArray(args.open_loops) ? (args.open_loops as string[]) : undefined,
      loop_state:
        args.loop_state === "open" ||
        args.loop_state === "resolved" ||
        args.loop_state === "refuted" ||
        args.loop_state === "superseded"
          ? (args.loop_state as import("./store.js").MemoryBridgeLoopState)
          : undefined,
      resolved_by: typeof args.resolved_by === "string" ? args.resolved_by : undefined,
      artifacts: Array.isArray(args.artifacts) ? (args.artifacts as string[]) : undefined,
      actor: rawActor,
      actor_trust_class: resolvedTrustClass,
      fact_status: resolvedFactStatus,
      derived_from: Array.isArray(args.derived_from) ? (args.derived_from as string[]) : undefined,
      input_origin: resolvedInputOrigin,
      confidence: resolvedConfidence,
      source_trust: resolvedSourceTrust,
      ttl_days: typeof args.ttl_days === "number" ? args.ttl_days : undefined,
    };
    const response = await handleMemoryBridgeRequest(putPayload, { rootDir });

    const projectId = resolveProjectId(args.project_id);
    const threadId = typeof args.thread_id === "string" ? args.thread_id : "default";
    const sessionId = `${projectId}:${threadId}`;
    const currentTurn = (conversationTurnCounter.get(sessionId) ?? 0) + 1;
    conversationTurnCounter.set(sessionId, currentTurn);

    const conversationSummary = generateConversationSummary(
      sessionId,
      currentTurn,
      typeof args.task === "string" ? args.task : "memory_put",
      typeof args.summary === "string" ? args.summary : "memory update",
      Array.isArray(args.decisions) ? (args.decisions as string[]) : [],
      Array.isArray(args.artifacts)
        ? (args.artifacts as string[]).map((artifact) => ({ type: "artifact", path: artifact }))
        : [],
      ["memory_put"],
      {
        model: "mcp-handler",
        phase: "memory-bridge",
      },
    );

    await persistConversationToMemory(conversationSummary, {
      rootDir,
      projectId,
      memoryBridgeEndpoint: process.env.AIK_BRIDGE_URL,
    });

    // Mirror to remote bridge â€” await so the HTTP request completes before we return.
    // Errors are non-fatal (forwardToRemoteBridge catches and warns).
    await forwardToRemoteBridge(putPayload);
    return [{ type: "text", text: JSON.stringify(response, null, 2) }];
  }

  if (name === "memory_context") {
    const response = await handleContextRequest(
      {
        project_id: resolveProjectId(args.project_id),
        task: typeof args.task === "string" ? args.task : undefined,
        topics: Array.isArray(args.topics) ? (args.topics as string[]) : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        min_score: typeof args.min_score === "number" ? args.min_score : undefined,
      },
      { rootDir },
    );
    return [{ type: "text", text: JSON.stringify(response, null, 2) }];
  }

  // Neural Bus tools
  if (name === "memory_invoke") {
    const projectId = resolveProjectId(args.project_id);
    const requireParliamentVote = args.require_parliament_vote === true;
    if (requireParliamentVote) {
      const proposalId = typeof args.parliament_proposal_id === "string"
        ? args.parliament_proposal_id
        : `invoke-${randomUUID().split("-")[0]}`;
      const voterId = typeof args.parliament_voter_id === "string"
        ? args.parliament_voter_id
        : "memory-invoke-gate";
      const taskId = typeof args.input === "string" ? args.input.slice(0, 50) : "unknown-task";
      const derivedPrompt = [
        "You are a Parliament gate evaluating whether to allow a Neural Bus task submission.",
        `project_id=${projectId}`,
        `target_capability=${typeof args.target_capability === "string" ? args.target_capability : "any"}`,
        `priority=${typeof args.priority === "number" ? args.priority : 5}`,
        `input=${typeof args.input === "string" ? args.input : ""}`,
        "Return yes only if this task should proceed now; otherwise return no or abstain.",
      ].join("\n");
      const vote = await submitParliamentVoteWithFallback(
        projectId,
        proposalId,
        voterId,
        typeof args.parliament_prompt === "string" ? args.parliament_prompt : derivedPrompt,
      );

      // Log Parliament vote to audit log
      try {
        await logParliamentVote(taskId, proposalId, voterId, vote.vote, vote.fallback_tier ?? "primary", {
          sessionId: proposalId,
          quorumMet: true,
          finalResult: vote.vote,
          eligibleVoters: 1,
          votesFor: vote.vote === 'yes' ? 1 : 0,
          votesAgainst: vote.vote === 'no' ? 1 : 0,
          votesAbstain: vote.vote === 'abstain' ? 1 : 0,
        });
      } catch (err) {
        console.warn(`[mcp-handler] Failed to log Parliament vote: ${(err as Error).message}`);
      }

      if (vote.vote !== "yes") {
        // Log governance rejection
        try {
          await logGovernanceRejection(
            taskId,
            "memory_invoke",
            "parliament_vote_not_yes",
            {
              voterId,
              parliamentResult: vote.vote,
              userMessage: "Task execution blocked by governance policy",
            },
          );
        } catch (err) {
          console.warn(`[mcp-handler] Failed to log governance rejection: ${(err as Error).message}`);
        }

        return [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            op: "tasks/invoke",
            project_id: projectId,
            error: "PARLIAMENT_GATE_REJECTED",
            gate_vote: vote,
          }, null, 2),
        }];
      }
    }

    const response = await handleInvokeTask(
      {
        project_id: resolveProjectId(args.project_id),
        target_capability: typeof args.target_capability === "string" ? args.target_capability : "any",
        fallback_target_capability:
          typeof args.fallback_target_capability === "string" ? args.fallback_target_capability : undefined,
        skill: typeof args.skill === "string" ? args.skill : undefined,
        input: typeof args.input === "string" ? args.input : "",
        priority: typeof args.priority === "number" ? args.priority : undefined,
        ttl_hours: typeof args.ttl_hours === "number" ? args.ttl_hours : undefined,
        actor: typeof args.actor === "string" ? args.actor : undefined,
        actor_trust_class:
          args.actor_trust_class === "user" || args.actor_trust_class === "system" || args.actor_trust_class === "claude"
            ? args.actor_trust_class
            : undefined,
      },
      { rootDir },
    );
    return [{ type: "text", text: JSON.stringify(response, null, 2) }];
  }

  if (name === "memory_get_pending_tasks") {
    const statusFilter = Array.isArray(args.status_filter)
      ? (args.status_filter as string[])
      : ["pending"];
    const response = await handleListPendingTasks(
      resolveProjectId(args.project_id),
      { rootDir, status_filter: statusFilter as import("./store.js").MemoryBridgeTaskStatus[] },
    );
    return [{ type: "text", text: JSON.stringify(response, null, 2) }];
  }

  if (name === "memory_claim_task") {
    const response = await handleClaimTask(
      typeof args.correlation_id === "string" ? args.correlation_id : "",
      typeof args.claimed_by === "string" ? args.claimed_by : "mcp-worker",
      resolveProjectId(args.project_id),
      { rootDir },
    );
    return [{ type: "text", text: JSON.stringify(response, null, 2) }];
  }

  if (name === "memory_complete_task") {
    const response = await handleCompleteTask(
      typeof args.correlation_id === "string" ? args.correlation_id : "",
      typeof args.completed_by === "string" ? args.completed_by : "mcp-caller",
      typeof args.output === "string" ? args.output : "",
      typeof args.exit_code === "number" ? args.exit_code : 0,
      resolveProjectId(args.project_id),
      { rootDir },
    );

    const projectId = resolveProjectId(args.project_id);
    const sessionId = `${projectId}:tasks`;
    const currentTurn = (conversationTurnCounter.get(sessionId) ?? 0) + 1;
    conversationTurnCounter.set(sessionId, currentTurn);
    const completionSummary = generateConversationSummary(
      sessionId,
      currentTurn,
      typeof args.correlation_id === "string" ? `complete:${args.correlation_id}` : "complete:unknown",
      typeof args.output === "string" ? args.output : "",
      [],
      [],
      ["memory_complete_task"],
      {
        model: "mcp-handler",
        phase: "task-completion",
      },
    );
    await persistConversationToMemory(completionSummary, {
      rootDir,
      projectId,
      memoryBridgeEndpoint: process.env.AIK_BRIDGE_URL,
    });

    // Mirror task completion as a memory_put to the remote bridge
    await forwardToRemoteBridge({
      op: "put",
      project_id: resolveProjectId(args.project_id),
      actor: typeof args.completed_by === "string" ? args.completed_by : "mcp-caller",
      actor_trust_class: "system",
      fact_status: "observed",
      source_trust: 1.0,
      confidence: 0.95,
      task: typeof args.correlation_id === "string" ? args.correlation_id : "task-complete",
      summary: `Task completed by ${typeof args.completed_by === "string" ? args.completed_by : "mcp-caller"}: ${typeof args.correlation_id === "string" ? args.correlation_id : ""}`,
      facts: [`task-complete:${typeof args.correlation_id === "string" ? args.correlation_id : "unknown"}`, `exit_code:${typeof args.exit_code === "number" ? args.exit_code : 0}`],
    });
    return [{ type: "text", text: JSON.stringify(response, null, 2) }];
  }

  if (name === "memory_sweep_tasks") {
    const response = await handleSweepPendingTasks(
      resolveProjectId(args.project_id),
      { rootDir },
    );
    return [{ type: "text", text: JSON.stringify(response, null, 2) }];
  }

  if (name === "memory_fetch_skill") {
    try {
      const response = await handleFetchSkill(
        typeof args.name === "string" ? args.name : "",
        { rootDir },
      );
      return [{ type: "text", text: JSON.stringify(response, null, 2) }];
    } catch {
      return [{ type: "text", text: JSON.stringify({ ok: false, op: "skills/fetch", error: "SKILL_NOT_FOUND", name: args.name }) }];
    }
  }

  if (name === "memory_register_skill") {
    const response = await handleRegisterSkill(
      typeof args.name === "string" ? args.name : "",
      typeof args.content === "string" ? args.content : "",
      { rootDir },
    );
    return [{ type: "text", text: JSON.stringify(response, null, 2) }];
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// Request handler â€” call this from the HTTP server for POST /mcp
// ---------------------------------------------------------------------------

export interface McpHandlerOptions {
  rootDir?: string;
}

export interface McpJsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Handle a single MCP JSON-RPC message and return the response object (or null
 * for notifications that don't need a response body).
 */
export async function handleMcpMessage(
  message: McpJsonRpcMessage,
  options: McpHandlerOptions = {},
): Promise<{ response: unknown; sessionId?: string } | { accepted: true }> {
  const rootDir = options.rootDir ?? resolveMemoryBridgeRoot();
  const { method, id, params } = message;

  // Notifications and responses from the client â€” respond 202 Accepted (no body).
  // MCP spec sends "initialized" (bare) after handshake; some clients use "notifications/*" prefix.
  if (method === "initialized" || method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return { accepted: true };
  }

  // initialize
  if (method === "initialize") {
    const sessionId = randomUUID();
    return {
      sessionId,
      response: jsonRpcOk(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      }),
    };
  }

  // tools/list
  if (method === "tools/list") {
    return {
      response: jsonRpcOk(id, { tools: TOOLS }),
    };
  }

  // tools/call
  if (method === "tools/call") {
    const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const toolName = p?.name;
    const args = p?.arguments ?? {};
    if (!toolName) {
      return {
        response: jsonRpcError(id, -32602, "tools/call requires params.name"),
      };
    }
    try {
      const content = await dispatchTool(toolName, args, rootDir);
      return { response: jsonRpcOk(id, { content }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { response: jsonRpcOk(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true }) };
    }
  }

  // Unknown method
  return {
    response: jsonRpcError(id ?? null, -32601, `Method not found: ${method}`),
  };
}

/**
 * Parse the incoming body â€” may be a single message or a batch array.
 * Returns an array of messages.
 */
export function parseMcpBody(body: unknown): McpJsonRpcMessage[] {
  if (Array.isArray(body)) return body as McpJsonRpcMessage[];
  return [body as McpJsonRpcMessage];
}
