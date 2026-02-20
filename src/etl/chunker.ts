import type { RawMessage, ContentBlock } from './parser.js';

/** Strip system-injected tags and task notifications from content */
const SYSTEM_TAG_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>/g;

function sanitizeContent(text: string): string {
  return text
    .replace(SYSTEM_TAG_RE, '')
    .replace(TASK_NOTIFICATION_RE, '')
    .trim();
}

/**
 * A turn is a user+assistant pair. The user part may include tool_result blocks
 * (responses to the previous assistant's tool_use), and the assistant part
 * includes text and tool_use blocks.
 */
export interface Turn {
  turnIndex: number;
  userContent: string;
  assistantContent: string;
  toolCalls: ToolCall[];
  filesInTurn: string[];
  timestampStart?: Date;
  timestampEnd?: Date;
  tokenCount?: number;
}

export interface ToolCall {
  name: string;
  input_summary: string;
  has_result: boolean;
}

/**
 * Group raw messages into user+assistant turn pairs.
 *
 * Strategy: Collect messages until we see a new user message with text content
 * (not just tool_results). Each group forms one turn.
 *
 * A "turn" is: User(text [+ tool_results]) → Assistant(text + tool_use)*
 * Multiple assistant messages can appear if there are continuation chains.
 */
export function chunkIntoTurns(messages: RawMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentUserTexts: string[] = [];
  let currentAssistantTexts: string[] = [];
  let currentToolCalls: ToolCall[] = [];
  let currentFiles: Set<string> = new Set();
  let turnStart: Date | undefined;
  let turnEnd: Date | undefined;
  let tokenCount = 0;
  let turnIndex = 0;
  let hasTurnContent = false;

  function flushTurn() {
    if (!hasTurnContent) return;

    turns.push({
      turnIndex,
      userContent: sanitizeContent(currentUserTexts.join('\n')),
      assistantContent: sanitizeContent(currentAssistantTexts.join('\n')),
      toolCalls: currentToolCalls,
      filesInTurn: [...currentFiles],
      timestampStart: turnStart,
      timestampEnd: turnEnd,
      tokenCount: tokenCount || undefined,
    });
    turnIndex++;
    currentUserTexts = [];
    currentAssistantTexts = [];
    currentToolCalls = [];
    currentFiles = new Set();
    turnStart = undefined;
    turnEnd = undefined;
    tokenCount = 0;
    hasTurnContent = false;
  }

  for (const msg of messages) {
    const ts = msg.timestamp ? new Date(msg.timestamp) : undefined;

    if (msg.type === 'user') {
      const content = msg.message?.content;

      // Check if this is a new user text message (not just tool_results)
      const hasText = typeof content === 'string'
        || (Array.isArray(content) && content.some((b: ContentBlock) => b.type === 'text'));

      if (hasText && hasTurnContent) {
        // New user text starts a new turn — flush previous
        flushTurn();
      }

      if (!turnStart && ts) turnStart = ts;
      if (ts) turnEnd = ts;

      // Extract user text
      if (typeof content === 'string') {
        currentUserTexts.push(content);
        hasTurnContent = true;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            currentUserTexts.push(block.text);
            hasTurnContent = true;
          } else if (block.type === 'tool_result') {
            // Tool results come from previous assistant tool_use
            // Include file paths from results in this turn's context
            // Skip image blocks (base64 data) — only extract text
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter(b => b.type === 'text').map(b => b.text || '').join('')
                : '';
            // Extract file paths from tool results
            extractFilePaths(resultText, currentFiles);
          }
        }
      }
    } else if (msg.type === 'assistant') {
      if (ts) turnEnd = ts;
      hasTurnContent = true;

      const content = msg.message?.content;
      const usage = msg.message?.usage;
      if (usage) {
        tokenCount += (usage.input_tokens || 0) + (usage.output_tokens || 0);
      }

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            currentAssistantTexts.push(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            const toolCall: ToolCall = {
              name: block.name,
              input_summary: summarizeToolInput(block.name, block.input),
              has_result: false,
            };
            currentToolCalls.push(toolCall);

            // Extract file paths from tool inputs
            if (block.input) {
              const fp = (block.input as Record<string, unknown>).file_path
                || (block.input as Record<string, unknown>).path
                || (block.input as Record<string, unknown>).filePath;
              if (typeof fp === 'string') currentFiles.add(fp);
            }
          }
        }
      }
    }
  }

  // Flush final turn
  flushTurn();

  return turns;
}

const MAX_SUMMARY_CHARS = 200;

function summarizeToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';

  let summary: string;
  switch (name) {
    case 'Read':
      summary = String(input.file_path || '');
      break;
    case 'Write':
    case 'Edit':
      summary = String(input.file_path || '');
      break;
    case 'Glob':
      summary = String(input.pattern || '');
      break;
    case 'Grep':
      summary = `${input.pattern || ''} in ${input.path || '.'}`;
      break;
    case 'Bash':
      summary = String(input.command || '');
      break;
    case 'Task':
      summary = String(input.description || '');
      break;
    default:
      summary = Object.keys(input).join(', ');
      break;
  }
  return summary.length > MAX_SUMMARY_CHARS
    ? summary.slice(0, MAX_SUMMARY_CHARS) + '...'
    : summary;
}

const FILE_PATH_RE = /(?:[A-Z]:\\|\/)[^\s"'`<>|]+\.\w{1,10}/gi;

function extractFilePaths(text: string, files: Set<string>) {
  const matches = text.match(FILE_PATH_RE);
  if (matches) {
    for (const m of matches) {
      files.add(m);
    }
  }
}
