# Anamnesis Skills

[Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) are reusable prompt templates that Claude can invoke. These skills extend Anamnesis with higher-level workflows.

## Installation

Copy the skill directories into your project's `.claude/skills/` directory or your global `~/.claude/skills/` directory:

```bash
# Project-level (available only in this project)
cp -r skills/daily-duties .claude/skills/

# Global (available in all projects)
cp -r skills/daily-duties ~/.claude/skills/
```

## Available Skills

### `/daily_duties`

Morning reporting workflow that generates per-project daily logs, cross-project summaries, weekly retrospectives, and monthly highlights from Anamnesis session data.

**Requires:** The `reporting` section in `anamnesis.config.json` (see `anamnesis.config.example.json`).

**Optional:** [Nudge](https://github.com/MiccoHadje/Nudge) MCP server for task completion data enrichment.

**Usage:** Type `/daily_duties` in any Claude Code session. The skill automatically detects which days need reports and generates them.

See `daily-duties/SKILL.md` for full documentation.
