/**
 * Phase 2: Allocate — greedy budget fill with progressive detail levels.
 */

import type { ContextItem, DetailLevel } from './types.js';

export interface AllocatedItem extends ContextItem {
  detail: DetailLevel;
}

/**
 * Walk ranked items, greedily assigning detail levels based on remaining budget.
 * Returns items with their assigned detail level (omitted items excluded).
 */
export function allocate(items: ContextItem[], budget: number): AllocatedItem[] {
  let remaining = budget;
  const allocated: AllocatedItem[] = [];

  for (const item of items) {
    if (remaining <= 0) break;

    if (item.costFull <= remaining) {
      allocated.push({ ...item, detail: 'full' });
      remaining -= item.costFull;
    } else if (item.costSummary <= remaining) {
      allocated.push({ ...item, detail: 'summary' });
      remaining -= item.costSummary;
    } else if (item.costTitle <= remaining) {
      allocated.push({ ...item, detail: 'title' });
      remaining -= item.costTitle;
    }
    // else: omit — budget exhausted for this item
  }

  return allocated;
}
