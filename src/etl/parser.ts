import { createReadStream } from 'fs';
import { createInterface } from 'readline';

/**
 * Raw JSONL message types from Claude Code transcripts.
 * Each line is a JSON object with a `type` field.
 */
export interface RawMessage {
  type: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  slug?: string;
  timestamp?: string;
  isSidechain?: boolean;
  // user/assistant messages
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // system messages
  subtype?: string;
  // progress messages
  data?: Record<string, unknown>;
  // queue operations
  operation?: string;
  content?: string;
  // plan content (on user messages)
  planContent?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

/** Relevant message types to keep. Skip progress, file-history-snapshot, queue-operation, system. */
const RELEVANT_TYPES = new Set(['user', 'assistant']);

/**
 * Stream-parse a JSONL file, yielding only user and assistant messages.
 */
export async function* parseTranscript(filePath: string): AsyncGenerator<RawMessage> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const msg: RawMessage = JSON.parse(line);
      if (RELEVANT_TYPES.has(msg.type)) {
        yield msg;
      }
    } catch {
      // Skip malformed lines
    }
  }
}

/**
 * Parse ALL messages (including system, progress) for metadata extraction.
 */
export async function* parseAllMessages(filePath: string): AsyncGenerator<RawMessage> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Skip malformed lines
    }
  }
}
