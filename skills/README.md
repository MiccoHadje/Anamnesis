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

### `/anamnesis_install`

Guided setup and health check. Detects what's already installed and adapts:

- **Fresh install:** Walks through prerequisites, database, config, MCP registration, backfill, and hooks step-by-step.
- **Partial install:** Picks up where you left off.
- **Already installed:** Runs a health check — verifies all components are working and reports status.

**Usage:** Type `/anamnesis_install` in a Claude Code session opened in the Anamnesis project directory.

See `install/SKILL.md` for full documentation.

### `/daily_duties`

Morning reporting workflow that generates per-project daily logs, cross-project summaries, weekly retrospectives, and monthly highlights from Anamnesis session data.

**Requires:** The `reporting` section in `anamnesis.config.json` (see `anamnesis.config.example.json`).

**Optional:** [Nudge](https://github.com/MiccoHadje/Nudge) MCP server for task completion data enrichment.

**Usage:** Type `/daily_duties` in any Claude Code session. The skill automatically detects which days need reports and generates them.

See `daily-duties/SKILL.md` for full documentation.
