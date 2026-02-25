#!/usr/bin/env python3
"""SessionStart hook: Inject recent Anamnesis session history into Claude's context.

Install:
  1. Copy this file to ~/.claude/hooks/anamnesis-recall.py
  2. Add to ~/.claude/settings.json under hooks.SessionStart:
     {
       "type": "command",
       "command": "python ~/.claude/hooks/anamnesis-recall.py",
       "timeout": 10000
     }
  3. pip install psycopg2-binary (or psycopg2)

Configuration:
  Set environment variables to override defaults:
    ANAMNESIS_DB_HOST (default: localhost)
    ANAMNESIS_DB_NAME (default: anamnesis)
    ANAMNESIS_DB_USER (default: anamnesis)
    ANAMNESIS_DB_PASSWORD (default: empty, uses trust/peer auth)
"""
import sys
import json
import os
import re

# ANSI escape codes
BOLD = "\033[1m"
RESET = "\033[0m"
CYAN = "\033[36m"
DIM = "\033[2m"
MAGENTA = "\033[35m"

# Config from environment
DB_HOST = os.environ.get("ANAMNESIS_DB_HOST", "localhost")
DB_NAME = os.environ.get("ANAMNESIS_DB_NAME", "anamnesis")
DB_USER = os.environ.get("ANAMNESIS_DB_USER", "anamnesis")
DB_PASSWORD = os.environ.get("ANAMNESIS_DB_PASSWORD", "")

# Derive project name from CWD — adapt this regex to your directory layout.
# Default pattern matches: /path/to/Projects/<Name> or C:\Projects\<Name>
PROJECT_PATH_RE = re.compile(r'[/\\]([^/\\]+)$')


def derive_project_name(cwd: str) -> str | None:
    """Extract project name from CWD path.

    Override this function to match your directory layout.
    The returned name must match the project_name stored in anamnesis_sessions.
    """
    if not cwd:
        return None
    # Try Claude Code's encoded directory format: D--Projects-MyProject
    encoded = re.search(r'[A-Za-z]--(?:Projects-)?(.+)$', os.path.basename(cwd))
    if encoded:
        return encoded.group(1)
    # Fall back to last directory component
    m = PROJECT_PATH_RE.search(cwd.rstrip('/\\'))
    return m.group(1) if m else None


def get_recent_sessions(project_name: str, conn) -> list:
    """Get recent non-subagent sessions for this project (last 7 days, limit 5)."""
    cur = conn.cursor()
    cur.execute("""
        SELECT session_id, started_at, turn_count, files_touched[1:5], tools_used
        FROM anamnesis_sessions
        WHERE project_name = %s AND NOT is_subagent
          AND started_at >= NOW() - INTERVAL '7 days'
        ORDER BY started_at DESC LIMIT 5
    """, (project_name,))
    return cur.fetchall()


def format_files(files: list[str] | None, max_show: int = 3) -> str:
    """Format file list for display, showing basenames."""
    if not files:
        return ""
    basenames = []
    for f in files:
        parts = f.replace('\\', '/').split('/')
        basenames.append(parts[-1] if parts else f)
    shown = basenames[:max_show]
    extra = len(basenames) - max_show
    result = ", ".join(shown)
    if extra > 0:
        result += f" (+{extra})"
    return result


def main():
    # Read hook input from stdin
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        hook_input = {}

    cwd = hook_input.get("cwd", "")
    project_name = derive_project_name(cwd)

    if not project_name:
        sys.stderr.write("anamnesis-recall: no project name derived from cwd\n")
        sys.exit(0)

    # Connect to Anamnesis DB
    try:
        import psycopg2
    except ImportError:
        sys.stderr.write("anamnesis-recall: psycopg2 not installed\n")
        sys.exit(0)

    try:
        conn_kwargs = dict(host=DB_HOST, database=DB_NAME, user=DB_USER)
        if DB_PASSWORD:
            conn_kwargs["password"] = DB_PASSWORD
        conn = psycopg2.connect(**conn_kwargs)
    except Exception as e:
        sys.stderr.write(f"anamnesis-recall: DB connection failed: {e}\n")
        sys.exit(0)

    sessions = get_recent_sessions(project_name, conn)

    if not sessions:
        conn.close()
        sys.exit(0)

    # Build output
    display_lines = []
    context_lines = []

    display_lines.append(f"{BOLD}{MAGENTA}RECALL:{RESET} {DIM}Recent sessions on @{project_name}{RESET}")
    context_lines.append(f"Anamnesis - Recent sessions on @{project_name}:")

    for session_id, started_at, turn_count, files, tools in sessions:
        date_str = f"{started_at.month}/{started_at.day}" if started_at else "?"
        files_str = format_files(files)
        line = f"  {date_str}: {turn_count} turns"
        if files_str:
            line += f" - {files_str}"
        display_lines.append(f"{DIM}{line}{RESET}")
        context_lines.append(line)

    conn.close()

    formatted = '\n'.join(display_lines)
    plain = '\n'.join(context_lines)

    print(json.dumps({
        "systemMessage": formatted,
        "context": plain
    }))

    sys.exit(0)


if __name__ == "__main__":
    main()
