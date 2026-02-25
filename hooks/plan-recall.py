#!/usr/bin/env python3
"""PreToolUse hook for EnterPlanMode: Search Anamnesis for relevant past context.

Fires whenever Claude enters plan mode (via /plan skill, user request, or
proactive decision). Extracts the user's last message from the transcript
as the search query. Injects results as additionalContext so Claude plans
with historical awareness.

Install:
  1. Copy this file to ~/.claude/hooks/plan-recall.py
  2. Add to ~/.claude/settings.json under hooks.PreToolUse:
     {
       "type": "command",
       "command": "python ~/.claude/hooks/plan-recall.py",
       "timeout": 10000,
       "matcher": { "tool_name": "EnterPlanMode" }
     }
  3. pip install psycopg2-binary (or psycopg2)

Configuration:
  Set environment variables to override defaults:
    ANAMNESIS_DB_HOST (default: localhost)
    ANAMNESIS_DB_NAME (default: anamnesis)
    ANAMNESIS_DB_USER (default: anamnesis)
    ANAMNESIS_DB_PASSWORD (default: empty)
    ANAMNESIS_OLLAMA_URL (default: http://localhost:11434)
    ANAMNESIS_OLLAMA_MODEL (default: bge-m3)
"""
import sys
import json
import os
import re
import urllib.request

# --- Config from environment ---
OLLAMA_URL = os.environ.get("ANAMNESIS_OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("ANAMNESIS_OLLAMA_MODEL", "bge-m3")
DB_HOST = os.environ.get("ANAMNESIS_DB_HOST", "localhost")
DB_NAME = os.environ.get("ANAMNESIS_DB_NAME", "anamnesis")
DB_USER = os.environ.get("ANAMNESIS_DB_USER", "anamnesis")
DB_PASSWORD = os.environ.get("ANAMNESIS_DB_PASSWORD", "")
MAX_RESULTS = 5
MIN_SIMILARITY = 0.3

# Adapt this regex to your directory layout
PROJECT_PATH_RE = re.compile(r'[/\\]([^/\\]+)$')


def derive_project_name(cwd: str) -> str | None:
    if not cwd:
        return None
    encoded = re.search(r'[A-Za-z]--(?:Projects-)?(.+)$', os.path.basename(cwd))
    if encoded:
        return encoded.group(1)
    m = PROJECT_PATH_RE.search(cwd.rstrip('/\\'))
    return m.group(1) if m else None


def get_last_user_message(transcript_path: str) -> str | None:
    """Read the transcript JSONL and extract the last human message."""
    try:
        last_user_msg = None
        with open(transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") == "human":
                    msg = entry.get("message", {})
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        parts = []
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                parts.append(block.get("text", ""))
                            elif isinstance(block, str):
                                parts.append(block)
                        content = " ".join(parts)
                    if content and len(content.strip()) > 5:
                        last_user_msg = content.strip()
        return last_user_msg
    except Exception:
        return None


def get_embedding(text: str) -> list[float] | None:
    """Get embedding from Ollama bge-m3."""
    try:
        data = json.dumps({"model": OLLAMA_MODEL, "prompt": text}).encode()
        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/embeddings",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            return result.get("embedding")
    except Exception:
        return None


def search_anamnesis(embedding: list[float], project: str | None) -> list[dict]:
    """Cosine similarity search against anamnesis_turns."""
    try:
        import psycopg2
        conn_kwargs = dict(host=DB_HOST, database=DB_NAME, user=DB_USER)
        if DB_PASSWORD:
            conn_kwargs["password"] = DB_PASSWORD
        conn = psycopg2.connect(**conn_kwargs)
        cur = conn.cursor()

        emb_str = "[" + ",".join(str(x) for x in embedding) + "]"

        if project:
            cur.execute("""
                SELECT t.session_id, t.turn_index, s.project_name,
                       t.user_content, t.assistant_content,
                       1 - (t.embedding <=> %s::vector) as similarity,
                       s.started_at, s.summary
                FROM anamnesis_turns t
                JOIN anamnesis_sessions s ON s.session_id = t.session_id
                WHERE LOWER(s.project_name) = LOWER(%s)
                ORDER BY t.embedding <=> %s::vector
                LIMIT %s
            """, (emb_str, project, emb_str, MAX_RESULTS))
        else:
            cur.execute("""
                SELECT t.session_id, t.turn_index, s.project_name,
                       t.user_content, t.assistant_content,
                       1 - (t.embedding <=> %s::vector) as similarity,
                       s.started_at, s.summary
                FROM anamnesis_turns t
                JOIN anamnesis_sessions s ON s.session_id = t.session_id
                ORDER BY t.embedding <=> %s::vector
                LIMIT %s
            """, (emb_str, emb_str, MAX_RESULTS))

        rows = cur.fetchall()
        conn.close()

        results = []
        for row in rows:
            sim = float(row[5])
            if sim < MIN_SIMILARITY:
                continue
            results.append({
                "session_id": row[0][:8],
                "turn_index": row[1],
                "project": row[2] or "?",
                "user": (row[3] or "")[:300],
                "assistant": (row[4] or "")[:500],
                "similarity": sim,
                "date": row[6].strftime("%m/%d") if row[6] else "?",
                "summary": row[7] or "",
            })
        return results
    except Exception:
        return []


def format_results(results: list[dict], query: str, source: str) -> str:
    """Format search results as context for Claude."""
    lines = [f"Anamnesis recall for plan mode (query: \"{query[:100]}\", source: {source}):"]

    if not results:
        lines.append("No relevant past sessions found.")
        return "\n".join(lines)

    for r in results:
        lines.append(
            f"- [{r['session_id']}] @{r['project']} {r['date']} "
            f"({r['similarity']:.0%} match)"
        )
        if r["summary"]:
            lines.append(f"  Summary: {r['summary']}")
        if r["user"]:
            lines.append(f"  User: {r['user'][:200]}")
        if r["assistant"]:
            lines.append(f"  Assistant: {r['assistant'][:300]}")

    lines.append(
        "\nUse anamnesis_session(session_id) to get full context from any of these."
    )
    return "\n".join(lines)


def main():
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError) as e:
        sys.stderr.write(f"plan-recall: failed to parse hook input: {e}\n")
        sys.exit(0)

    cwd = hook_input.get("cwd", "")
    transcript_path = hook_input.get("transcript_path", "")

    # Extract query from the last user message in the transcript
    query_text = None
    source = "transcript"

    if transcript_path:
        last_msg = get_last_user_message(transcript_path)
        if last_msg:
            # Strip /plan prefix if present (from skill invocation)
            cleaned = last_msg.strip()
            if cleaned.lower().startswith("/plan"):
                cleaned = cleaned[5:].strip()
            if len(cleaned) > 5:
                query_text = cleaned[:500]

    if not query_text:
        sys.stderr.write("plan-recall: no query text found in transcript\n")
        sys.exit(0)

    project = derive_project_name(cwd)

    # Get embedding
    embedding = get_embedding(query_text)
    if not embedding:
        sys.stderr.write("plan-recall: failed to get embedding from Ollama\n")
        sys.exit(0)

    # Search
    results = search_anamnesis(embedding, project)

    # Format and return as additionalContext
    context = format_results(results, query_text, source)

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": context
        }
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
