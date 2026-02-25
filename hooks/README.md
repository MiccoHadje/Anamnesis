# Anamnesis Hooks

Claude Code hooks that integrate Anamnesis into your workflow. These are optional but recommended for the best experience.

## Prerequisites

```bash
pip install psycopg2-binary
```

## Hooks

### session-end.json — Auto-ingest on session end

Automatically ingests the session transcript when a Claude Code session ends.

**Install:** Add the contents of `session-end.json` to your `~/.claude/settings.json` under `hooks.SessionEnd`. Update the path to point to your Anamnesis installation.

### session-start-recall.py — Proactive context at session start

When you start a new Claude Code session, this hook queries Anamnesis for recent sessions on the same project and injects them into Claude's context. This gives Claude immediate awareness of your recent work.

**Install:**
1. Copy to `~/.claude/hooks/anamnesis-recall.py`
2. Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "python ~/.claude/hooks/anamnesis-recall.py",
        "timeout": 10000
      }
    ]
  }
}
```

### plan-recall.py — Context-aware planning

When Claude enters plan mode, this hook searches Anamnesis using the user's planning query and injects relevant past sessions as context. This means planning always starts with historical awareness.

**Install:**
1. Copy to `~/.claude/hooks/plan-recall.py`
2. Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "python ~/.claude/hooks/plan-recall.py",
        "timeout": 10000,
        "matcher": { "tool_name": "EnterPlanMode" }
      }
    ]
  }
}
```

### pre-compact-ingest.py — State capture + ingestion before compaction

When Claude Code's context window fills and compaction occurs, this hook:
1. Reads the tail of the transcript to extract key state (files modified, recent commands, errors)
2. Triggers Anamnesis ingestion of the current session in the background (non-blocking)
3. Injects a continuation prompt so the post-compaction model retains tactical context

This is the bridge between compaction and memory. Without it, everything discussed before compaction is lost until SessionEnd fires. With it, the transcript is searchable in Anamnesis immediately after compaction.

**Install:**
1. Copy to `~/.claude/hooks/pre-compact-ingest.py`
2. Edit `ANAMNESIS_DIR` at the top of the file to point to your Anamnesis installation
3. Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
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

## Configuration

All hooks read configuration from environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANAMNESIS_DB_HOST` | `localhost` | PostgreSQL host |
| `ANAMNESIS_DB_NAME` | `anamnesis` | Database name |
| `ANAMNESIS_DB_USER` | `anamnesis` | Database user |
| `ANAMNESIS_DB_PASSWORD` | (empty) | Database password (uses trust auth if empty) |
| `ANAMNESIS_OLLAMA_URL` | `http://localhost:11434` | Ollama server URL (plan-recall only) |
| `ANAMNESIS_OLLAMA_MODEL` | `bge-m3` | Embedding model (plan-recall only) |

## Customization

### Project name derivation

Both `session-start-recall.py` and `plan-recall.py` derive the project name from the current working directory. The default logic handles Claude Code's encoded directory format (`D--Projects-MyProject` → `MyProject`) and falls back to the last path component.

If your directory layout is different, edit the `derive_project_name()` function in each hook.
