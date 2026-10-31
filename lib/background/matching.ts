import type { ScriptMetadata, UrlRule, UserScript } from '@/types';
import { mergeMetadata } from '@/lib/script/metadata';
import { compileUrlRules, urlMatches } from '@/lib/script/url-rules';

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
 * The popup answers "which scripts apply here, and which of them are on?". It
 * shares the definition of "on" with the toolbar badge — one implementation,
 * so a row the popup reads as enabled can never mean something else.
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

/**
 * Ids of the scripts that may run right now: enabled and not in the recycle bin.
 *
 * The badge intersects this set with the scripts that actually reported a start
 * in a tab (`lib/background/injected-state.ts`), so toggling a switch drops it
 * from the count without waiting for a reload.
 */
export function activeScriptUuids(scripts: UserScript[]): Set<string> {
  const result = new Set<string>();
  for (const script of scripts) {
    if (script.enabled && !script.removedAt) result.add(script.uuid);
  }
  return result;
}
