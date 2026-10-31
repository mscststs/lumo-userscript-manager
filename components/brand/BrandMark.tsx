import logoUrl from '@/assets/logo.svg';
import { cn } from '@/lib/utils';

/**
 * The product mark — the same artwork the toolbar icon is rendered from.
 *
 * Every surface that names the product (the options rail, About, the install
 * page) used to borrow a generic file glyph from the icon set, which made the
 * extension look like any other tool built on the same set. The mark is the
 * one place where the product is allowed to be itself.
 *
 * Rendered as an `<img>` of the source SVG rather than inlined: the artwork
 * carries its own gradients and filter ids, and inlining it more than once per
 * page would make those ids collide. Decorative — the wordmark or page title
 * next to it is the accessible name.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src={logoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('h-6 w-6 shrink-0 select-none', className)}
    />
  );
}
