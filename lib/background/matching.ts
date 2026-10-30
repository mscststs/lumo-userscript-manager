import type { ScriptMetadata, UrlRule, UserScript } from '@/types';
import { mergeMetadata } from '@/lib/script/metadata';
import { compileUrlRules, urlMatches } from '@/lib/script/url-rules';
import { getPageAccess } from '@/lib/page-access';

export interface EvaluatedScript {
  script: UserScript;
  /** The script's metablock with user overrides applied. */
  metadata: ScriptMetadata;
  /** Enabled and not in the recycle bin: this script would actually run. */
  active: boolean;
  /** Compiled rules, kept so callers can cache them across URL comparisons. */
  rules: UrlRule[];
  /** True when `url` is covered by this script's `@match` / `@include`. */
  matchesCurrent: boolean;
}

/**
 * Evaluate the whole library against one URL.
 *
 * The popup and the toolbar badge answer the same question — "which scripts
 * apply here, and which of them are on?" — so they share one implementation.
 * Two copies would eventually disagree on an edge case (a `@run-at
 * context-menu` script, a script in the recycle bin, a privileged page) and the
 * badge would contradict the list the user is looking at.
 */
export function evaluateScripts(scripts: UserScript[], url: string | undefined): EvaluatedScript[] {
  return scripts.map((script) => {
    const metadata = mergeMetadata(script.metadata, script.selfMetadata);
    const rules = compileUrlRules(metadata);
    return {
      script,
      metadata,
      active: script.enabled && !script.removedAt,
      rules,
      matchesCurrent: url ? urlMatches(url, rules) : false,
    };
  });
}

/** Count the scripts that would run on `url`, given pre-compiled rules. */
export function countActiveScripts(
  entries: Pick<EvaluatedScript, 'active' | 'rules'>[],
  url: string | undefined,
): number {
  if (!url) return 0;
  // Privileged surfaces cannot receive injections, so their count is zero no
  // matter how many rules technically match (`lib/page-access.ts` owns the list).
  if (!getPageAccess(url).injectable) return 0;
  let count = 0;
  for (const entry of entries) {
    if (entry.active && urlMatches(url, entry.rules)) count += 1;
  }
  return count;
}
