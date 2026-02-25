#!/usr/bin/env python3
"""PreCompact hook: Capture session state and trigger Anamnesis ingestion before compaction.

When Claude Code's context window fills up and compaction occurs, this hook:
  1. Reads the tail of the transcript to extract key state (files modified, commands, errors)
  2. Triggers Anamnesis ingestion of the current session (background, non-blocking)
  3. Injects a continuation prompt so the post-compaction model retains tactical context

The ingestion ensures that everything discussed before compaction is searchable in
Anamnesis immediately — so the post-compaction continuation (and future sessions)
can find it via anamnesis_search.

Install:
  1. Copy to ~/.claude/hooks/pre-compact-ingest.py
  2. Edit ANAMNESIS_DIR below to point to your Anamnesis installation
  3. Add to ~/.claude/settings.json under hooks.PreCompact:
     {
       "type": "command",
       "command": "python ~/.claude/hooks/pre-compact-ingest.py",
       "timeout": 10000
     }
  4. pip install psycopg2-binary (or psycopg2) — optional, for richer context injection

Configuration:
  ANAMNESIS_DIR: Path to Anamnesis installation (edit constant below)
  ANAMNESIS_DB_HOST (default: localhost)
  ANAMNESIS_DB_NAME (default: anamnesis)
  ANAMNESIS_DB_USER (default: anamnesis)
  ANAMNESIS_DB_PASSWORD (default: empty)
"""
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────
# Set this to your Anamnesis installation directory
ANAMNESIS_DIR = "/path/to/Anamnesis"

# How many JSONL lines to read from the end of the transcript
MAX_TRANSCRIPT_LINES = 200

# DB config for optional recent-session context injection
DB_HOST = os.environ.get("ANAMNESIS_DB_HOST", "localhost")
DB_NAME = os.environ.get("ANAMNESIS_DB_NAME", "anamnesis")
DB_USER = os.environ.get("ANAMNESIS_DB_USER", "anamnesis")
DB_PASSWORD = os.environ.get("ANAMNESIS_DB_PASSWORD", "")


def log(msg: str):
    sys.stderr.write(f"pre-compact-ingest: {msg}\n")


# ── Transcript parsing ─────────────────────────────────────────────────────

def tail_jsonl(path: str, max_lines: int) -> list[dict]:
    """Read last max_lines from a JSONL file."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
            lines = all_lines[-max_lines:]
    except (FileNotFoundError, PermissionError, OSError):
        return []

    entries = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def extract_state(entries: list[dict]) -> dict:
    """Extract key state from transcript entries.

    Claude Code transcripts use this structure:
      - type: "assistant" → message.content[] contains tool_use blocks
      - type: "tool_result" → content has tool output (may contain errors)
      - type: "human"/"user" → user messages
    """
    files_modified = []
    bash_commands = []
    errors = []
    task_context = []
    cwd = None

    for entry in entries:
        msg_type = entry.get("type", "")

        # Assistant messages contain tool_use blocks and text in message.content[]
        if msg_type == "assistant":
            message = entry.get("message", {})
            content = message.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue

                    if block.get("type") == "tool_use":
                        name = block.get("name", "")
                        inp = block.get("input", {})

                        if name in ("Edit", "Write"):
                            fp = inp.get("file_path", "")
                            if fp and fp not in files_modified:
                                files_modified.append(fp)

                        elif name == "Bash":
                            cmd = inp.get("command", "")
                            if cmd and len(cmd) < 200:
                                bash_commands.append(cmd)

                    elif block.get("type") == "text":
                        # Extract task/focus context from assistant text
                        # PM-agnostic: captures any mention of task status
                        text = block.get("text", "")
                        for line in text.split("\n"):
                            line_lower = line.lower().strip()
                            if any(kw in line_lower for kw in [
                                "focus:", "working on", "completed",
                                "in_progress", "in progress", "blocked",
                                "started:", "done:", "finished",
                            ]):
                                if 5 < len(line.strip()) < 150:
                                    task_context.append(line.strip())

        # Tool results may contain errors
        elif msg_type == "tool_result":
            result_content = entry.get("content", "")
            if isinstance(result_content, str) and "error" in result_content.lower():
                if len(result_content) < 300:
                    errors.append(result_content[:200])

        # Track working directory from any entry that has it
        if "cwd" in entry:
            cwd = entry["cwd"]

    return {
        "files_modified": files_modified[-15:],
        "bash_commands": bash_commands[-10:],
        "task_context": task_context[-5:],
        "errors": errors[-5:],
        "cwd": cwd,
    }


def format_continuation(state: dict, trigger: str) -> str:
    """Format a concise continuation prompt for post-compaction context."""
    parts = []

    if state["files_modified"]:
        basenames = [os.path.basename(f) for f in state["files_modified"][-8:]]
        parts.append(f"Files touched: {', '.join(f'`{b}`' for b in basenames)}")

    if state["bash_commands"]:
        recent = state["bash_commands"][-3:]
        parts.append(f"Recent commands: {'; '.join(f'`{c[:80]}`' for c in recent)}")

    if state["task_context"]:
        parts.append(f"Task context: {state['task_context'][-1]}")

    if state["errors"]:
        parts.append(f"Last error: {state['errors'][-1][:100]}")

    if not parts:
        return "Context compacted. No significant pre-compaction state captured."

    summary = " | ".join(parts)
    return (
        f"PRE-COMPACTION STATE ({trigger}): {summary}\n"
        f"Continue the current work. The session transcript has been "
        f"ingested into Anamnesis — use anamnesis_search or anamnesis_session "
        f"to retrieve detailed pre-compaction context if needed."
    )


# ── Anamnesis ingestion ────────────────────────────────────────────────────

def trigger_ingestion(session_id: str):
    """Fire-and-forget: ingest the current session into Anamnesis."""
    cli_path = os.path.join(ANAMNESIS_DIR, "dist", "index.js")
    if not os.path.isfile(cli_path):
        log(f"Anamnesis CLI not found at {cli_path} — skipping ingestion")
        return

    try:
        # Run in background — don't block compaction
        cmd = ["node", cli_path, "ingest-session", session_id]
        subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            # Detach on Windows
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        log(f"Triggered background ingestion for session {session_id[:8]}")
    except Exception as e:
        log(f"Failed to trigger ingestion: {e}")


# ── State file ─────────────────────────────────────────────────────────────

STATE_FILE = Path.home() / ".claude" / "compact-state.md"


def write_state_file(state: dict, trigger: str):
    """Write full state snapshot to disk for reference."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        "# Session State Snapshot",
        "",
        f"**Captured**: {now} (pre-compaction, trigger: {trigger})",
        f"**Working Directory**: {state.get('cwd', 'unknown')}",
        "",
    ]

    if state["files_modified"]:
        lines.append("## Files Modified")
        for f in state["files_modified"]:
            lines.append(f"- `{f}`")
        lines.append("")

    if state["bash_commands"]:
        lines.append("## Recent Commands")
        for cmd in state["bash_commands"]:
            lines.append(f"- `{cmd}`")
        lines.append("")

    if state["task_context"]:
        lines.append("## Task Context")
        for t in state["task_context"]:
            lines.append(f"- {t}")
        lines.append("")

    if state["errors"]:
        lines.append("## Recent Errors")
        for e in state["errors"]:
            lines.append(f"- {e[:150]}")
        lines.append("")

    try:
        STATE_FILE.write_text("\n".join(lines), encoding="utf-8")
    except OSError:
        pass


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    try:
        data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    transcript_path = data.get("transcript_path", "")
    session_id = data.get("session_id", "unknown")
    trigger = data.get("trigger", "auto")  # "auto" or "manual"
    cwd = data.get("cwd", "")

    # 1. Extract state from transcript tail
    entries = tail_jsonl(transcript_path, MAX_TRANSCRIPT_LINES) if transcript_path else []
    state = extract_state(entries)

    if not state["cwd"]:
        state["cwd"] = cwd

    # 2. Write state snapshot to file (for debugging/reference)
    write_state_file(state, trigger)

    # 3. Trigger Anamnesis ingestion (background, non-blocking)
    if session_id and session_id != "unknown":
        trigger_ingestion(session_id)

    # 4. Output continuation context
    continuation = format_continuation(state, trigger)

    json.dump({"systemMessage": continuation}, sys.stdout)
    sys.exit(0)


if __name__ == "__main__":
    main()
