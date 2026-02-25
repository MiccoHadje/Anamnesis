# Anamnesis — Design Brief

## Vision

Persistent semantic memory for Claude Code. Every session leaves a searchable trace. Future sessions can recall past decisions, reuse implementations, and reconstruct work timelines — without the user remembering what happened or where.

## Success Goals

### G1: Relevant Recall
A well-phrased natural language query returns the correct past conversation in the **top 3 results**. This applies equally across three use patterns:
- **"What did we decide?"** — Recalling rationale and architectural choices
- **"We did this before"** — Finding past implementations to reference or reuse
- **"What happened with X?"** — Reconstructing work timelines on a topic

### G2: Three Access Modes
1. **Explicit** — User asks Claude to search: "Check Anamnesis for how we handled auth"
2. **Triggered** — CLAUDE.md and output-style instructions prompt automatic searches based on context. (See [Trigger Catalog](#trigger-catalog) below.)
3. **Proactive** — Session-start context: search Anamnesis for recent work on the current project to seed the session with relevant history.

### G3: Hands-Free Ingestion
New sessions are ingested automatically via dual mechanisms:
- SessionEnd hook (immediate, best-effort)
- Scheduled task every 15 minutes (catches missed sessions)

The user should never need to manually trigger ingestion during normal workflow.

### G4: Full History
All existing transcripts are backfilled. Every past Claude Code session is searchable from day one.

### G5: Search Speed
MCP tool calls return results in **<2 seconds** for typical queries. Semantic search should not feel sluggish.

### G6: Auto-Linking
Sessions are automatically linked to related sessions at ingestion time, building a navigable web of context. Three layers:

1. **File & project overlap** — Link sessions that share `files_touched` or are on the same project within a time window.
2. **Semantic similarity** — Compare new session's averaged turn embeddings against existing sessions, link high-similarity matches.
3. **Topic extraction** — Use local LLM to extract topic tags per session. Link sessions sharing topics. Enables topic-based browsing.

## Anti-Goals

- **Not a chat interface.** Anamnesis retrieves past context — it doesn't generate summaries or answers. Claude does that.
- **Not a replacement for CLAUDE.md.** Stable, curated knowledge stays in CLAUDE.md and auto-memory. Anamnesis is for the long tail of session-specific context that's too granular to curate.
- **Not a logging/analytics tool.** Token usage, costs, and session metrics are interesting side data but not the core purpose.

## Constraints

### Infrastructure
- **Database**: Local PostgreSQL + pgvector, collocated with transcripts and embedding model for zero network latency.
- **Embeddings**: Local Ollama bge-m3. No API cost, no network dependency.

### Privacy & Filtering
- Support **project-level exclusion** — certain projects can be excluded from ingestion entirely
- Support **session-level exclusion** — individual sessions can be marked as excluded
- Exclusion config lives in a simple config file (not hardcoded), editable by the user
- Excluded content is never embedded or stored in the database

### Resource Awareness
- All compute and storage is local — no external API costs
- Ingestion should be interruptible and resumable (don't re-embed already-processed files)

## Trigger Catalog

Behavioral instructions for CLAUDE.md and output-style files that nudge Claude to use `anamnesis_search` in specific contexts. These are **soft triggers** — Claude decides based on relevance, not hard rules.

### Session Lifecycle
- **Session start** → Search for recent sessions on the current project. Provides continuity.

### Code Changes
- **Schema modification** → Search for past schema decisions, migration patterns, and rationale.
- **New file in existing directory** → Search for context on how similar files were structured.
- **Dependency changes** → Search for why dependencies were added/changed previously.
- **Config file changes** → Search for past configuration decisions and their reasoning.

### Debugging & Errors
- **Encountering errors** → Search for past sessions that dealt with similar error messages.
- **Recurring issues** → If an error feels familiar, search for prior debugging sessions.
- **Build/test failures** → Search for past sessions that fixed similar failures.

### User Cues
- **Explicit references** → "remember when we...", "like we did before", "we discussed this"
- **Feature questions** → "How does X work?" when X was built in a past session
- **Pattern requests** → "Do it like we did for Y" — search for the Y implementation

### Design & Architecture
- **Starting a new feature** → Search for past design discussions on related features
- **Refactoring** → Search for why the current code was structured this way
- **Cross-project patterns** → When implementing something that exists in another project

## Output State (What "Done" Looks Like)

1. `anamnesis_search` returns relevant results for natural language queries
2. New sessions are automatically ingested within 15 minutes of ending
3. All historical transcripts are searchable
4. MCP server is registered in Claude Code config and usable from any session
5. CLAUDE.md includes trigger instructions for proactive/triggered use
6. Privacy config excludes specified projects from ingestion
7. Session detail view shows auto-linked related sessions
8. Database runs locally with zero external dependencies
