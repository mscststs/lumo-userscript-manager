import { Fragment, useEffect, useState } from 'react';
import type { HighlighterCore } from 'shiki/core';
import { cn } from '@/lib/utils';

export type CodeLanguage = 'javascript' | 'json';

let highlighter: Promise<HighlighterCore> | null = null;

/**
 * One highlighter per page, created on first use.
 *
 * Fine-grained imports keep the bundle to two grammars and two themes instead
 * of Shiki's full catalogue, and the JavaScript regex engine avoids WASM, which
 * an MV3 extension page would otherwise have to allow in its CSP. Everything is
 * dynamically imported, so a page that never shows code never pays for it.
 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [import('shiki/langs/javascript.mjs'), import('shiki/langs/json.mjs')],
      engine: createJavaScriptRegexEngine(),
    });
  })().catch((error: unknown) => {
    // Let a later mount retry instead of caching the failure forever.
    highlighter = null;
    throw error;
  });
  return highlighter;
}

/**
 * Read-only highlighted code (Shiki).
 *
 * Renders both palettes at once (`--shiki-dark` on every token); `.dark`
 * switches them in CSS, so a theme change repaints without re-tokenising.
 *
 * Until the grammar has loaded, the same lines are painted unhighlighted in
 * the same box, so the swap to colour never changes the height of the block.
 * Very long lines (minified bundles) stop tokenising past 2,000 characters
 * rather than stalling the page.
 */
export function CodeView({
  code,
  lang = 'javascript',
  lineNumbers = false,
  className,
}: {
  code: string;
  lang?: CodeLanguage;
  lineNumbers?: boolean;
  className?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    getHighlighter()
      .then((instance) => {
        if (cancelled) return;
        setHtml(
          instance.codeToHtml(code, {
            lang,
            themes: { light: 'github-light', dark: 'github-dark' },
            defaultColor: 'light',
            tokenizeMaxLineLength: 2000,
            tokenizeTimeLimit: 500,
          }),
        );
      })
      .catch(() => {
        // The plain rendering below is already a complete fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div
      className={cn('code-view font-mono text-2xs leading-5 text-foreground', className)}
      data-line-numbers={lineNumbers ? '' : undefined}
    >
      {html ? (
        // Shiki escapes every token; the markup is generated, not user HTML.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="shiki">
          <code>
            {code.split('\n').map((line, index) => (
              <Fragment key={index}>
                {index > 0 && '\n'}
                <span className="line">{line}</span>
              </Fragment>
            ))}
          </code>
        </pre>
      )}
    </div>
  );
}
