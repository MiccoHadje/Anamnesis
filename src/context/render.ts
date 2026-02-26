/**
 * Phase 3: Render — progressive-detail markdown formatting with drill-down hints.
 */

import type { AllocatedItem } from './allocate.js';
import type { ContextResult } from './types.js';
import { estimateTokens, COST_FULL_USER_CHARS, COST_FULL_ASSISTANT_CHARS, COST_SUMMARY_CHARS } from './types.js';

function formatDate(date: Date | null): string {
  if (!date) return '?';
  const d = new Date(date);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function renderFull(item: AllocatedItem): string {
  const lines: string[] = [];
  const id = item.sessionId.slice(0, 8);
  const turnLabel = item.turnIndex !== null ? ` — turn ${item.turnIndex}` : '';
  const sourceLabel = item.source === 'link' ? ` (via ${item.linkType})` : '';
  const matchLabel = item.similarity >= 0.6 ? 'high' : item.similarity >= 0.4 ? 'medium' : 'low';
  const date = formatDate(item.startedAt);
  const tags = item.sessionTags.length > 0 ? ` [${item.sessionTags.join(', ')}]` : '';

  lines.push(`## [${id}] ${item.projectName}${turnLabel} — ${matchLabel} match — ${date}${tags}${sourceLabel}`);

  if (item.userContent) {
    lines.push(`**User:** ${truncate(item.userContent, COST_FULL_USER_CHARS)}`);
  }
  if (item.assistantContent) {
    lines.push(`**Assistant:** ${truncate(item.assistantContent, COST_FULL_ASSISTANT_CHARS)}`);
  }
  if (item.sessionSummary && !item.userContent) {
    lines.push(`**Summary:** ${item.sessionSummary}`);
  }

  // Drill-down hints
  if (item.relatedTurns.length > 0) {
    const turnHints = item.relatedTurns
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(t => `turn ${t.turnIndex} (${(t.similarity * 100).toFixed(0)}%)`)
      .join(', ');
    lines.push(`  See also: ${turnHints}`);
  }
  if (item.linkedSessions.length > 0) {
    const linkHints = item.linkedSessions
      .slice(0, 3)
      .map(l => {
        const detail = l.detail ? `, ${l.detail}` : '';
        return `[${l.sessionId.slice(0, 8)}] ${l.projectName} (${l.linkType}${detail})`;
      })
      .join(', ');
    lines.push(`  Linked: ${linkHints}`);
  }

  return lines.join('\n');
}

function renderSummary(item: AllocatedItem): string {
  const id = item.sessionId.slice(0, 8);
  const date = formatDate(item.startedAt);
  const sourceLabel = item.source === 'link' ? ` (via ${item.linkType})` : '';
  const tags = item.sessionTags.length > 0 ? ` [${item.sessionTags.join(', ')}]` : '';
  const summary = item.sessionSummary
    ? truncate(item.sessionSummary, COST_SUMMARY_CHARS)
    : item.userContent
      ? truncate(item.userContent, COST_SUMMARY_CHARS)
      : 'No summary available';

  return `### [${id}] ${item.projectName} — ${date}${tags}${sourceLabel}\n${summary}`;
}

function renderTitle(item: AllocatedItem): string {
  const id = item.sessionId.slice(0, 8);
  const date = formatDate(item.startedAt);
  const sourceLabel = item.source === 'link' ? ` (${item.linkType})` : '';
  const tags = item.sessionTags.length > 0 ? ` [${item.sessionTags.slice(0, 3).join(', ')}]` : '';
  return `- [${id}] ${item.projectName} — ${date}${tags}${sourceLabel}`;
}

/**
 * Render allocated items into progressive-detail markdown.
 */
export function render(items: AllocatedItem[], budget: number): ContextResult {
  const fullItems = items.filter(i => i.detail === 'full');
  const summaryItems = items.filter(i => i.detail === 'summary');
  const titleItems = items.filter(i => i.detail === 'title');

  const sections: string[] = [];

  if (fullItems.length > 0) {
    for (const item of fullItems) {
      sections.push(renderFull(item));
    }
  }

  if (summaryItems.length > 0) {
    sections.push('---');
    for (const item of summaryItems) {
      sections.push(renderSummary(item));
    }
  }

  if (titleItems.length > 0) {
    sections.push('---\n**Also related:**');
    for (const item of titleItems) {
      sections.push(renderTitle(item));
    }
  }

  const markdown = sections.join('\n\n');
  const tokenEstimate = estimateTokens(markdown);
  const sessionIds = [...new Set(items.map(i => i.sessionId))];
  const truncated = tokenEstimate > budget;

  return { markdown, tokenEstimate, sessionIds, truncated };
}
