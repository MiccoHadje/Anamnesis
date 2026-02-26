# My AI Forgets Everything Between Sessions. Here's How I Fixed It.
*Building ambient memory for LLMs.*


---

I run six active software projects out of a single workstation. On any given day, Claude Code might help me debug a PostgreSQL migration in one project, design a training pipeline in another, and refactor an API gateway in a third. It's great work. And tomorrow, every bit of that context evaporates.

We spent 2025 teaching AI to think harder and remember more. Nobody spent it teaching AI to *learn from what it remembers*. In 2026, we have models that can reason across [hundreds of thousands of context tokens](https://docs.anthropic.com/en/docs/build-with-claude/context-windows), plan multi-step implementations, and write code that passes on the first try, but they can't remember what we built together yesterday.

I built a system to fix that. It's called [Anamnesis](https://github.com/MiccoHadje/Anamnesis), it's open source, and after seven weeks of daily use across 516 sessions and 6,800+ conversation turns, I can tell you that persistent memory changes the collaboration in ways I didn't expect.

## The Blank Slate Problem

Every Claude Code session starts the same way. The model reads your [`CLAUDE.md`](https://claude.com/blog/using-claude-md-files), scans your project structure, and gets to work. It's fast and capable. But it has no idea that three days ago, in a different session, you tried this exact refactor and abandoned it because of a race condition in the event loop. It doesn't know that you decided last week to use Drizzle ORM instead of Prisma, and why. It doesn't remember that the `ingester.ts` file has been touched by 14 separate sessions over the past month, each building on the last.

You can write some of this down in `CLAUDE.md`. The important decisions, the architectural guardrails. But there's a [ceiling to what static documentation can capture](https://code.claude.com/docs/en/best-practices). Engineering knowledge is narrative. It's the sequence of decisions, the dead ends, the Tuesday-at-2-AM realization that the batch processor needs idempotency because you lost data twice.

Traditional RAG systems don't solve this either. They're [encyclopedic](https://arxiv.org/abs/2312.10997). Good at retrieving facts from a corpus, but bad at capturing how a development history actually unfolds. What I needed wasn't a search engine. I needed something closer to real memory.

The ancient Greeks believed that learning is really just remembering what we already know. They had a word for it: *Anamnesis*, the soul *recovering knowledge it already possessed*. Your AI doesn't need to learn your project from scratch every morning. It needs to recollect the knowledge it already possesses.

## Why Not Just Use a Memory MCP?

There are plenty of "memory" [MCP](https://modelcontextprotocol.io/) servers on GitHub. Most follow the same pattern: the agent calls a `save_memory` tool to store a key-value pair or append a note to a file, then calls `recall_memory` later to retrieve it. With varying degrees of sophistication, most are really a clipboard with a search bar.

The problems are layered. It requires the agent to *decide* what's worth remembering, in the moment, under token pressure, while trying to solve your actual problem. Important context gets dropped because the agent didn't think to save it. The memories are also isolated: saving "decided to use Drizzle ORM" doesn't connect to the session where you debugged Drizzle's connection pooling two weeks later. And it only captures what the agent explicitly stores. The back-and-forth debugging, the rejected approaches, the subtle constraints discovered mid-implementation? None of that makes it into a `save_memory` call.

These tools solve *storage*. Anamnesis tries to solve *learning*. Instead of asking the agent to curate its own memories, it captures everything passively from transcripts that already exist, links sessions together across structural, semantic, and categorical dimensions, injects relevant context before you ask for it, and synthesizes raw history into daily reports that surface patterns no single session could reveal.

Where the memories live matters less than whether anything learns from them.

## How It Works

The architecture is simple. Claude Code already records every conversation as a JSONL transcript file. Anamnesis watches for those files, parses them into structured turns (user message + assistant response), generates vector embeddings via a local model, and stores everything in PostgreSQL with [pgvector](https://github.com/pgvector/pgvector). Then an MCP server makes that database available as tools that Claude can call: search by meaning, browse recent sessions, pull up full session details, right inside the conversation.

> **[IMAGE: article_chart1_pipeline.png — under "How It Works"]**

Each turn gets an embedding. Each session gets metadata: which project, which files were touched, which tools were called, timestamps, git branch. And then the interesting part: sessions get linked to each other, automatically, through three independent signals.

## Three Dimensional Memory Graph

The linking system is what turns a flat database of transcripts into something that works more like human memory: connections. Stored sessions become connected through three independent layers, each catching relationships the others miss. Did they touch the same code? Reason about similar problems? Work in the same domain?

### Signal 1: File Overlap

If two sessions touch the same files, they're related. This is the most concrete signal: purely structural, no ML involved.

The score uses [Jaccard similarity](https://en.wikipedia.org/wiki/Jaccard_index): the number of shared files divided by the total unique files across both sessions. Two sessions that both modified `schema.sql`, `ingester.ts`, and `client.ts` share a structural anchor. They were working on the same part of the codebase, even if the conversations were about completely different topics.

In my database, this produces 3,700+ links. Many of them connect sessions weeks apart. A January session that set up a database schema linked to a February session that refactored the query layer on top of it.

### Signal 2: Semantic Similarity

File overlap catches structural relationships but misses conceptual ones. Two sessions might discuss PostgreSQL connection pooling strategies without ever touching the same file, one in the API gateway project, the other in the task manager.

Each session gets an averaged embedding from all its turn-level embeddings ([bge-m3](https://huggingface.co/BAAI/bge-m3), 1024 dimensions, running locally on [Ollama](https://ollama.com/)). Cosine similarity between session embeddings surfaces these conceptual links. A threshold of 0.5 filters noise while catching meaningful relationships.

This produces 6,600+ links in my database. It's the "these feel related" layer, and it's surprisingly accurate. Sessions about "debugging PostgreSQL timeouts" link to sessions about "connection pool exhaustion" even across different projects.

### Signal 3: Topic Tags

Vector similarity is powerful but fuzzy. Two sessions can score 0.48 on semantic similarity, just below the threshold, despite being about the exact same feature. Topic tags provide a deterministic backstop.

An optional local LLM (Gemma 3:12b by default) reads the full session content, splitting longer sessions into chunks and merging results across passes, to extract 3-8 topic tags plus a one-sentence summary. Sessions sharing two or more tags get linked, scored by Jaccard similarity on their tag sets.

This is actually the largest layer in my database: 12,700+ links. A session tagged `[database, migration, pgvector]` reliably links to another tagged `[database, schema, pgvector]`, regardless of how the conversations went.

> **[IMAGE: article_chart2_linkgraph.png — under "Three Dimensional Memory Graph", before closing paragraph]**

No single layer is sufficient. File overlap misses conceptual relationships. Semantic similarity can blur unrelated sessions together. Topic tags are deterministic but coarse. But when you query a session through the MCP server, all three surface together, ranked by score, with the link type shown. The model can see what you did, what's related, and *why* the system thinks so.

## Making Memory Invisible

A memory system that requires you to manually search it isn't much better than documentation. Memory works best when it's passive, woven into the development workflow so that context appears without being asked for.

Anamnesis does this through four [Claude Code hooks](https://code.claude.com/docs/en/hooks), each triggering at a different point in the session lifecycle.

> **[IMAGE: article_chart3_hooks.png — under "Making Memory Invisible", before hook details]**

### Hook 1: SessionEnd (Capture)

When you end a Claude Code session, a hook fires that ingests the transcript immediately. Parse, chunk, embed, store, link. By the time you start your next session, today's work is already searchable. No manual step, no "remember to commit your notes." If the hook doesn't fire (machine restart, crash), a scheduled task runs every 15 minutes as a safety net.

### Hook 2: SessionStart (Recall)

When you start a new session, a hook queries Anamnesis for recent sessions on the current project and injects them as context. Before you type your first message, Claude already knows what you worked on yesterday. The session-start context often includes:

- What was built or modified recently
- Which files were involved
- What decisions were made and why
- What's currently broken or in progress

This is the moment that changed my workflow most dramatically. Instead of spending the first five minutes of every session re-explaining where I left off, Claude opens with awareness. "I can see from recent sessions that you've been refactoring the storage layer. The `PgStorage` implementation landed yesterday and consumers were migrated. What's next?"

### Hook 3: Plan Mode (Deep Context)

Claude Code has a "plan mode" for designing implementations before writing code. A hook fires when the model enters plan mode, searching Anamnesis with the planning query and injecting relevant historical sessions.

So when you say "plan a refactor of the task provider system," Claude recalls that you discussed task provider architectures three weeks ago, that you decided against a filesystem-based approach for production but wanted it for testing, and that the GitHub Issues adapter maps closed-on-date to completions, which aligns with how teams already track work.

### Hook 4: PreCompact (The Bridge)

Long sessions eventually hit Claude Code's context limit and trigger compaction, where the model summarizes the conversation and drops the full history. This is where context evaporates. The fourth hook fires right before that happens. It extracts key state from the tail of the transcript (files modified, recent commands, errors), triggers an immediate Anamnesis ingestion of the session so far, and injects a continuation prompt.

After compaction, the model has a summary of the session *plus* the full pre-compaction history is searchable in Anamnesis. Tactical state from the hook (what was I just doing?) plus deep memory from the database (what have I been building this week?) makes compaction nearly invisible. Sessions that used to lose their thread now pick up exactly where they left off.

You won't find these details in documentation or code comments. They live in the history of conversations that got you here.

## Worked Example: The Daily Duties Skill

Retrieval is half the story. The hooks ensure Claude has context when it needs it. But what happens when you want to *synthesize* weeks of accumulated memory into something useful? The `/daily_duties` skill is the clearest example.

Every morning, I run a single command. It takes about two minutes to execute. Here's what happens:

**Step 1: Gap Detection.** The skill scans the past 30 days for dates without a cross-project report. Weekends with no work get flagged but don't generate empty reports; only dates with actual session activity produce output. If more than three days are missing, it asks before backfilling; otherwise it proceeds silently.

**Step 2: Per-Project Daily Logs.** For each missing date, the Anamnesis MCP tool queries sessions by project and date. If a project had activity, a daily log gets generated: not a raw dump of conversation, but a synthesized report with summary, completed work, decisions made, status at end of day. If a project had no activity that day, no file gets created.

**Step 3: Cross-Project Report.** After individual logs, a cross-project summary ties the day together:

```markdown
# Cross-Project Daily Report — Tuesday, 24 Feb 2026

## Day at a Glance
| Project   | Activity | Sessions | Turns | Completed | Key Topics       |
|-----------|----------|----------|-------|-----------|------------------|
| Sage      | Heavy    | 6        | 89    | 15        | eval, training   |
| CanoicAI  | Light    | 1        | 12    | 0         | gateway          |
| Dash      | None     | 0        | 0     | 0         | —                |

## Task Flow (GitHub Issues)
- **Completed**: 15 (NodeRegistry, training data backfill, eval server...)

## Time Allocation
- Sage: ~95% (6 sessions)
- CanoicAI: ~5% (infrastructure support only)
```

**Step 4: Weekly and Monthly.** On Mondays, a weekly retrospective synthesizes the daily reports into accomplishments and priorities. At the turn of the month, a monthly highlights document captures milestones.

Daily logs capture what happened and what changed. Weekly retrospectives zoom out: did the week's work match the plan? Monthly highlights tell the longer story of how each project grew.

None of this requires me to take notes. The raw material is the conversations themselves, already captured and indexed by Anamnesis. The skill just synthesizes what's already there.

### Memory Meets Intent

Memory without intent is just a log. Session data tells you *what happened*, but not whether it aligned with what you planned. The daily reports get substantially richer when connected to a task manager.

Anamnesis defines a minimal `TaskProvider` interface: three read-only queries for completions, started tasks, and blocked tasks. A GitHub Issues adapter ships as the recommended default — it uses the `gh` CLI you probably already have, with zero additional dependencies. A filesystem adapter reads from markdown todo files. Connecting Jira, Linear, or your custom tracker would be a single class implementing five methods.

When the daily report shows that six sessions and 15 completed tasks focused on Sage, with zero sessions on Dash, that tells you something. The weekly retrospective can identify drift between planned priorities and actual effort. The monthly summary can show that a project you thought was winding down actually consumed 40% of your time.

## What Changes

After seven weeks of use, here's what's different about working with persistent memory:

**Sessions start faster.** The re-onboarding tax, those first 5-10 minutes of every session explaining what you're doing and why, largely disappears. The SessionStart hook provides enough context that Claude picks up where the last session left off.

**Decisions stick.** Architectural decisions made in session 47 are discoverable in session 200. "Why did we choose hybrid search over pure vector?" isn't a question I have to answer from memory. It's in the database, linked to the session where we benchmarked both approaches.

**Cross-project patterns emerge.** When you can search across all your projects at once, you notice things. A debugging technique that worked in one project applies to another. A design pattern you explored in January becomes relevant again in February. The linking system surfaces these connections without you looking for them.

**Compaction anxiety disappears.** If you've used Claude Code for long sessions, you know the feeling: the context window fills up, compaction fires, and the model loses the thread. You spend five minutes re-explaining what you were just doing. With the PreCompact hook, the session is ingested into Anamnesis before compaction happens, and a continuation prompt captures the tactical state. The files you were editing, commands you just ran, errors you were debugging are all 'just there'. After compaction, the model has both the summary *and* the full pre-compaction history available via search. Long sessions that used to derail now continue seamlessly. It's the single feature that made me stop fearing the auto-compaction countdown.

**The daily reports compound.** Individual daily logs are useful but ephemeral. After a month, the accumulated reports become a queryable history of your engineering practice. What did I actually work on in January? How much time went to maintenance versus features? The data is there because the system captured it passively.

## "But How Big Does the Database Get?"

This is the first question everyone asks. Here are the real numbers from my installation: seven weeks, 516 sessions, 6,800+ turns, 12 active projects.

> **[IMAGE: article_chart4_dbsize.png — under "But How Big Does the Database Get?"]**

The database is roughly a **20:1 compression** of the raw transcripts. The average cost per session is about 330 KB, most of that being the vector embeddings and search indexes rather than the text.

Several design choices keep this manageable:

**Filtering at ingestion.** Transcripts under 5 KB are skipped; they're too short to contain meaningful context. Binary content (base64 images, large tool outputs) is excluded from embedding text. The chunker extracts the conversational substance and drops the noise.

**JSONL compaction.** Claude Code's transcripts are append-only JSONL, and a single session can contain megabytes of raw data: tool call results, file contents, system prompts repeated every turn. The parser extracts only user messages, assistant responses, and tool call summaries. A 50 MB transcript might produce 200 KB of indexed content.

**Fixed-dimension embeddings.** Every turn gets exactly one 1024-dimensional float32 vector (4 KB). This scales linearly and predictably. At 10,000 turns you'd have ~40 MB of vectors, well within what pgvector handles comfortably.

**Projecting forward:** at my current pace (~70 sessions/month), the database would reach roughly 1 GB after two years. PostgreSQL doesn't blink at that. [HNSW indexes](https://arxiv.org/abs/1603.09320) stay fast into the millions of vectors. If you're a lighter user, one project, a few sessions per week, you'd measure the database in tens of megabytes for years.

The other common concern is **Ollama performance**. Embedding with bge-m3 takes about 100-200ms per turn on a modern CPU (no GPU needed). A 50-turn session ingests in under 30 seconds. The initial backfill of hundreds of sessions is the only time you'll wait, and it's resumable, so you can interrupt and continue later.

Topic extraction is the most GPU-intensive step. The default model (gemma3:12b) wants ~8 GB of VRAM, but gemma3:4b produces comparable tags with half the memory at 2-3x the speed — so even modest hardware can build the full three-dimensional link graph. And if you have a GPU machine elsewhere on your network, just point `topic_model.url` at it and develop on your laptop.

## Smarter Retrieval: The Context Builder

Raw database size is one concern. The more interesting question is *retrieval quality* as the database grows. When you have 500 sessions, returning the top 5 matching turns works fine. At 5,000 sessions, naive top-N retrieval starts returning redundant hits from the same body of work, ignoring the link graph you spent compute building, and dumping more context than the caller actually needs.

The context builder solves this with a three-phase pipeline:

**Phase 1: Gather.** Search overfetches (20 results instead of 5), then deduplicates by session — if three turns from the same session match your query, the best one becomes the display hit and the others become "see also" drill-down hints. A diversity re-rank ([MMR](https://dl.acm.org/doi/10.1145/290941.291025)-inspired) penalizes clusters from the same session or project, so results spread across your work rather than clustering around one hot spot. Then the link graph kicks in: for the top hits, linked sessions get pulled in as additional candidates. Those 23,000+ links finally participate in search.

**Phase 2: Allocate.** The caller specifies a token budget — 800 for a quick hook injection, 2,000 for planning, 4,000 for deep research. The allocator walks ranked items and greedily assigns detail levels: full content for top hits, one-line summaries for supporting context, title-only bullets for the long tail. Budget exhausted? Stop. No wasted tokens.

**Phase 3: Render.** Format the allocated items as progressive-detail markdown. Full hits include content excerpts with drill-down hints: "See also: turn 3 (48%), turn 8 (44%)" and "Linked: [def67890] Anamnesis 02/22 (file overlap)." The caller can follow those breadcrumbs with existing tools — no new MCP surface needed.

The result: an 800-token budget returns 7 diverse sessions with enough context to orient. A 4,000-token budget returns 10+ sessions with linked context and full excerpts. Same query, different depth, always within budget.

This matters because hooks have hard time limits (10 seconds for plan-mode recall) and context windows have real costs. You don't want to blow 8,000 tokens on memory context when 800 would suffice for a session-start greeting, and you don't want a 2,000-token research query to return five redundant hits from the same marathon debugging session.

## Getting Started

Anamnesis is open source under GPL-3.0. It runs entirely locally: PostgreSQL, Ollama, and Node.js on your machine. No API keys, no cloud services, no telemetry.

The stack:
- **PostgreSQL + pgvector**: sessions, turns, embeddings, links
- **Ollama + bge-m3**: local embeddings (free, ~1.5 GB model)
- **Node.js/TypeScript**: ETL pipeline and MCP server
- **Claude Code hooks**: passive capture and proactive recall

Installation takes about 30 minutes. Clone the repo, set up the database, build, register the MCP server. Or let Claude do it: open the project in Claude Code and type `/anamnesis_install`, a guided skill that detects your current state and walks you through whatever's missing.

```bash
git clone https://github.com/MiccoHadje/Anamnesis.git
cd Anamnesis
npm install && npm run build
# Then: /anamnesis_install in Claude Code
```

The [README](https://github.com/MiccoHadje/Anamnesis) has the full details. The [INSTALL.md](https://github.com/MiccoHadje/Anamnesis/blob/main/INSTALL.md) has the step-by-step walkthrough.

## What's Next

Anamnesis solves the memory problem for individual developers. The same pattern applies at larger scales.

I'm building toward that with [Canoic](https://canoic.ai). The premise: AI development tools shouldn't be smart only in the moment. They should accumulate institutional knowledge, enforce consistency across contributors, and make a project's *history* as searchable as its code. Anamnesis is the first piece, the memory layer. Intent comes next: task management that understands context. After that, consistency (enforcing past decisions in new work) and synthesis (turning raw history into narrative you can act on).

If you're building AI-assisted development workflows and fighting the same amnesia problem, I'd love to hear from you. File an issue, fork the repo, or reach out directly. The codebase is small enough to understand in an afternoon and opinionated enough to be useful today.

Stop treating memory as a feature. It's infrastructure.

---

*Clay Mahaffey is the founder of [Canoic, LLC](https://canoic.ai). He builds AI development tools in Savannah, GA, mostly by talking to Claude Code about PostgreSQL at unreasonable hours. Anamnesis is [open source on GitHub](https://github.com/MiccoHadje/Anamnesis).*

---

## References

- Anthropic. (2025). [Context windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows). Anthropic Documentation.
- Anthropic. (2025). [Using CLAUDE.MD files: Customising Claude Code for your codebase](https://claude.com/blog/using-claude-md-files). Claude Blog.
- Anthropic. (2025). [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices). Claude Code Docs.
- Anthropic. (2025). [Hooks reference](https://code.claude.com/docs/en/hooks). Claude Code Docs.
- Anthropic. (2024). [Model Context Protocol](https://modelcontextprotocol.io/). modelcontextprotocol.io.
- Carbonell, J. & Goldstein, J. (1998). [The use of MMR, diversity-based reranking for reordering documents and producing summaries](https://dl.acm.org/doi/10.1145/290941.291025). ACM SIGIR.
- Chen, J. et al. (2024). [BGE M3-Embedding: Multi-Lingual, Multi-Functionality, Multi-Granularity](https://huggingface.co/BAAI/bge-m3). Hugging Face.
- Gao, Y. et al. (2024). [Retrieval-Augmented Generation for Large Language Models: A Survey](https://arxiv.org/abs/2312.10997). arXiv:2312.10997.
- Katz, A. [pgvector: Open-source vector similarity search for PostgreSQL](https://github.com/pgvector/pgvector). GitHub.
- Malkov, Y. & Yashunin, D. (2018). [Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs](https://arxiv.org/abs/1603.09320). arXiv:1603.09320.
- [Jaccard index](https://en.wikipedia.org/wiki/Jaccard_index). Wikipedia.
- [Ollama](https://ollama.com/). Run large language models locally.
