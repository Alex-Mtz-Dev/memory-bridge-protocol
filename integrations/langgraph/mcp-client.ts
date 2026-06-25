/**
 * Memory Bridge Protocol — TypeScript MCP client.
 *
 * Speaks the MCP Streamable-HTTP transport (JSON-RPC 2.0 over POST).
 * Mirrors the Python integrations/autogen/client.py API so LangGraph JS
 * agents communicate with the bridge using the same protocol.
 *
 * Requires Node ≥ 18 (native fetch).
 */

export interface BeliefRecord {
  belief_id:       string;
  cell_type:       "fact" | "decision" | "open_loop" | "artifact";
  text:            string;
  status:          string;
  score:           number;   // float — MUST NOT be coerced to int
}

export interface MemoryContextResult {
  beliefs: BeliefRecord[];
  summary?: Record<string, unknown>;
}

export interface MemoryPutResult {
  stored:    Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MemoryBridgeMCPClient {
  private readonly bridgeUrl: string;
  private readonly projectId: string;
  private readonly timeoutMs:  number;
  private sessionId: string | null = null;
  private reqId = 0;

  constructor(
    bridgeUrl = "https://aik-memory-bridge.fly.dev/mcp",
    projectId = "alex-computer",
    timeoutMs = 30_000,
  ) {
    this.bridgeUrl = bridgeUrl.replace(/\/$/, "");
    this.projectId = projectId;
    this.timeoutMs = timeoutMs;
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private nextId(): number {
    return ++this.reqId;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept":       "application/json, text/event-stream",
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  private parseResponse(raw: string): unknown {
    let text = raw.trim();
    if (text.startsWith("data:")) {
      text = text
        .split("\n")
        .filter((ln) => ln.startsWith("data:"))
        .map((ln) => ln.slice(5).trim())
        .join("\n");
    }
    const rpc = JSON.parse(text) as { error?: { code: number; message: string }; result?: unknown };
    if (rpc.error) {
      throw new Error(`MCP error ${rpc.error.code}: ${rpc.error.message}`);
    }
    return rpc.result ?? {};
  }

  private async post(payload: object): Promise<unknown> {
    const isNotification = !("id" in payload);
    const controller     = new AbortController();
    const timer          = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.bridgeUrl, {
        method:  "POST",
        headers: this.headers(),
        body:    JSON.stringify(payload),
        signal:  controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const sid = res.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;

      if (isNotification) return null;
      const text = await res.text();
      if (!text.trim()) return null;
      return this.parseResponse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── MCP protocol handshake ───────────────────────────────────────────────

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;

    await this.post({
      jsonrpc: "2.0",
      method:  "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities:    {},
        clientInfo:      { name: "memory-bridge-langgraph", version: "0.1.0" },
      },
      id: this.nextId(),
    });

    await this.post({
      jsonrpc: "2.0",
      method:  "notifications/initialized",
      params:  {},
    });
  }

  private async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureSession();
    const result = await this.post({
      jsonrpc: "2.0",
      method:  "tools/call",
      params:  { name: tool, arguments: args },
      id:      this.nextId(),
    });

    const r = result as { content?: Array<{ type: string; text: string }> };
    if (r?.content) {
      for (const block of r.content) {
        if (block.type === "text") {
          try { return JSON.parse(block.text); } catch { return block.text; }
        }
      }
    }
    return result;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async memoryContext(
    task:     string,
    topics:   string[] = [],
    limit:    number   = 8,
    minScore: number   = 0.0,
  ): Promise<MemoryContextResult> {
    return this.callTool("memory_context", {
      project_id: this.projectId,
      task,
      topics,
      limit,
      min_score: minScore,
    }) as Promise<MemoryContextResult>;
  }

  async memoryGet(
    task:     string,
    threadId: string   = "default",
    topics:   string[] = [],
    limit:    number   = 8,
  ): Promise<Record<string, unknown>> {
    return this.callTool("memory_get", {
      project_id: this.projectId,
      task,
      thread_id:  threadId,
      topics,
      limit,
    }) as Promise<Record<string, unknown>>;
  }

  async memoryPut(opts: {
    actor:      string;
    task:       string;
    summary?:   string;
    facts?:     string[];
    decisions?: string[];
    openLoops?: string[];
    confidence: number;    // float — never coerce to int before passing
    threadId?:  string;
    factStatus?: string;
  }): Promise<MemoryPutResult> {
    return this.callTool("memory_put", {
      project_id:  this.projectId,
      actor:       opts.actor,
      task:        opts.task,
      summary:     opts.summary   ?? "",
      facts:       opts.facts     ?? [],
      decisions:   opts.decisions ?? [],
      open_loops:  opts.openLoops ?? [],
      confidence:  opts.confidence,   // preserved as float
      thread_id:   opts.threadId  ?? "default",
      fact_status: opts.factStatus ?? "inferred",
    }) as Promise<MemoryPutResult>;
  }
}
