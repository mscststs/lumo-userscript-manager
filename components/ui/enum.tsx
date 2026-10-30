import { cn } from '@/lib/utils';

/**
 * A translated label next to the raw value that is actually persisted.
 *
 * Enum settings are the one place where the UI can lie: the user reads "文档空闲"
 * and the script receives `document-idle`. Both are shown, always in the same
 * two slots — label in the reading font, raw value in the code font — so the
 * mapping is legible without a translation table. Used in select triggers, in
 * select options and in read-only info rows, so those three surfaces can never
 * drift apart.
 */
export function EnumValue({
  label,
  raw,
  className,
}: {
  label: string;
  raw?: string;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 flex-1 items-center justify-between gap-2', className)}>
      <span className="min-w-0 truncate">{label}</span>
      {raw ? (
        <span className="shrink-0 font-mono text-2xs text-muted-foreground">{raw}</span>
      ) : null}
    </span>
  );
}
