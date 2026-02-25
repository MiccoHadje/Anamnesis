---
name: daily_duties
description: Morning duties — generate daily logs for all projects, cross-project reports, weekly summaries, and monthly highlights from Anamnesis session data.
user_invocable: true
---

# /daily_duties — Morning Duties

Grounds the session with the current date/time, then generates per-project daily logs, cross-project reports, weekly retrospectives, and monthly highlights as needed. Runs silently for routine days; asks before large backfills.

## Prerequisites

- Anamnesis MCP server running with `anamnesis_daily_report` tool available
- `reporting` section configured in `anamnesis.config.json` (see `anamnesis.config.example.json`)
- Optional: `tasks` section in config for task completion data (Nudge DB or filesystem)

## Invocation

```
/daily_duties
```

No arguments. It always does the right thing based on the current date.

## Configuration

This skill reads from the `reporting` section of `anamnesis.config.json`:

```json
{
  "reporting": {
    "projects": [
      {
        "name": "MyProject",
        "anamnesis_project": "MyProject",
        "daily_log_dir": "docs/daily",
        "nudge_project": "@MyProject"
      }
    ],
    "reports_dir": "~/.claude/reports"
  }
}
```

| Field | Description |
|-------|-------------|
| `projects[].name` | Display name for the project |
| `projects[].anamnesis_project` | Must match `project_name` in Anamnesis DB |
| `projects[].daily_log_dir` | Where to write per-project daily logs (relative to project root) |
| `projects[].nudge_project` | Optional Nudge project tag for task data |
| `reports_dir` | Where to write cross-project reports |

## Agentic Behavior

After detecting gaps (Step 1), decide whether to proceed silently or ask:

- **≤ 3 missing days**: Proceed silently — generate everything without asking. This is the normal case (yesterday, maybe a weekend).
- **> 3 missing days**: Show the gap summary grouped by date, then ask the user to confirm scope before generating. They may want to skip deep backfill.

When running silently, still print a brief summary at the end including:
1. What was generated (e.g., "Generated 6 daily logs + cross-project report for 23 Feb")
2. A link to the **cross-project report**
3. How many projects had activity vs. none

## Procedure

### Step 0: Ground the Date

Determine the current date and day of week. All subsequent date logic uses this result — never guess or assume the date.

### Step 1: Detect Gaps

Read the `reporting` config to get the project list and `reports_dir`.

Scan the **past 30 days** (completed days only — never the current day) for missing **cross-project reports**:

1. **Cross-project reports**: Check `{reports_dir}/daily/CrossProject_{DDMMMYY}.md` — this is the **sole "processed" marker** for a date. If it exists, that day is done.
2. **Weekly retros** (only if today is Monday): Check if the previous Mon-Sun week has cross-project weekly files.
3. **Monthly highlights**: Check if the **previous month's** highlight exists at `{reports_dir}/monthly/Highlights_{MMMYY}.md`.

**Do NOT check per-project daily log files for gap detection.** Per-project logs are only created when a project had actual work — absence of a per-project log means "no work that day," not "unprocessed."

Count the number of **unique missing dates** (dates without a cross-project report). Apply the agentic threshold (≤ 3 = silent, > 3 = ask).

### Step 2: Generate Per-Project Daily Logs

Process **one project at a time, one day at a time** (oldest first).

For each missing date, use the `anamnesis_daily_report` MCP tool to gather session data:

```
anamnesis_daily_report(date: "YYYY-MM-DD", project: "ProjectName")
```

If the tool returns data, use it to write a daily log to `{project_path}/{daily_log_dir}/{Name}_{DDMMMYY}.md`:

```markdown
# {ProjectName} Daily Log — {DayOfWeek}, {DD} {Mon} {YYYY}

## Summary
{1-2 sentence overview of the day}

## Completed Work
{Category headers with 1-2 sentence descriptions per item}

## Decisions Made
{Bullet points of decisions with brief rationale}

## Key Lessons Learned
{Only genuinely new insights}

## Status at End of Day
{What's running, blocked, next}
```

**If `anamnesis_daily_report` returns no activity for a project on a given day, do NOT create a file.** The cross-project report (Step 3) records inactive projects.

**Task data**: When a `tasks` provider is configured in `anamnesis.config.json`, the `anamnesis_daily_report` MCP tool automatically includes task completions, started counts, and blocked counts in its output. No separate `nudge_history` call is needed.

### Step 3: Generate Cross-Project Reports

After all per-project logs for a given date are written, use `anamnesis_daily_report` (without project param) for the cross-project summary and write to `{reports_dir}/daily/CrossProject_{DDMMMYY}.md`:

```markdown
# Cross-Project Daily Report — {DayOfWeek}, {DD} {Mon} {YYYY}

## Day at a Glance
| Project | Activity | Key Outcome |
|---------|----------|-------------|
| {name} | {Heavy/Light/None} | {one-liner or —} |

## Project Summaries
### {ProjectName}
{3-5 bullets summarizing the day's work}

## Time Allocation (estimated from Anamnesis session counts)
- {Project}: ~{percent}% ({N} sessions)

## Data Coverage
- {Project}: {daily log | no data}
```

**Activity level heuristic:**
- **Heavy**: 3+ sessions OR 3+ tasks completed
- **Light**: 1-2 sessions OR some task activity
- **None**: No sessions, no tasks

### Step 4: Generate Weekly Retrospectives (Monday only)

Only runs when today is **Monday**. Generate retros for the previous Mon-Sun week.

Read whatever daily cross-project reports exist for that week. Write to `{reports_dir}/weekly/CrossProject_Week_{DD}-{DDMMMYY}.md`:

```markdown
# Cross-Project Weekly Summary — {DD}-{DD} {Mon} {YYYY}

## Week Overview
{2-3 sentence narrative}

## Accomplishments by Project
### {ProjectName}
{Major milestones, 5-10 bullets max}

## Time Allocation
| Project | Sessions | Est. Hours | % |
|---------|----------|------------|---|

## Looking Ahead
{Top 3-5 priorities}
```

### Step 5: Generate Monthly Highlights (if missing)

Check if `{reports_dir}/monthly/Highlights_{MMMYY}.md` exists for the **previous month**. If missing, generate it from that month's cross-project daily reports:

```markdown
# Monthly Highlights — {Month} {YYYY}

## Accomplishments
{Bullet list grouped by project}

## Milestones
{Significant milestones reached}

## Major Focuses
{2-4 bullets on where time went}

## Looking Ahead
{What's in flight heading into next month}
```

### Step 6: Report Results

Summarize:
- Which files were generated (with paths)
- Data coverage per project
- Any gaps or warnings

## Important Notes

- Dates in filenames use uppercase month abbreviations: `22FEB26`, not `22feb26`
- If Anamnesis has sparse data, note the gap honestly rather than fabricating content
- Weekly retros should **synthesize** across daily logs, not just concatenate them
- Generate daily logs from oldest to newest (context builds forward)
- **Process projects and days sequentially** — do not parallelize Anamnesis queries
- **Create directories** before writing files if they don't exist
- **NEVER create stub/empty files** for no-work days. The cross-project report is the "processed" marker.
- Session-to-hours estimate: ~1.5 hours per Anamnesis session (rough heuristic)
