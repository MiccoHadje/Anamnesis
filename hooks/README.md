# Anamnesis Hooks

Claude Code hooks that integrate Anamnesis into your workflow. These are optional but recommended for the best experience.

## Architecture (v1.3+)

All hooks route through a single Python shim (`anamnesis-shim.py`) that communicates with the Anamnesis HTTP server. The server handles all logic (database queries, embeddings, ingestion). This replaced the previous approach of standalone Python scripts with separate database connections.

```
Claude Code hook event
  -> anamnesis-shim.py (reads stdin JSON, POSTs to HTTP server)
  -> Anamnesis HTTP server (port 3851)
  -> response JSON (printed to stdout for Claude Code)
```

The shim has **no dependencies** beyond the Python standard library. If the server isn't running, the SessionStart hook auto-starts it. All other hooks exit gracefully if the server is unreachable.

## Prerequisites

- **Python 3** (standard library only, no pip packages needed)
- **Node.js 18+** (for the HTTP server)
- Anamnesis built (`npm run build`)

## Installation

Add to `~/.claude/settings.json`. Replace `/path/to/Anamnesis` with your actual path (use forward slashes, even on Windows):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python /path/to/Anamnesis/hooks/anamnesis-shim.py /hooks/session-start",
            "timeout": 15000,
            "statusMessage": "Recalling past sessions..."
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python /path/to/Anamnesis/hooks/anamnesis-shim.py /hooks/session-end",
            "timeout": 30000,
            "statusMessage": "Saving to Anamnesis..."
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python /path/to/Anamnesis/hooks/anamnesis-shim.py /hooks/pre-compact",
            "timeout": 15000,
            "statusMessage": "Capturing state + ingesting to Anamnesis..."
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python /path/to/Anamnesis/hooks/anamnesis-shim.py /hooks/post-compact",
            "timeout": 15000,
            "statusMessage": "Storing compact summary..."
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "EnterPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "python /path/to/Anamnesis/hooks/anamnesis-shim.py /hooks/plan-recall",
            "timeout": 15000,
            "statusMessage": "Searching past sessions..."
          }
        ]
      }
    ]
  }
}
```

If you already have hooks in your settings.json, merge these entries into the existing arrays.

## Hooks

### anamnesis-shim.py - Universal hook shim

The single entry point for all Anamnesis hooks. Takes the server endpoint as a CLI argument.

| Hook Event | Endpoint | What it does |
|------------|----------|--------------|
| SessionStart | `/hooks/session-start` | Queries recent sessions for the current project, checks task focus, injects context. **Auto-starts the server** if not running. |
| SessionEnd | `/hooks/session-end` | Triggers ingestion of the session transcript. |
| PreCompact | `/hooks/pre-compact` | Reads transcript tail to extract working state (files, commands, errors), triggers background ingestion, injects continuation prompt. |
| PostCompact | `/hooks/post-compact` | Stores the compact summary in the database. Sessions can compact multiple times. |
| PlanRecall | `/hooks/plan-recall` | Embeds the user's planning query, searches past sessions, injects results as additional planning context. Falls back to task focus if no query. |

### Configuration

The shim reads two environment variables (both optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `ANAMNESIS_SERVER_URL` | `http://127.0.0.1:3851` | HTTP server URL |
| `ANAMNESIS_DIR` | `D:/Projects/Anamnesis` | Path to Anamnesis installation (for auto-start) |

Set `ANAMNESIS_DIR` if your installation is in a different location. You can set it in the hook command:

```json
{
  "type": "command",
  "command": "ANAMNESIS_DIR=/home/you/Anamnesis python /home/you/Anamnesis/hooks/anamnesis-shim.py /hooks/session-start"
}
```

Or on Windows (Git Bash):
```json
{
  "type": "command",
  "command": "python D:/your/path/Anamnesis/hooks/anamnesis-shim.py /hooks/session-start"
}
```

## Legacy Hooks (v1.2 and earlier)

The following standalone hooks are preserved in this directory for reference but are no longer the recommended approach:

- `session-end.json` - Direct CLI invocation for SessionEnd
- `session-start-recall.py` - Standalone SessionStart with psycopg2
- `plan-recall.py` - Standalone plan-mode recall with psycopg2 + Ollama
- `pre-compact-ingest.py` - Standalone PreCompact with psycopg2

These required `pip install psycopg2-binary` and each maintained its own database connection. The shim approach is simpler (no Python dependencies) and more efficient (shared server process).

## Upgrading from v1.2

1. Replace your hook entries in `~/.claude/settings.json` with the shim versions above
2. Verify: start a new Claude Code session and check for the "Recalling past sessions..." status message
3. Optionally remove old hook files from `~/.claude/hooks/` (`anamnesis-recall.py`, `plan-recall.py`, `pre-compact-ingest.py`)
