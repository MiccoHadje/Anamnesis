---
name: anamnesis_install
description: Guided installation and health check for Anamnesis. First run walks through full setup; subsequent runs verify system health.
user_invocable: true
---

# /anamnesis_install — Setup & Health Check

Detects the current installation state and adapts: guides new users through setup step-by-step, or runs a health check on existing installations.

## Procedure

### Step 0: Detect Installation State

Run ALL of these checks in parallel to determine what's already set up:

1. **Node.js**: `node --version` — need 18+
2. **PostgreSQL**: `pg_isready -h localhost -p 5432` (or configured host/port)
3. **pgvector**: `psql -d anamnesis -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';" 2>/dev/null`
4. **Ollama**: `curl -s http://localhost:11434/api/tags` — check for bge-m3 in response
5. **Database tables**: `psql -d anamnesis -c "\dt anamnesis_*" 2>/dev/null`
6. **Config file**: Check if `anamnesis.config.json` exists in the project root
7. **Build**: Check if `dist/mcp/index.js` exists
8. **MCP registration**: Read `~/.claude.json` and check for `anamnesis` in `mcpServers`
9. **Hooks**: Read `~/.claude/settings.json` and check for Anamnesis hook entries
10. **Data**: `node dist/index.js stats 2>/dev/null` (only if build exists)
11. **HNSW indexes**: `psql -d anamnesis -c "SELECT indexname FROM pg_indexes WHERE indexname LIKE 'idx_%_embedding';" 2>/dev/null`
12. **Python hooks dependency**: `python -c "import psycopg2" 2>/dev/null`

Classify the state:

- **Fresh install** — No database, no config, no build. Go to Step 1.
- **Partial install** — Some components present, some missing. Go to the first incomplete step.
- **Fully installed** — Everything present. Go to Health Check.

Print a status summary before proceeding:

```
Anamnesis Installation Status
─────────────────────────────
  Node.js 22.x          ✓
  PostgreSQL 16          ✓
  pgvector 0.8.0         ✓
  Ollama (bge-m3)        ✓
  Database tables        ✓
  Config file            ✓
  Build                  ✓
  MCP registered         ✗ ← next step
  Hooks                  ✗
  Data (sessions)        0
  HNSW indexes           ✗
```

Then either proceed to the next incomplete step or run the health check.

---

## Installation Steps

Complete each step, verify it worked, then move to the next. Do NOT skip ahead — each step depends on the previous.

### Step 1: Prerequisites

Check Node.js, PostgreSQL, and Ollama. For any that are missing, provide **platform-specific install instructions**:

**Detect platform:**
- Check the `platform` from the environment info (win32, darwin, linux)
- Tailor commands accordingly (brew for macOS, apt for Debian/Ubuntu, choco/winget for Windows)

**Node.js** (if missing or <18):
- macOS: `brew install node`
- Ubuntu: `sudo apt install nodejs npm`
- Windows: Download from nodejs.org or `winget install OpenJS.NodeJS.LTS`

**PostgreSQL** (if not running):
- macOS: `brew install postgresql@16 && brew services start postgresql@16`
- Ubuntu: `sudo apt install postgresql postgresql-contrib`
- Windows: Direct to postgresql.org/download/windows

**pgvector** (if missing):
- macOS: `brew install pgvector`
- Ubuntu: `sudo apt install postgresql-16-pgvector` (match PG version)
- Windows: Direct to pgvector releases on GitHub

**Ollama** (if not running):
- macOS/Linux: `curl -fsSL https://ollama.com/install.sh | sh`
- Windows: Direct to ollama.com/download/windows

After installing prerequisites, pull the embedding model:
```bash
ollama pull bge-m3
```

**Ask the user** before pulling optional models:
> bge-m3 (required, ~1.5 GB) is installed. Do you also want gemma3:12b (~7 GB) for automatic topic extraction? This is optional — Anamnesis works without it.

Verify all prerequisites pass before proceeding.

### Step 2: Database Setup

If the `anamnesis` database doesn't exist:

```bash
createdb anamnesis
```

If tables don't exist:

```bash
psql -d anamnesis -f src/db/schema.sql
```

**Verify:** `psql -d anamnesis -c "\dt anamnesis_*"` should show 4 tables.

**If `createdb` fails** with "role does not exist":
- Determine the user's PostgreSQL superuser (usually `postgres` on Windows, OS username on macOS/Linux)
- Guide them through: `psql -U postgres -c "CREATE ROLE <username> WITH LOGIN CREATEDB;"`

**If `psql` can't connect:**
- Check `pg_isready`
- Check if PostgreSQL service is running
- On Windows, check that `psql` is in PATH

### Step 3: Configure

If `anamnesis.config.json` doesn't exist:

1. Copy the example: `cp anamnesis.config.example.json anamnesis.config.json`
2. Determine the correct `database.user`:
   ```bash
   psql -c "SELECT current_user;"
   ```
3. Update `database.user` in the config to match
4. Verify `transcripts_root` — check that the path exists:
   ```bash
   ls ~/.claude/projects/
   ```
5. If Ollama is on a non-default URL, update `ollama.url`

If the config already exists, verify it connects:
```bash
node dist/index.js stats 2>/dev/null || echo "Config issue — check database settings"
```

**Keep it minimal for first-time setup.** Only configure required fields. Advanced options (topics, reporting, tasks) can be added later.

### Step 4: Build

```bash
npm install
npm run build
```

**Verify:** `ls dist/mcp/index.js` should exist.

If the build fails, check for TypeScript errors in the output. Common causes:
- Wrong Node.js version (need 18+)
- Missing `npm install`

### Step 5: MCP Registration

Read `~/.claude.json` to check current state. If `anamnesis` is not in `mcpServers`:

Determine the absolute path to `dist/mcp/index.js`:
```bash
node -e "const p=require('path'); console.log(p.resolve('dist/mcp/index.js'))"
```

**On Windows**, use an atomic read-modify-write since Claude Code constantly writes to this file:
```bash
node -e "const fs=require('fs'); const p=process.env.HOME||process.env.USERPROFILE; const f=p+'/.claude.json'; const d=JSON.parse(fs.readFileSync(f,'utf8')); d.mcpServers=d.mcpServers||{}; d.mcpServers.anamnesis={command:'node',args:['THE_ABSOLUTE_PATH'],env:{}}; fs.writeFileSync(f,JSON.stringify(d,null,2));"
```

**On macOS/Linux**, the Edit tool usually works for `~/.claude.json`.

Tell the user:
> MCP server registered. **Restart Claude Code** for the new MCP server to load. After restarting, run `/anamnesis_install` again to continue setup.

If the session is already in Claude Code and the MCP tools are already showing (because this is a re-run), skip the restart notice.

### Step 6: Initial Backfill

```bash
node dist/index.js backfill
```

Before running, tell the user what to expect:
> This scans your Claude Code transcripts, generates embeddings, and stores them in the database. It's resumable — safe to interrupt and re-run. Time depends on how many sessions you have.

After backfill completes, show stats:
```bash
node dist/index.js stats
```

Report the results:
> Ingested {N} sessions with {M} turns. Your conversation history is now searchable.

### Step 7: HNSW Indexes

If the HNSW indexes don't exist and there's data in the database:

```bash
psql -d anamnesis -c "CREATE INDEX idx_turns_embedding ON anamnesis_turns USING hnsw (embedding vector_cosine_ops);"
psql -d anamnesis -c "CREATE INDEX idx_sessions_embedding ON anamnesis_sessions USING hnsw (session_embedding vector_cosine_ops);"
```

> These speed up search queries. They're created after backfill so the index can see all the data upfront.

### Step 8: Hooks

Ask the user which hooks they want:

> Anamnesis has four optional hooks that automate ingestion and add proactive recall:
>
> 1. **SessionEnd auto-ingest** — Ingests transcripts when you end a session (recommended)
> 2. **SessionStart recall** — Injects recent project context when you start a session (recommended, needs Python + psycopg2)
> 3. **Plan-mode recall** — Searches history when you enter plan mode (recommended, needs Python + psycopg2)
> 4. **PreCompact state capture** — Captures state + ingests transcript before context compaction (recommended, needs Python)
>
> Which hooks would you like to install? (1, 2, 3, 4, all, or none)

For each selected hook:

1. Check if `psycopg2` is available (for Python hooks): `python -c "import psycopg2"`
   - If missing: `pip install psycopg2-binary`

2. Read existing `~/.claude/settings.json` to preserve other hooks

3. **SessionEnd:** Add to `hooks.SessionEnd` array:
   ```json
   {
     "type": "command",
     "command": "node /absolute/path/to/Anamnesis/dist/index.js ingest-session $SESSION_ID",
     "timeout": 30000
   }
   ```

4. **SessionStart:** Copy `hooks/session-start-recall.py` to `~/.claude/hooks/anamnesis-recall.py`, then add to `hooks.SessionStart` array:
   ```json
   {
     "type": "command",
     "command": "python ~/.claude/hooks/anamnesis-recall.py",
     "timeout": 10000
   }
   ```

5. **Plan-mode recall:** Copy `hooks/plan-recall.py` to `~/.claude/hooks/plan-recall.py`, then add to `hooks.PreToolUse` array:
   ```json
   {
     "type": "command",
     "command": "python ~/.claude/hooks/plan-recall.py",
     "timeout": 10000,
     "matcher": { "tool_name": "EnterPlanMode" }
   }
   ```

6. **PreCompact state capture:** Copy `hooks/pre-compact-ingest.py` to `~/.claude/hooks/pre-compact-ingest.py`. Then determine the absolute path to the Anamnesis installation:
   ```bash
   node -e "console.log(require('path').resolve('.'))"
   ```
   Edit `ANAMNESIS_DIR` at the top of the copied file to use this path (forward slashes, even on Windows). Then add to `hooks.PreCompact` array:
   ```json
   {
     "type": "command",
     "command": "python ~/.claude/hooks/pre-compact-ingest.py",
     "timeout": 10000
   }
   ```

**IMPORTANT:** Merge into existing arrays — do NOT replace existing hook entries from other tools.

### Step 9: Verify & Test

Run a search to confirm everything works end-to-end:

```bash
node dist/index.js search "test"
```

If in a Claude Code session with MCP tools loaded, also test:
> Use `anamnesis_search` to search for "test" — this verifies the MCP server is working.

### Step 10: Summary

Print a final summary:

```
Anamnesis Installation Complete
────────────────────────────────
  Database:    {N} sessions, {M} turns
  Search:      hybrid (vector + full-text)
  MCP server:  registered
  Hooks:       {list installed hooks}
  HNSW:        active

Next steps:
  - Topic extraction: node dist/index.js backfill-topics
    (Optional — uses gemma3:12b to tag/summarize sessions)
  - Daily reporting: Add "reporting" section to config
    (See anamnesis.config.example.json)
  - Full docs: INSTALL.md
```

---

## Health Check Mode

When all components are already installed, run a health check instead of installation:

### Checks (run in parallel where possible)

1. **PostgreSQL connection** — `psql -d anamnesis -c "SELECT 1;"`
2. **Ollama connection** — `curl -s http://localhost:11434/api/tags` and verify bge-m3 present
3. **Data freshness** — `node dist/index.js stats` — report session/turn counts
4. **MCP registration** — Read `~/.claude.json`, verify path exists and build is current
5. **Hook status** — Read `~/.claude/settings.json`, list which hooks are installed
6. **HNSW indexes** — Check if they exist
7. **Config validation** — Run `node -e "require('./dist/util/config.js').getConfig()"` to catch config errors
8. **Pending ingestion** — Run `node dist/index.js ingest-all --dry-run 2>/dev/null` or check for uninigested transcripts
9. **Search test** — `node dist/index.js search "test"` — verify results come back

### Report format

```
Anamnesis Health Check
──────────────────────
  PostgreSQL       ✓  connected (localhost:5432)
  Ollama           ✓  bge-m3 loaded
  Database         ✓  {N} sessions, {M} turns, {L} links
  MCP server       ✓  registered, build current
  Hooks            ✓  SessionEnd, SessionStart, PreToolUse, PreCompact
  HNSW indexes     ✓  2 active
  Config           ✓  valid
  Search           ✓  returning results

  Last ingestion:  {date from most recent session}
  Topics covered:  {count} of {total} sessions
```

If any check fails, report the issue and offer to fix it.

---

## Important Notes

- **Never skip verification steps.** Each step confirms the previous one worked before moving on.
- **Preserve existing config.** When editing `~/.claude.json` or `~/.claude/settings.json`, always read first and merge — never overwrite.
- **Platform awareness.** Detect the platform and give appropriate commands. Don't give `brew` commands on Linux or `apt` commands on macOS.
- **Be honest about failures.** If a step fails, diagnose the cause rather than retrying blindly. Check INSTALL.md troubleshooting section if needed.
- **Minimal first-time config.** Don't configure reporting, tasks, or topic models during initial setup. Get search working first. Mention these as optional next steps at the end.
