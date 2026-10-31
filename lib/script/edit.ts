/**
 * Verified text replacement for the agent `edit` tool.
 *
 * Models are bad at line numbers but reliable at quoting the text they want to
 * change. The primitive is therefore `oldText -> newText` located by content,
 * never by position. Adapted from Lumo's `file_edit` engine: the same three
 * escalating strategies, the same hard failure on an ambiguous anchor, and the
 * same all-or-nothing batch semantics.
 */

export interface ReplaceEdit {
  oldText: string;
  newText: string;
}

export type MatchStrategy = 'exact' | 'trimmed-indent' | 'whitespace-normalized';

export interface ReplaceSuccess {
  ok: true;
  text: string;
  strategy: MatchStrategy;
  /** 1-based line where the replacement landed, for reporting only. */
  line: number;
}

export interface ReplaceFailure {
  ok: false;
  error: string;
  occurrences: number;
}

export type ReplaceResult = ReplaceSuccess | ReplaceFailure;

function commonIndent(lines: string[]): string {
  let indent: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const lead = line.slice(0, line.length - line.trimStart().length);
    if (indent === null) {
      indent = lead;
      continue;
    }
    let i = 0;
    while (i < indent.length && i < lead.length && indent[i] === lead[i]) i++;
    indent = indent.slice(0, i);
  }
  return indent ?? '';
}

function dedent(text: string): string {
  const lines = text.split('\n');
  const indent = commonIndent(lines);
  if (!indent) return text;
  return lines.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n');
}

function indentBlock(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? line : indent + line))
    .join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line += 1;
  return line;
}

function findByNormalizedLines(
  haystackLines: string[],
  needleLines: string[],
): { start: number; count: number } | null {
  if (needleLines.length === 0 || needleLines.length > haystackLines.length) return null;
  const norm = (value: string) => value.trim().replace(/\s+/g, ' ');
  const needle = needleLines.map(norm);
  let found: { start: number; count: number } | null = null;

  for (let i = 0; i + needle.length <= haystackLines.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (norm(haystackLines[i + j]!) !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // Ambiguity is a failure, not a coin flip.
    if (found) return null;
    found = { start: i, count: needle.length };
  }
  return found;
}

/**
 * Replace `oldText` with `newText` exactly once.
 *
 * Strategies, in order: verbatim, dedented anchor, whitespace-normalized line
 * structure. The first strategy that yields a unique match wins; a missing or
 * ambiguous anchor is a hard failure so the model can retry with more context.
 */
export function replaceOnce(source: string, edit: ReplaceEdit): ReplaceResult {
  const { oldText, newText } = edit;

  if (oldText === '') {
    return {
      ok: false,
      occurrences: 0,
      error:
        'oldText must not be empty. To append code, anchor on the last existing line; ' +
        'to rewrite the whole script use update.',
    };
  }
  if (oldText === newText) {
    return { ok: false, occurrences: 0, error: 'oldText and newText are identical.' };
  }

  const exactCount = countOccurrences(source, oldText);
  if (exactCount === 1) {
    const at = source.indexOf(oldText);
    return {
      ok: true,
      text: source.slice(0, at) + newText + source.slice(at + oldText.length),
      strategy: 'exact',
      line: lineAt(source, at),
    };
  }
  if (exactCount > 1) {
    return {
      ok: false,
      occurrences: exactCount,
      error:
        `oldText matches ${exactCount} places in the script, so the edit is ambiguous. ` +
        'Include more surrounding context so it identifies exactly one location.',
    };
  }

  const dedentedOld = dedent(oldText);
  if (dedentedOld !== oldText) {
    const count = countOccurrences(source, dedentedOld);
    if (count === 1) {
      const at = source.indexOf(dedentedOld);
      return {
        ok: true,
        text: source.slice(0, at) + dedent(newText) + source.slice(at + dedentedOld.length),
        strategy: 'trimmed-indent',
        line: lineAt(source, at),
      };
    }
  }

  const sourceLines = source.split('\n');
  const hit = findByNormalizedLines(sourceLines, oldText.split('\n'));
  if (hit) {
    const target = sourceLines.slice(hit.start, hit.start + hit.count);
    const targetIndent = commonIndent(target);
    const rebuilt = indentBlock(dedent(newText), targetIndent);
    return {
      ok: true,
      text: [
        ...sourceLines.slice(0, hit.start),
        ...rebuilt.split('\n'),
        ...sourceLines.slice(hit.start + hit.count),
      ].join('\n'),
      strategy: 'whitespace-normalized',
      line: hit.start + 1,
    };
  }

  return {
    ok: false,
    occurrences: 0,
    error:
      'oldText was not found in the script. Call get with includeCode first and copy the exact ' +
      'text you want to replace, including indentation. Do not guess or reconstruct it from memory.',
  };
}

/** Apply edits sequentially; the first failure aborts the whole batch. */
export function applyEdits(
  source: string,
  edits: ReplaceEdit[],
):
  | { ok: true; text: string; applied: ReplaceSuccess[] }
  | { ok: false; error: string; index: number } {
  let text = source;
  const applied: ReplaceSuccess[] = [];

  for (let index = 0; index < edits.length; index += 1) {
    const result = replaceOnce(text, edits[index]!);
    if (!result.ok) {
      // All-or-nothing: a half-applied batch is a state neither side can reason
      // about, and the model cannot tell which edits survived.
      return { ok: false, error: `edits[${index}]: ${result.error}`, index };
    }
    text = result.text;
    applied.push(result);
  }

  return { ok: true, text, applied };
}
