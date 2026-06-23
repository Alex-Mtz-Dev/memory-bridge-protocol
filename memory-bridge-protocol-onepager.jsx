import { useState } from "react";

const FONTS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@300;400;500&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap');
`;

const GAP_ROWS = [
  ["Recall / retrieval",              "✓", "✓"],
  ["Temporal awareness",              "~", "✓"],
  ["Epistemic status tracking",       "✗", "✓"],
  ["Confidence ceiling by actor",     "✗", "✓"],
  ["Agent identity standard",         "✗", "✓"],
  ["Multi-agent quorum governance",   "✗", "✓"],
];

const PRIMITIVES = [
  {
    n: "01",
    title: "Trust-scored beliefs",
    body: "Every fact and decision is a belief with epistemic status, confidence score, and provenance. Beliefs decay, get superseded, and can be contested — not a flat doc store.",
  },
  {
    n: "02",
    title: "Confidence ceilings",
    body: "A model agent cannot claim the same authority as a human operator. Each actor class has a ceiling. Writes above it are clamped. Prevents echo-chamber confidence inflation.",
  },
  {
    n: "03",
    title: "Agent identity registry",
    body: "Every agent has a structured identity: domain authorities, trust class, quorum weight. Identity is the substrate everything else builds on. No open standard exists yet.",
  },
  {
    n: "04",
    title: "Parliament governance",
    body: "Consequential changes go to a vote. Each agent's vote carries its registered weight. Proposals pass only at quorum threshold. Multi-agent decisions become auditable.",
  },
];

const c = {
  bg:       "#0d1117",
  surface:  "#161b22",
  border:   "#21262d",
  text:     "#e6edf3",
  muted:    "#7d8590",
  accent:   "#d4a853",
  accentDim:"#a87e38",
  green:    "#3fb950",
  red:      "#f85149",
  half:     "#4d5566",
};

export default function OnePager() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText("https://github.com/Alex-Mtz-Dev/memory-bridge-protocol");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <style>{FONTS}</style>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: ${c.bg}; }
        .pulse-dot { animation: pulse 2s ease-in-out infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        .fade-in { animation: fadeIn 0.6s ease forwards; }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .row-hover:hover { background: rgba(212,168,83,0.04); }
        .cta-btn:hover { background: ${c.accentDim}; transform: translateY(-1px); }
        .cta-btn { transition: all 0.15s ease; }
        .ghost-btn:hover { border-color: ${c.accent}; color: ${c.accent}; }
        .ghost-btn { transition: all 0.15s ease; }
      `}</style>

      <div style={{
        background: c.bg,
        color: c.text,
        fontFamily: "'DM Sans', sans-serif",
        minHeight: "100vh",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "32px 16px 48px",
      }}>
        <div style={{ width: "100%", maxWidth: 820 }} className="fade-in">

          {/* ── HEADER ─────────────────────────────────────────── */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `1px solid ${c.border}`,
            paddingBottom: 16,
            marginBottom: 40,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{
                display: "inline-block",
                width: 8, height: 8,
                borderRadius: "50%",
                background: c.accent,
              }} className="pulse-dot" />
              <span style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "0.12em",
                color: c.accent,
                textTransform: "uppercase",
              }}>
                Memory Bridge Protocol
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 11,
                color: c.muted,
                letterSpacing: "0.06em",
              }}>
                v0.1
              </span>
              <span style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                color: c.accent,
                border: `1px solid ${c.accentDim}`,
                borderRadius: 3,
                padding: "2px 6px",
                letterSpacing: "0.08em",
              }}>
                EARLY PROPOSAL
              </span>
            </div>
          </div>

          {/* ── HERO ────────────────────────────────────────────── */}
          <div style={{ marginBottom: 48 }}>
            <h1 style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontSize: "clamp(28px, 5vw, 44px)",
              fontWeight: 400,
              lineHeight: 1.15,
              color: c.text,
              marginBottom: 20,
            }}>
              The trust and governance layer<br />
              <em style={{ color: c.accent, fontStyle: "italic" }}>
                for multi-agent systems.
              </em>
            </h1>
            <p style={{
              fontSize: 16,
              color: c.muted,
              lineHeight: 1.65,
              maxWidth: 600,
            }}>
              The 2026 wave of agent runtimes answered <em>how fast</em> agents run and <em>where</em> they run.
              None of it answered the harder question: when you have many agents, across many sessions and many machines —
              <strong style={{ color: c.text }}> who do they trust, what do they remember, and how do they decide together?</strong>
            </p>
          </div>

          {/* ── POSITIONING ─────────────────────────────────────── */}
          <div style={{
            border: `1px solid ${c.border}`,
            borderLeft: `3px solid ${c.accent}`,
            background: c.surface,
            borderRadius: 6,
            padding: "20px 24px",
            marginBottom: 48,
          }}>
            <p style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontSize: "clamp(15px, 2.5vw, 19px)",
              fontWeight: 400,
              fontStyle: "italic",
              color: c.text,
              lineHeight: 1.5,
            }}>
              "NVLink is to GPUs what Memory Bridge is to agents — the coordination fabric
              that turns a collection of independent units into a single coherent system."
            </p>
            <p style={{
              marginTop: 10,
              fontFamily: "'DM Mono', monospace",
              fontSize: 11,
              color: c.muted,
              letterSpacing: "0.06em",
            }}>
              GPUs were already fast before NVLink. The value was the interconnect: shared state, low-friction
              coordination, acting as one. Agents are already capable. The missing piece is the interconnect
              for their <strong style={{ color: c.accent }}>state, trust, and decisions.</strong>
            </p>
          </div>

          {/* ── GAP TABLE ───────────────────────────────────────── */}
          <div style={{ marginBottom: 48 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: "0.14em",
                color: c.muted,
                textTransform: "uppercase",
              }}>The gap</span>
              <div style={{ flex: 1, height: 1, background: c.border }} />
            </div>

            <div style={{
              border: `1px solid ${c.border}`,
              borderRadius: 6,
              overflow: "hidden",
            }}>
              {/* Table header */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "1fr 180px 200px",
                background: c.surface,
                borderBottom: `1px solid ${c.border}`,
                padding: "10px 20px",
              }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: c.muted, letterSpacing: "0.08em" }}>Capability</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: c.muted, letterSpacing: "0.08em", textAlign: "center" }}>Storage-era tools</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: c.accent, letterSpacing: "0.08em", textAlign: "center" }}>Memory Bridge Protocol</span>
              </div>

              {/* Table rows */}
              {GAP_ROWS.map(([label, them, us], i) => (
                <div
                  key={i}
                  className="row-hover"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 180px 200px",
                    padding: "11px 20px",
                    borderBottom: i < GAP_ROWS.length - 1 ? `1px solid ${c.border}` : "none",
                    alignItems: "center",
                    transition: "background 0.12s",
                  }}
                >
                  <span style={{ fontSize: 13.5, color: c.text }}>{label}</span>
                  <span style={{
                    textAlign: "center",
                    fontSize: 14,
                    fontFamily: "'DM Mono', monospace",
                    color: them === "✓" ? c.green : them === "~" ? c.accent : c.red,
                  }}>
                    {them === "✓" ? "✓" : them === "~" ? "partial" : "✗"}
                  </span>
                  <span style={{
                    textAlign: "center",
                    fontSize: 14,
                    fontFamily: "'DM Mono', monospace",
                    color: c.green,
                    fontWeight: 500,
                  }}>
                    ✓
                  </span>
                </div>
              ))}
            </div>
            <p style={{
              marginTop: 10,
              fontSize: 12,
              color: c.muted,
              fontStyle: "italic",
            }}>
              Storage-era tools: Mem0, Zep, Letta, LangMem, Memory-OS — strong on recall, shared blind spot on trust.
            </p>
          </div>

          {/* ── FOUR PRIMITIVES ─────────────────────────────────── */}
          <div style={{ marginBottom: 48 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: "0.14em",
                color: c.muted,
                textTransform: "uppercase",
              }}>Four primitives</span>
              <div style={{ flex: 1, height: 1, background: c.border }} />
            </div>

            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 12,
            }}>
              {PRIMITIVES.map((p) => (
                <div
                  key={p.n}
                  style={{
                    background: c.surface,
                    border: `1px solid ${c.border}`,
                    borderRadius: 6,
                    padding: "18px 20px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 10,
                      color: c.accent,
                      letterSpacing: "0.1em",
                    }}>{p.n}</span>
                    <span style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 13.5,
                      fontWeight: 500,
                      color: c.text,
                    }}>{p.title}</span>
                  </div>
                  <p style={{
                    fontSize: 12.5,
                    color: c.muted,
                    lineHeight: 1.6,
                  }}>
                    {p.body}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* ── ADOPT TODAY ─────────────────────────────────────── */}
          <div style={{ marginBottom: 40 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: "0.14em",
                color: c.muted,
                textTransform: "uppercase",
              }}>What you can adopt today</span>
              <div style={{ flex: 1, height: 1, background: c.border }} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
              <div style={{
                border: `1px solid ${c.border}`,
                borderRadius: 6,
                padding: "18px 20px",
              }}>
                <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: c.accent, marginBottom: 6, letterSpacing: "0.06em" }}>
                  AgentIdentity schema
                </p>
                <p style={{ fontSize: 13, color: c.muted, lineHeight: 1.6, marginBottom: 12 }}>
                  A single JSON object that gives your agents a portable, trust-aware identity —
                  id, trust_class, domain_authorities, confidence_ceiling, quorum_weight.
                  Adopt independently of the rest of the protocol.
                </p>
                <code style={{
                  display: "block",
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: "#7ee787",
                  background: c.bg,
                  borderRadius: 4,
                  padding: "8px 10px",
                  lineHeight: 1.7,
                }}>
                  npx ajv-cli validate \<br />
                  {"  "}-s schemas/AgentIdentity.v0.1.json \<br />
                  {"  "}-d schemas/examples/claude.json \<br />
                  {"  "}--spec=draft2020
                </code>
              </div>

              <div style={{
                border: `1px solid ${c.border}`,
                borderRadius: 6,
                padding: "18px 20px",
              }}>
                <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: c.accent, marginBottom: 6, letterSpacing: "0.06em" }}>
                  Live MCP bridge
                </p>
                <p style={{ fontSize: 13, color: c.muted, lineHeight: 1.6, marginBottom: 12 }}>
                  A working MCP server already deployed at aik-memory-bridge.fly.dev, exposing
                  memory_context, memory_get, and memory_put. One-click Fly.io deploy from the repo.
                </p>
                <code style={{
                  display: "block",
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: "#7ee787",
                  background: c.bg,
                  borderRadius: 4,
                  padding: "8px 10px",
                  lineHeight: 1.7,
                }}>
                  fly launch --copy-config --no-deploy<br />
                  fly deploy
                </code>
              </div>
            </div>
          </div>

          {/* ── ROADMAP ─────────────────────────────────────────── */}
          <div style={{
            borderTop: `1px solid ${c.border}`,
            paddingTop: 24,
            marginBottom: 36,
            display: "flex",
            gap: 32,
            flexWrap: "wrap",
          }}>
            {[
              { ver: "v0.1 · now", items: ["AgentIdentity schema", "MCP bridge reference", "Fly.io one-click deploy"] },
              { ver: "v0.2 · next", items: ["Belief envelope schema", "Epistemic status state machine", "Confidence calibration API"] },
              { ver: "v0.3 · later", items: ["Parliament proposal/vote schema", "Quorum resolution spec", "Conformance test suite"] },
            ].map((r) => (
              <div key={r.ver} style={{ flex: "1 1 180px" }}>
                <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: c.accent, marginBottom: 8, letterSpacing: "0.06em" }}>
                  {r.ver}
                </p>
                {r.items.map((item) => (
                  <p key={item} style={{ fontSize: 12.5, color: c.muted, lineHeight: 1.7 }}>— {item}</p>
                ))}
              </div>
            ))}
          </div>

          {/* ── CTA ─────────────────────────────────────────────── */}
          <div style={{
            borderTop: `1px solid ${c.border}`,
            paddingTop: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
          }}>
            <div>
              <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: c.muted, marginBottom: 4, letterSpacing: "0.06em" }}>
                Open standard · MIT license · Early proposal
              </p>
              <p style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 13,
                color: c.accent,
              }}>
                github.com/Alex-Mtz-Dev/memory-bridge-protocol
              </p>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={handleCopy}
                className="ghost-btn"
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 12,
                  color: c.muted,
                  border: `1px solid ${c.border}`,
                  borderRadius: 5,
                  padding: "9px 16px",
                  background: "transparent",
                  cursor: "pointer",
                  letterSpacing: "0.04em",
                }}
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
              <a
                href="https://github.com/Alex-Mtz-Dev/memory-bridge-protocol"
                target="_blank"
                rel="noopener noreferrer"
                className="cta-btn"
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 12,
                  color: "#0d1117",
                  background: c.accent,
                  border: "none",
                  borderRadius: 5,
                  padding: "9px 20px",
                  cursor: "pointer",
                  letterSpacing: "0.04em",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontWeight: 500,
                }}
              >
                ⭐ Star the repo
              </a>
            </div>
          </div>

          {/* ── FOOTER NOTE ─────────────────────────────────────── */}
          <p style={{
            marginTop: 20,
            fontSize: 11.5,
            color: c.half,
            lineHeight: 1.6,
            fontStyle: "italic",
          }}>
            The protocol specification and schemas are MIT-licensed. The operational engine — belief-decay services,
            hosted multi-tenant control plane — is intentionally not in this repo. The protocol is open;
            the engine is proprietary.
          </p>

        </div>
      </div>
    </>
  );
}
