import { useEffect, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ScriptIconProps {
  /**
   * What to paint: the cached `data:` URL once the background has warmed it,
   * otherwise the script's remote `@icon`.
   */
  src?: string;
  /**
   * Script is off. The tile keeps its artwork (so the script stays
   * recognisable) but desaturates it and draws the strike-through that the
   * product already uses for "off" everywhere else.
   */
  dimmed?: boolean;
  className?: string;
}

/**
 * Identity tile for one script.
 *
 * A userscript is recognised by its `@icon` the way an app is recognised by its
 * app icon, so the popup row leads with it instead of with a power glyph — the
 * row itself is still the switch, and its state is carried by the row's ink.
 *
 * The fallback is not a placeholder that gets swapped out: it is painted
 * *underneath* the bitmap and stays there until the image has actually
 * decoded. A broken or unreachable `@icon` therefore degrades to the fallback
 * with no empty state at all — including the frames before `onLoad`.
 *
 * The bitmap is inset 3px inside the 20px tile. A real favicon is a solid,
 * usually saturated square, while the fallback is a thin 12px line glyph; drawn
 * edge-to-edge the bitmap carries visibly more weight than the glyph and makes
 * the list look like two different icon systems. 14px of colour reads as the
 * same "size" as 12px of stroke, which is what keeps the column calm.
 *
 * "Off" is drawn *over* the tile rather than by fading the tile: a half-faded
 * coloured favicon still reads as an active app, and opacity alone is easy to
 * miss at 14px. The strike is the same diagonal the power glyph uses, so the
 * vocabulary stays consistent, and it is double-stroked (tile-coloured backing
 * under a foreground line) so it stays legible on any artwork — including a
 * white or fully transparent icon.
 */
export function ScriptIcon({ src, dimmed = false, className }: ScriptIconProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>(
    src ? 'loading' : 'failed',
  );

  // A changed source is a different image: the previous decode result is stale.
  useEffect(() => {
    setStatus(src ? 'loading' : 'failed');
  }, [src]);

  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-muted',
        className,
      )}
    >
      <FileCode2
        className={cn(
          'h-3 w-3 text-muted-foreground transition-opacity duration-150 ease-standard',
          dimmed && 'opacity-55',
        )}
      />
      {src && status !== 'failed' && (
        <img
          src={src}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('failed')}
          className={cn(
            // Inset rather than `h-full w-full`: the tile keeps its 20px hit
            // area, the artwork sits in the optical 14px core.
            'absolute inset-[3px] h-auto w-auto rounded-[3px] object-contain',
            'transition-[opacity,filter] duration-150 ease-standard',
            status === 'loaded' ? 'opacity-100' : 'opacity-0',
            dimmed && status === 'loaded' && 'opacity-55 grayscale',
          )}
        />
      )}
      {dimmed && (
        <svg viewBox="0 0 20 20" className="absolute inset-0 h-full w-full text-foreground/70">
          {/* Backing stroke in the tile's own colour cuts the artwork so the
              line reads on saturated, pale and transparent icons alike. */}
          <line
            x1="4.5"
            y1="15.5"
            x2="15.5"
            y2="4.5"
            stroke="var(--color-muted)"
            strokeWidth="4.5"
            strokeLinecap="round"
          />
          <line
            x1="4.5"
            y1="15.5"
            x2="15.5"
            y2="4.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      )}
    </span>
  );
}
