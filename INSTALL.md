# Installation Guide

Step-by-step instructions to go from zero to a working Anamnesis installation. This guide assumes you have Claude Code available to help — many steps include notes for Claude on how to assist.

## Overview

You'll set up four components:

1. **PostgreSQL + pgvector** — stores sessions, turns, embeddings, and search indexes
2. **Ollama** — runs the embedding model locally (no API keys needed)
3. **Anamnesis** — the ETL pipeline + MCP server
4. **Claude Code integration** — MCP server registration + hooks

Total time: ~30 minutes for setup, plus backfill time (varies with transcript volume).

---

## Step 1: Prerequisites

### Node.js 18+

```bash
node --version   # Should print v18.x or higher
```

If not installed: [nodejs.org](https://nodejs.org/) — use the LTS version.

### PostgreSQL with pgvector

You need PostgreSQL 14+ with the [pgvector](https://github.com/pgvector/pgvector) extension.

**macOS (Homebrew):**
```bash
brew install postgresql@16
brew install pgvector
brew services start postgresql@16
```

**Ubuntu/Debian:**
```bash
sudo apt install postgresql postgresql-contrib
sudo apt install postgresql-16-pgvector   # match your PG version
sudo systemctl start postgresql
```

**Windows:**
- Install [PostgreSQL](https://www.postgresql.org/download/windows/) (EDB installer recommended)
- pgvector: Download from [pgvector releases](https://github.com/pgvector/pgvector/releases) or build from source. The EDB installer's Stack Builder may offer it.
- Ensure `psql` is in your PATH (typically `C:\Program Files\PostgreSQL\16\bin`)

**Verify:**
```bash
psql --version
psql -c "SELECT 1;"   # Should connect without errors
```

> **Note for Claude:** If the user gets "connection refused" or "role does not exist", help them check that PostgreSQL is running (`pg_isready`) and that their OS user has a matching PostgreSQL role (`createuser --superuser $USER` or equivalent). On Windows, the default superuser is `postgres` — they may need `psql -U postgres`.

### Ollama

[Ollama](https://ollama.com/) runs embedding models locally. No API keys required.

```bash
# Install (macOS/Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Windows: Download from https://ollama.com/download/windows
```

**Pull the required model:**
```bash
ollama pull bge-m3        # Required — 1024-dim embeddings (~1.5 GB)
ollama pull gemma3:12b    # Optional — topic extraction (~7 GB, needs ~8 GB VRAM)
```

> **GPU requirements for topic extraction:** Topic extraction is optional but recommended. The default model (`gemma3:12b`) needs a GPU with ~8 GB VRAM (e.g., RTX 3070 or better). If you have a less powerful GPU or CPU-only setup, use a smaller model:
>
> | Model | Size | VRAM | Quality | Speed |
> |-------|------|------|---------|-------|
> | `gemma3:12b` | 8 GB | ~8 GB | Best | ~1-2s/session |
> | `gemma3:4b` | 3.3 GB | ~4 GB | Good — comparable tags, slightly weaker summaries | ~0.5-0.7s/session |
> | `gemma3:1b` | 1 GB | ~2 GB | Basic — may miss nuanced topics | fastest |
>
> To use a smaller model: `ollama pull gemma3:4b` and set `"model": "gemma3:4b"` in the `topic_model` section of your config. Topics add a third linking dimension and improve search relevance.
>
> **Remote Ollama:** If you have Ollama running on another machine (e.g., a GPU server on your LAN), set `topic_model.url` (and optionally `ollama.url`) to point to it — e.g., `"url": "http://192.168.1.10:11434"`. This lets you develop on a laptop while offloading inference to a more capable machine. Expect slightly higher latency (~5-10s/session over WiFi) but identical results.

**Verify:**
```bash
ollama list                                          # Should show bge-m3
curl http://localhost:11434/api/tags 2>/dev/null | head   # Should return JSON
```

> **Note for Claude:** If Ollama isn't responding, check `ollama serve` (it may need to be running in a separate terminal or as a service). On Windows, the Ollama installer creates a background service. On Linux, use `systemctl status ollama`. If the user's Ollama runs on a different machine, they'll configure the URL in Step 3.

---

## Step 2: Database Setup

```bash
# Create the database
createdb anamnesis

# Apply the schema (creates tables, indexes, extensions)
psql -d anamnesis -f src/db/schema.sql
```

The schema automatically runs `CREATE EXTENSION IF NOT EXISTS vector` — this will fail if pgvector isn't installed. If you get an error about the `vector` extension:

```bash
# Check if pgvector is available
psql -d anamnesis -c "CREATE EXTENSION vector;"
```

If that fails, pgvector isn't installed — go back to Step 1.

**Verify:**
```bash
psql -d anamnesis -c "\dt anamnesis_*"
```

You should see four tables: `anamnesis_sessions`, `anamnesis_turns`, `anamnesis_ingested_files`, `anamnesis_session_links`.

> **Note for Claude:** The default config expects database user `anamnesis`. If the user wants to use their own PostgreSQL role instead (common on personal machines with trust auth), they should use their OS username and update `database.user` in the config (Step 3). No need to create a separate `anamnesis` role unless they prefer it.

---

## Step 3: Build and Configure

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build
```

**Create your config file:**
```bash
cp anamnesis.config.example.json anamnesis.config.json
```

**Edit `anamnesis.config.json`** — here's what to change from the defaults:

### Required Changes

| Field | Default | What to set |
|-------|---------|-------------|
| `transcripts_root` | `~/.claude/projects` | Usually correct as-is. This is where Claude Code stores JSONL transcripts. |
| `database.user` | `anamnesis` | **Change to your PostgreSQL username** (often your OS username on personal machines). |

### Optional Changes

| Field | When to change |
|-------|---------------|
| `database.host` | If PostgreSQL runs on a different machine |
| `database.password` | If you use password auth (not needed with trust/peer auth) |
| `ollama.url` | If Ollama runs on a different machine (e.g., `http://192.168.1.10:11434`) |
| `topic_model.model` | If you want a different model for topic extraction, or remove the section to skip topics |
| `topic_model.strategy` | `full` (default) reads entire sessions. `first_message` only reads the first user message (faster, less accurate). |
| `topic_model.preserve_words` | Words to protect from compression. Add project names that are common English words (e.g., `["dash", "key", "home"]`) or short abbreviations (e.g., `["HG", "AI"]`). See note below. |
| `search_mode` | `hybrid` (default) is recommended. `vector` uses pure semantic search. |
| `exclude_projects` | Directory names to skip (e.g., `["D--SomePrivateProject"]`) |

> **Note on `preserve_words`:** Topic extraction compresses session text before sending it to the LLM by stripping common English words (pronouns, prepositions, common verbs, etc.). This achieves ~25% compression, meaning fewer LLM calls per session. However, if your project is named "Dash" or "State" or uses a short abbreviation like "HG", those words would be stripped from the input text. Adding them to `preserve_words` keeps them visible to the topic model. When in doubt, list your project names and any domain-specific terms that might collide with common English.

### Minimal config example

If you use trust auth with your OS username on localhost, this is all you need:

```json
{
  "transcripts_root": "~/.claude/projects",
  "search_mode": "hybrid",
  "database": {
    "host": "localhost",
    "port": 5432,
    "database": "anamnesis",
    "user": "yourname"
  },
  "ollama": {
    "url": "http://localhost:11434",
    "model": "bge-m3"
  }
}
```

Everything else has sensible defaults.

> **Note for Claude:** The config file is gitignored — it won't be committed. If the user isn't sure what their PostgreSQL username is, `psql -c "SELECT current_user;"` will show it. On macOS/Linux, it's usually the OS username. On Windows, it's often `postgres` (the default superuser).

**Verify the build and config:**
```bash
node dist/index.js stats
```

This should connect to the database and print zeroes (no data yet). If it errors, the config is wrong — check database connection details.

---

## Step 4: Register the MCP Server

This makes Anamnesis tools available inside Claude Code sessions.

**Find your absolute path:**
```bash
# Print the path you'll need (run from the Anamnesis directory)
node -e "const p=require('path'); console.log(p.resolve('dist/mcp/index.js'))"
```

**Add to your Claude Code config file (`~/.claude.json`):**

The file `~/.claude.json` is Claude Code's global configuration. If it exists, it likely already has an `mcpServers` section — add `anamnesis` to it. If the file doesn't exist, create it.

```json
{
  "mcpServers": {
    "anamnesis": {
      "command": "node",
      "args": ["/absolute/path/to/Anamnesis/dist/mcp/index.js"],
      "env": {}
    }
  }
}
```

**Use the actual absolute path** from the command above. Examples:
- macOS/Linux: `/home/you/Anamnesis/dist/mcp/index.js`
- Windows: `D:/Projects/Anamnesis/dist/mcp/index.js` (forward slashes work)

> **Note for Claude:** On Windows, `~/.claude.json` is at `C:\Users\<username>\.claude.json`. This file is constantly written to by Claude Code (stats, caches), so the Edit tool may fail with "file modified since read." Use an atomic read-modify-write instead:
> ```bash
> node -e "const fs=require('fs'); const p='C:/Users/<user>/.claude.json'; const d=JSON.parse(fs.readFileSync(p,'utf8')); d.mcpServers=d.mcpServers||{}; d.mcpServers.anamnesis={command:'node',args:['/path/to/dist/mcp/index.js'],env:{}}; fs.writeFileSync(p,JSON.stringify(d,null,2));"
> ```
> Do NOT put MCP config in `~/.claude/.mcp.json` — that file is not read for global servers.

**Verify:** Start a new Claude Code session and check that Anamnesis tools are available:
```
Can you search Anamnesis for "test"?
```

If the tools aren't appearing, restart Claude Code. The MCP server loads at session start.

---

## Step 5: Initial Backfill

Now ingest your existing conversation transcripts:

```bash
node dist/index.js backfill
```

**What to expect:**
- Scans `~/.claude/projects/` for JSONL transcript files
- Parses each file, extracts turns, generates embeddings via Ollama
- Stores everything in PostgreSQL
- Links related sessions automatically
- **Time:** Depends on transcript volume. ~1-2 seconds per session on average. If you have hundreds of sessions, it may take 10-30 minutes.
- **Resumable:** Yes. If interrupted (Ctrl+C), re-run the same command — it skips already-ingested files via the idempotency tracker.
- **Progress:** Prints each file as it processes. Sessions with <5KB of content are skipped (not enough substance to index).

**After backfill, create HNSW indexes** for faster search:

```bash
psql -d anamnesis -c "CREATE INDEX idx_turns_embedding ON anamnesis_turns USING hnsw (embedding vector_cosine_ops);"
psql -d anamnesis -c "CREATE INDEX idx_sessions_embedding ON anamnesis_sessions USING hnsw (session_embedding vector_cosine_ops);"
```

These indexes are created after the initial load because HNSW builds a better graph when it can see all the data upfront. On a large dataset, index creation may take a minute.

**Optional — extract topics:**
```bash
node dist/index.js backfill-topics
```

This uses a local LLM (gemma3:12b by default) to extract 3-8 topic tags and a one-sentence summary per session. With the default `full` strategy, the extractor reads the entire session content, compresses it by stripping common English words (~25% reduction), splits into chunks, and merges tags across passes. Larger sessions take longer (a 100+ turn session might take 30-40 seconds), but produce more accurate tags. Set `topic_model.strategy` to `first_message` for faster but less thorough extraction.

**Performance note:** This step uses your GPU heavily. With `gemma3:12b`, expect ~1-2 seconds per session on a modern GPU (RTX 3070+). A full backfill of 500 sessions takes ~15-20 minutes. If your GPU is slower or you're running CPU-only, consider using `gemma3:4b` (set in config) — it produces comparable tags at 2-3x the speed with half the VRAM. Topics improve search quality and enable topic-based auto-linking, but Anamnesis works without them.

**Verify:**
```bash
node dist/index.js stats
```

Should show non-zero counts for sessions, turns, files, and links.

```bash
node dist/index.js search "something you worked on recently"
```

Should return relevant results.

---

## Step 6: Hooks (Optional but Recommended)

Hooks automate ingestion and add proactive recall. Install any combination — they're independent.

### Prerequisites for Python hooks

```bash
pip install psycopg2-binary
```

### SessionEnd — Auto-ingest after each session

This is the most important hook. It ingests the transcript immediately when you finish a session, keeping the database current.

**Install:** Copy `hooks/session-end.json` content into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "type": "command",
        "command": "node /absolute/path/to/Anamnesis/dist/index.js ingest-session $SESSION_ID",
        "timeout": 30000
      }
    ]
  }
}
```

Replace the path with your actual Anamnesis install path.

> **Note for Claude:** `~/.claude/settings.json` may already have hook entries. Merge into the existing structure — don't overwrite. The `$SESSION_ID` is provided by Claude Code at runtime. On Windows, the path should use forward slashes in the JSON.

### SessionStart — Proactive recall (Python)

Injects recent project context when you start a session. Claude gets immediate awareness of what you were working on.

1. Copy `hooks/session-start-recall.py` to `~/.claude/hooks/anamnesis-recall.py`
2. Add to `~/.claude/settings.json` under `hooks.SessionStart`:

```json
{
  "type": "command",
  "command": "python ~/.claude/hooks/anamnesis-recall.py",
  "timeout": 10000
}
```

### PreToolUse — Plan-mode recall (Python)

Searches Anamnesis when Claude enters plan mode, injecting relevant historical context.

1. Copy `hooks/plan-recall.py` to `~/.claude/hooks/plan-recall.py`
2. Add to `~/.claude/settings.json` under `hooks.PreToolUse`:

```json
{
  "type": "command",
  "command": "python ~/.claude/hooks/plan-recall.py",
  "timeout": 10000,
  "matcher": { "tool_name": "EnterPlanMode" }
}
```

### PreCompact — State capture + mid-session ingestion (Python)

Captures session state and triggers Anamnesis ingestion before context compaction. This is the bridge between compaction and memory — without it, pre-compaction context isn't in Anamnesis until SessionEnd.

1. Copy `hooks/pre-compact-ingest.py` to `~/.claude/hooks/pre-compact-ingest.py`
2. Edit `ANAMNESIS_DIR` at the top of the copied file to point to your Anamnesis installation
3. Add to `~/.claude/settings.json` under `hooks.PreCompact`:

```json
{
  "type": "command",
  "command": "python ~/.claude/hooks/pre-compact-ingest.py",
  "timeout": 10000
}
```

> **Note for Claude:** The `ANAMNESIS_DIR` constant in the script must be set to the absolute path of the Anamnesis installation (e.g., `D:/Projects/Anamnesis` or `/home/user/Anamnesis`). Use forward slashes even on Windows.

### Merging hooks into settings.json

If you're installing multiple hooks, your `~/.claude/settings.json` should look like:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "type": "command",
        "command": "node /path/to/Anamnesis/dist/index.js ingest-session $SESSION_ID",
        "timeout": 30000
      }
    ],
    "SessionStart": [
      {
        "type": "command",
        "command": "python ~/.claude/hooks/anamnesis-recall.py",
        "timeout": 10000
      }
    ],
    "PreToolUse": [
      {
        "type": "command",
        "command": "python ~/.claude/hooks/plan-recall.py",
        "timeout": 10000,
        "matcher": { "tool_name": "EnterPlanMode" }
      }
    ],
    "PreCompact": [
      {
        "type": "command",
        "command": "python ~/.claude/hooks/pre-compact-ingest.py",
        "timeout": 10000
      }
    ]
  }
}
```

> **Note for Claude:** If the user already has hooks in their settings.json, append to the existing arrays — don't replace them. Each hook type is an array, so multiple hooks can coexist.

---

## Step 7: Scheduled Ingestion (Optional, Windows)

If you want a safety net that catches sessions where the SessionEnd hook didn't fire:

```powershell
# Run in an Administrator PowerShell
powershell -ExecutionPolicy Bypass -File scripts/setup-scheduled-task.ps1
```

This creates a Windows Scheduled Task that runs `ingest-all` every 15 minutes in the background (no visible console window).

For macOS/Linux, use a cron job:
```bash
# crontab -e
*/15 * * * * cd /path/to/Anamnesis && node dist/index.js ingest-all >> /tmp/anamnesis-ingest.log 2>&1
```

---

## Step 8: Verify Everything

Run through this checklist:

```bash
# 1. Database has data
node dist/index.js stats

# 2. Search works
node dist/index.js search "test query"

# 3. MCP server responds (in a Claude Code session)
#    Ask Claude: "Search Anamnesis for 'database setup'"
```

If search returns results and the MCP tools work inside Claude Code, you're done.

---

## Troubleshooting

### "connection refused" or "could not connect to server"

PostgreSQL isn't running or isn't listening on the configured host/port.

```bash
pg_isready                          # Check if PostgreSQL is up
pg_isready -h localhost -p 5432     # Check specific host/port
```

On macOS: `brew services start postgresql@16`
On Linux: `sudo systemctl start postgresql`
On Windows: Check Services (Win+R → `services.msc`) for "postgresql-x64-16"

### "role 'anamnesis' does not exist"

The config expects a database user that doesn't exist. Either:
- Change `database.user` in config to your OS username (simplest), or
- Create the role: `createuser anamnesis`

### "could not open extension control file" for vector

pgvector extension isn't installed. See [pgvector installation](https://github.com/pgvector/pgvector#installation).

### Ollama: "connection refused" on embedding

Ollama isn't running or isn't on the expected URL.

```bash
curl http://localhost:11434/api/tags    # Should return model list
ollama list                             # Should show bge-m3
```

If Ollama is on a different machine, update `ollama.url` in your config.

### MCP tools not appearing in Claude Code

1. Verify the path in `~/.claude.json` is absolute and correct
2. Verify the build exists: `ls dist/mcp/index.js`
3. Restart Claude Code (MCP servers load at startup)
4. Check for JSON syntax errors in `~/.claude.json`

### "No results" from search

- Run `node dist/index.js stats` — if turns = 0, backfill hasn't run
- Check `transcripts_root` in config points to where Claude Code stores transcripts
- Verify transcripts exist: `ls ~/.claude/projects/`
- Try a broader query or skip the project filter

### Backfill seems stuck

Embedding is sequential by default (configurable via `concurrency.embedding`). Large transcripts take longer. Check that Ollama is responding:

```bash
curl -X POST http://localhost:11434/api/embeddings \
  -d '{"model": "bge-m3", "prompt": "test"}'
```

If Ollama is slow, your machine may be under memory pressure. The bge-m3 model needs ~1.5 GB of RAM.

---

## What's Next

Once Anamnesis is running, you'll accumulate session memory over time. Here are some optional enhancements:

- **Daily reporting** — Add the `reporting` section to your config and install the `/daily_duties` skill from `skills/`. See `skills/README.md`.
- **Task integration** — If you use [Nudge](https://github.com/MiccoHadje/Nudge) for task management, add the `tasks` section to your config to enrich reports with task completion data.
- **Topic extraction** — Run `backfill-topics` periodically to generate tags and summaries. This improves search and enables topic-based session linking.
- **Tune concurrency** — If you have a powerful machine, increase `concurrency.embedding` (default 4) for faster backfills.
