import { getConfig } from '../util/config.js';
import { getStorage } from '../storage/index.js';

interface TopicResult {
  tags: string[];
  summary: string;
}

/** Max chars per LLM chunk (leaves room for prompt + metadata). */
const CHUNK_SIZE = 6000;

/**
 * Stopwords for topic extraction compression.
 * Aggressive: strips everything that won't become a topic tag.
 * Preserves: nouns, technical terms, specific verbs, file paths, numbers.
 */
const STOPWORDS = new Set([
  // Articles
  'a', 'an', 'the',
  // Pronouns
  'i', 'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself',
  'we', 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', 'themselves',
  'what', 'which', 'who', 'whom', 'whose',
  'this', 'that', 'these', 'those',
  // Prepositions
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'up', 'about',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'under', 'over', 'out', 'off', 'down', 'against', 'across', 'along', 'around',
  'among', 'behind', 'beyond', 'within', 'without', 'toward', 'towards', 'upon',
  'onto', 'beside', 'besides', 'beneath', 'throughout', 'inside', 'outside',
  'until', 'since', 'per', 'via', 'except', 'unlike', 'near', 'past',
  // Conjunctions
  'and', 'or', 'but', 'nor', 'yet', 'so', 'for', 'both', 'either', 'neither',
  'whether', 'while', 'although', 'though', 'because', 'since', 'unless',
  'whereas', 'whereby', 'if', 'then', 'else', 'than', 'as',
  // Common verbs (be/have/do/modals)
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'has', 'have', 'had', 'having',
  'do', 'does', 'did', 'doing', 'done',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  // Common verbs — all forms. Only verbs that don't carry domain meaning.
  'get', 'got', 'gets', 'getting', 'gotten',
  'go', 'goes', 'went', 'going', 'gone',
  'come', 'comes', 'came', 'coming',
  'make', 'makes', 'made', 'making',
  'take', 'takes', 'took', 'taken', 'taking',
  'give', 'gives', 'gave', 'given', 'giving',
  'say', 'says', 'said', 'saying',
  'tell', 'tells', 'told', 'telling',
  'know', 'knows', 'knew', 'known', 'knowing',
  'think', 'thinks', 'thought', 'thinking',
  'see', 'sees', 'saw', 'seen', 'seeing',
  'look', 'looks', 'looked', 'looking',
  'want', 'wants', 'wanted', 'wanting',
  'need', 'needs', 'needed', 'needing',
  'seem', 'seems', 'seemed', 'seeming',
  'try', 'tries', 'tried', 'trying',
  'keep', 'keeps', 'kept', 'keeping',
  'let', 'lets', 'letting',
  'put', 'puts', 'putting',
  'mean', 'means', 'meant', 'meaning',
  'become', 'becomes', 'became', 'becoming',
  'leave', 'leaves', 'left', 'leaving',
  'feel', 'feels', 'felt', 'feeling',
  'bring', 'brings', 'brought', 'bringing',
  'begin', 'begins', 'began', 'begun', 'beginning',
  'show', 'shows', 'showed', 'shown', 'showing',
  'hear', 'hears', 'heard', 'hearing',
  'turn', 'turns', 'turned', 'turning',
  'call', 'calls', 'called', 'calling',
  'ask', 'asks', 'asked', 'asking',
  'hold', 'holds', 'held', 'holding',
  'move', 'moves', 'moved', 'moving',
  'live', 'lives', 'lived', 'living',
  'happen', 'happens', 'happened', 'happening',
  'set', 'sets', 'setting',
  'sit', 'sits', 'sat', 'sitting',
  'stand', 'stands', 'stood', 'standing',
  'lose', 'loses', 'lost', 'losing',
  'pay', 'pays', 'paid', 'paying',
  'meet', 'meets', 'met', 'meeting',
  'include', 'includes', 'included', 'including',
  'continue', 'continues', 'continued', 'continuing',
  'learn', 'learns', 'learned', 'learning',
  'change', 'changes', 'changed', 'changing',
  'follow', 'follows', 'followed', 'following',
  'stop', 'stops', 'stopped', 'stopping',
  'start', 'starts', 'started', 'starting',
  'open', 'opens', 'opened', 'opening',
  'close', 'closes', 'closed', 'closing',
  'run', 'runs', 'ran', 'running',
  'provide', 'provides', 'provided', 'providing',
  'read', 'reads', 'reading',
  'allow', 'allows', 'allowed', 'allowing',
  'lead', 'leads', 'led', 'leading',
  'spend', 'spends', 'spent', 'spending',
  'grow', 'grows', 'grew', 'grown', 'growing',
  'win', 'wins', 'won', 'winning',
  'teach', 'teaches', 'taught', 'teaching',
  'fall', 'falls', 'fell', 'fallen', 'falling',
  'reach', 'reaches', 'reached', 'reaching',
  'remain', 'remains', 'remained', 'remaining',
  'suggest', 'suggests', 'suggested', 'suggesting',
  'raise', 'raises', 'raised', 'raising',
  'pass', 'passes', 'passed', 'passing',
  'sell', 'sells', 'sold', 'selling',
  'require', 'requires', 'required', 'requiring',
  'report', 'reports', 'reported', 'reporting',
  'decide', 'decides', 'decided', 'deciding',
  'pull', 'pulls', 'pulled', 'pulling',
  'develop', 'develops', 'developed', 'developing',
  'expect', 'expects', 'expected', 'expecting',
  'pick', 'picks', 'picked', 'picking',
  'place', 'places', 'placed', 'placing',
  'consider', 'considers', 'considered', 'considering',
  'appear', 'appears', 'appeared', 'appearing',
  'point', 'points', 'pointed', 'pointing',
  'receive', 'receives', 'received', 'receiving',
  'remember', 'remembers', 'remembered', 'remembering',
  'serve', 'serves', 'served', 'serving',
  'end', 'ends', 'ended', 'ending',
  'offer', 'offers', 'offered', 'offering',
  'figure', 'figures', 'figured', 'figuring',
  'note', 'notes', 'noted', 'noting',
  'explain', 'explains', 'explained', 'explaining',
  'ensure', 'ensures', 'ensured', 'ensuring',
  'use', 'uses', 'used', 'using',
  'find', 'finds', 'found', 'finding',
  'add', 'adds', 'added', 'adding',
  'work', 'works', 'worked', 'working',
  'write', 'writes', 'wrote', 'written', 'writing',
  'play', 'plays', 'played', 'playing',
  'send', 'sends', 'sent', 'sending',
  'build', 'builds', 'built', 'building',
  'stay', 'stays', 'stayed', 'staying',
  'help', 'helps', 'helped', 'helping',
  'watch', 'watches', 'watched', 'watching',
  'speak', 'speaks', 'spoke', 'spoken', 'speaking',
  'carry', 'carries', 'carried', 'carrying',
  'talk', 'talks', 'talked', 'talking',
  'produce', 'produces', 'produced', 'producing',
  'happen', 'happens', 'happened', 'happening',
  'mention', 'mentions', 'mentioned', 'mentioning',
  'handle', 'handles', 'handled', 'handling',
  'cause', 'causes', 'caused', 'causing',
  'apply', 'applies', 'applied', 'applying',
  'create', 'creates', 'created', 'creating',
  'assume', 'assumes', 'assumed', 'assuming',
  'agree', 'agrees', 'agreed', 'agreeing',
  'support', 'supports', 'supported', 'supporting',
  'describe', 'describes', 'described', 'describing',
  'guess', 'guesses', 'guessed', 'guessing',
  'implement', 'implements', 'implemented', 'implementing',
  'result', 'results', 'resulted', 'resulting',
  'prefer', 'prefers', 'preferred', 'preferring',
  'define', 'defines', 'defined', 'defining',
  'check', 'checks', 'checked', 'checking',
  'fix', 'fixes', 'fixed', 'fixing',
  'update', 'updates', 'updated', 'updating',
  'remove', 'removes', 'removed', 'removing',
  'return', 'returns', 'returned', 'returning',
  'avoid', 'avoids', 'avoided', 'avoiding',
  'contain', 'contains', 'contained', 'containing',
  'exist', 'exists', 'existed', 'existing',
  'replace', 'replaces', 'replaced', 'replacing',
  'cause', 'causes', 'caused', 'causing',
  'accept', 'accepts', 'accepted', 'accepting',
  'base', 'based', 'basing',
  'enable', 'enables', 'enabled', 'enabling',
  'relate', 'relates', 'related', 'relating',
  'specify', 'specifies', 'specified', 'specifying',
  'produce', 'produces', 'produced', 'producing',
  'generate', 'generates', 'generated', 'generating',
  'indicate', 'indicates', 'indicated', 'indicating',
  'refer', 'refers', 'referred', 'referring',
  'match', 'matches', 'matched', 'matching',
  'represent', 'represents', 'represented', 'representing',
  'share', 'shares', 'shared', 'sharing',
  'connect', 'connects', 'connected', 'connecting',
  'catch', 'catches', 'caught', 'catching',
  'prove', 'proves', 'proved', 'proven', 'proving',
  'miss', 'misses', 'missed', 'missing',
  'break', 'breaks', 'broke', 'broken', 'breaking',
  'wait', 'waits', 'waited', 'waiting',
  'manage', 'manages', 'managed', 'managing',
  'test', 'tests', 'tested', 'testing',
  'resolve', 'resolves', 'resolved', 'resolving',
  'address', 'addresses', 'addressed', 'addressing',
  // Adverbs / fillers
  'basically', 'essentially', 'actually', 'obviously', 'simply', 'just',
  'really', 'very', 'quite', 'rather', 'somewhat', 'perhaps', 'maybe',
  'probably', 'certainly', 'definitely', 'specifically', 'particularly',
  'generally', 'typically', 'usually', 'literally', 'honestly', 'frankly',
  'clearly', 'apparently', 'presumably', 'respectively', 'accordingly',
  'furthermore', 'additionally', 'moreover', 'nevertheless', 'nonetheless',
  'however', 'therefore', 'consequently', 'meanwhile', 'subsequently',
  'alternatively', 'ultimately', 'regardless', 'already', 'also', 'always',
  'still', 'even', 'ever', 'never', 'often', 'sometimes', 'again',
  'almost', 'enough', 'well', 'back', 'away', 'here', 'there', 'where',
  'when', 'how', 'why', 'now', 'only', 'very', 'much', 'more', 'most',
  'less', 'least', 'too', 'else', 'once', 'twice', 'soon', 'later',
  'early', 'far', 'long', 'right', 'together', 'apart', 'instead',
  'ahead', 'anyway', 'anywhere', 'everywhere', 'nowhere', 'somewhere',
  // Discourse markers / phrases / general nouns
  'example', 'instance', 'fact', 'order', 'addition', 'general',
  'particular', 'case', 'way', 'thing', 'things', 'stuff', 'lot',
  'bit', 'kind', 'sort', 'type', 'part', 'side', 'point',
  'time', 'times', 'today', 'tomorrow', 'yesterday', 'day', 'days',
  'week', 'weeks', 'month', 'months', 'year', 'years', 'hour', 'hours',
  'minute', 'minutes', 'second', 'seconds', 'moment', 'number', 'numbers',
  'question', 'questions', 'answer', 'answers', 'problem', 'problems',
  'issue', 'issues', 'reason', 'reasons', 'result', 'results',
  'idea', 'ideas', 'approach', 'approaches', 'option', 'options',
  'step', 'steps', 'process', 'line', 'lines', 'word', 'words',
  'name', 'names', 'place', 'places', 'level', 'levels',
  'state', 'version', 'versions', 'piece', 'pieces', 'section', 'sections',
  'people', 'person', 'man', 'woman', 'child', 'group', 'team',
  'system', 'systems', 'hand', 'hands', 'head', 'body', 'home',
  'world', 'area', 'areas', 'room', 'house', 'story',
  // Common adjectives (non-technical)
  'good', 'bad', 'great', 'big', 'small', 'large', 'little', 'long',
  'short', 'new', 'old', 'first', 'last', 'next', 'few', 'many', 'much',
  'own', 'other', 'another', 'each', 'every', 'all', 'any', 'some', 'no',
  'same', 'different', 'able', 'sure', 'likely', 'possible', 'certain',
  'whole', 'entire', 'full', 'half', 'several', 'enough', 'such',
  'true', 'false', 'real', 'actual', 'current', 'previous', 'final',
  'important', 'available', 'useful', 'correct', 'wrong', 'proper',
  'simple', 'easy', 'hard', 'difficult', 'similar', 'specific',
  'necessary', 'key', 'main', 'basic', 'common', 'single', 'original',
  'relevant', 'appropriate', 'additional', 'existing', 'extra',
  // Negation
  'not', "n't", 'dont', 'doesnt', 'didnt', 'wont', 'cant', 'couldnt',
  'shouldnt', 'wouldnt', 'isnt', 'arent', 'wasnt', 'werent', 'hasnt',
  'havent', 'hadnt',
  // AI/chat context noise
  'claude', 'assistant', 'user', 'please', 'thanks', 'thank', 'okay',
  'ok', 'yes', 'no', 'yeah', 'yep', 'nope', 'hey', 'hi', 'hello',
  'sure', 'sorry', 'like', 'just', 'well', 'right', 'gonna', 'wanna',
  'gotta', 'kinda', 'sorta', 'basically', 'actually', 'literally',
  // Numbers as words
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'hundred', 'thousand', 'million',
]);

/** Build the effective stopword set, removing any user-preserved words. */
function getEffectiveStopwords(): Set<string> {
  const config = getConfig();
  const preserve = config.topic_model.preserve_words;
  if (!preserve || preserve.length === 0) return STOPWORDS;

  const effective = new Set(STOPWORDS);
  for (const word of preserve) {
    effective.delete(word.toLowerCase());
  }
  return effective;
}

/**
 * Compress text for topic extraction by stripping stopwords.
 * Preserves technical terms, file paths, code identifiers, and URLs.
 * Respects topic_model.preserve_words config to keep project-specific terms.
 */
function compressText(text: string): string {
  const stopwords = getEffectiveStopwords();
  const config = getConfig();
  const preserveSet = new Set(
    (config.topic_model.preserve_words || []).map(w => w.toLowerCase())
  );
  return text
    // Collapse multiple whitespace/newlines
    .replace(/\s+/g, ' ')
    // Strip stopwords (word boundary match, case-insensitive)
    // But protect file paths, URLs, and dotted identifiers (e.g. schema.sql, bge-m3)
    .replace(/(?<![.\-/\\@#])\b([a-zA-Z']+)\b(?![.\-/\\@#])/g, (match) => {
      return stopwords.has(match.toLowerCase()) ? '' : match;
    })
    // Strip any remaining standalone 1-2 char words (not part of paths/identifiers)
    // But respect preserve_words (e.g. "HG" is a project name)
    .replace(/(?<![.\-/\\@#\w])\b([a-zA-Z]{1,2})\b(?![.\-/\\@#\w])/g, (match) => {
      return preserveSet.has(match.toLowerCase()) ? match : '';
    })
    // Collapse resulting multiple spaces
    .replace(/  +/g, ' ')
    .trim();
}

/**
 * Build session text chunks for topic extraction.
 *
 * Strategy 'full': gathers all turn texts, compresses, chunks into CHUNK_SIZE pieces.
 * Strategy 'first_message': uses only the first user message (legacy behavior).
 */
async function buildSessionChunks(
  sessionId: string,
  projectName: string | null,
  filesTouched: string[],
  toolsUsed: string[],
): Promise<string[]> {
  const config = getConfig();
  const storage = getStorage();
  const strategy = config.topic_model.strategy || 'full';

  // Build metadata header (shared across all chunks)
  const metaParts: string[] = [];
  if (projectName) metaParts.push(`Project: ${projectName}`);
  if (filesTouched?.length) {
    metaParts.push(`Files: ${filesTouched.slice(0, 20).join(', ')}`);
  }
  if (toolsUsed?.length) {
    metaParts.push(`Tools: ${toolsUsed.join(', ')}`);
  }
  const metaHeader = metaParts.length > 0 ? metaParts.join('\n') + '\n\n' : '';
  const headerLen = metaHeader.length;
  const chunkContentSize = CHUNK_SIZE - headerLen;

  if (strategy === 'first_message') {
    const firstMessage = await storage.getFirstUserMessage(sessionId);
    if (!firstMessage) return [];
    return [metaHeader + firstMessage.slice(0, chunkContentSize)];
  }

  // Full strategy: gather all turn texts
  const turnTexts = await storage.getSessionTurnTexts(sessionId);
  if (turnTexts.length === 0) {
    // Fallback to first message if no embedding texts
    const firstMessage = await storage.getFirstUserMessage(sessionId);
    if (!firstMessage) return [];
    return [metaHeader + firstMessage.slice(0, chunkContentSize)];
  }

  // Compress and join all turn texts
  const compressed = turnTexts.map(compressText).join('\n---\n');

  // If it fits in one chunk, return it
  if (compressed.length <= chunkContentSize) {
    return [metaHeader + compressed];
  }

  // Split into chunks, breaking at turn boundaries where possible
  const chunks: string[] = [];
  let current = '';

  for (const turnText of turnTexts.map(compressText)) {
    const separator = current ? '\n---\n' : '';
    if (current.length + separator.length + turnText.length > chunkContentSize) {
      // Current chunk is full; push it
      if (current) chunks.push(metaHeader + current);
      // If a single turn exceeds chunk size, truncate it
      current = turnText.slice(0, chunkContentSize);
    } else {
      current += separator + turnText;
    }
  }
  if (current) chunks.push(metaHeader + current);

  return chunks;
}

/**
 * Call the topic model for a single chunk. Returns partial tags + summary.
 */
async function extractChunkTopics(
  chunk: string,
  chunkIndex: number,
  totalChunks: number,
): Promise<TopicResult | null> {
  const config = getConfig();

  const chunkLabel = totalChunks > 1
    ? `This is part ${chunkIndex + 1} of ${totalChunks} from the session.`
    : 'This is the full session content.';

  const prompt = `Extract 3-5 topic tags and a 1-sentence summary for this Claude Code session.
Tags should be specific (e.g., "drizzle-orm migration", "MCP server setup", not "coding" or "development").
${chunkLabel}
Return ONLY valid JSON: {"tags": ["tag1", "tag2"], "summary": "One sentence summary."}

Session context:
${chunk}`;

  const response = await fetch(`${config.topic_model.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.topic_model.model,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 256 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as { response: string };
  return parseJsonResponse(data.response);
}

/**
 * Merge results from multiple chunks: deduplicate tags by frequency, combine summaries.
 */
function mergeChunkResults(results: TopicResult[]): TopicResult {
  if (results.length === 1) return results[0];

  // Count tag frequency across chunks (normalize to lowercase for dedup)
  const tagCounts = new Map<string, { count: number; original: string }>();
  for (const r of results) {
    for (const tag of r.tags) {
      const key = tag.toLowerCase().trim();
      const existing = tagCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        tagCounts.set(key, { count: 1, original: tag });
      }
    }
  }

  // Sort by frequency (descending), take top 5-8
  const sortedTags = [...tagCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map(t => t.original);

  // Use the last chunk's summary (most likely to capture final state)
  const summary = results[results.length - 1].summary;

  return { tags: sortedTags, summary };
}

/**
 * Extract topic tags and a summary for a session using Ollama.
 * Uses multi-pass chunking for full session coverage.
 */
export async function extractTopics(
  sessionId: string,
  projectName: string | null,
  filesTouched: string[],
  toolsUsed: string[]
): Promise<TopicResult | null> {
  const chunks = await buildSessionChunks(sessionId, projectName, filesTouched, toolsUsed);
  if (chunks.length === 0) return null;

  try {
    const chunkResults: TopicResult[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const result = await extractChunkTopics(chunks[i], i, chunks.length);
      if (result && Array.isArray(result.tags) && typeof result.summary === 'string') {
        chunkResults.push(result);
      }
    }

    if (chunkResults.length === 0) return null;

    const merged = mergeChunkResults(chunkResults);
    const tags = merged.tags.filter(t => typeof t === 'string' && t.length > 0).slice(0, 8);
    const summary = merged.summary.slice(0, 500);

    return { tags, summary };
  } catch (err) {
    console.error(`  Topic extraction failed for ${sessionId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Parse JSON from LLM response, handling markdown code blocks.
 */
function parseJsonResponse(text: string): TopicResult | null {
  // Strip markdown code blocks if present
  let cleaned = text.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find JSON object in the text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Backfill topics for all sessions that don't have them.
 * Processes in batches with concurrency control.
 */
export async function backfillTopics(
  opts?: { batchSize?: number; concurrency?: number; onProgress?: (done: number, total: number, sessionId: string, project: string, tagCount: number) => void }
): Promise<{ processed: number; failed: number; skipped: number }> {
  const batchSize = opts?.batchSize || 10;
  const concurrency = opts?.concurrency || getConfig().concurrency.topics;
  const log = opts?.onProgress;
  const storage = getStorage();

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let totalProcessed = 0;

  // Process in batches
  while (true) {
    const sessions = await storage.getSessionsWithoutTopics(batchSize);
    if (sessions.length === 0) break;

    // Process with concurrency
    for (let i = 0; i < sessions.length; i += concurrency) {
      const batch = sessions.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (s) => {
          const result = await extractTopics(s.session_id, s.project_name, s.files_touched, s.tools_used);
          if (!result) {
            // Mark as processed with empty summary so it won't be re-fetched
            await storage.updateSessionTopics(s.session_id, ['_no_content'], '');
            skipped++;
            return;
          }
          await storage.updateSessionTopics(s.session_id, result.tags, result.summary);
          processed++;
          totalProcessed++;
          log?.(totalProcessed, -1, s.session_id, s.project_name || '?', result.tags.length);
        })
      );

      for (const r of results) {
        if (r.status === 'rejected') {
          failed++;
          console.error(`  Topic extraction error: ${r.reason}`);
        }
      }
    }
  }

  return { processed, failed, skipped };
}
