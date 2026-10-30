import type { ReactNode } from 'react';
import { Field, type FieldControlProps } from '@/components/ui/field';
import { MetaTag } from './MetaTag';
import { ResetOverride } from './ResetOverride';

/**
 * A userscript metadata field: label + raw `@tag` chip + inherited-value reset.
 *
 * Empty input means "inherit the value declared in the script source" — the
 * declared value is shown as the placeholder, so the rule is visible in the
 * control instead of explained in a sentence. When an override exists the row
 * grows a reset affordance, which is the only way to see (and undo) the
 * difference between "I cleared it" and "it was never set".
 */
export function MetaField({
  label,
  tag,
  tip,
  overridden,
  onReset,
  className,
  children,
}: {
  label: string;
  tag: string;
  tip: ReactNode;
  overridden?: boolean;
  onReset?: () => void;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}) {
  return (
    <Field
      className={className}
      label={label}
      labelAccessory={
        <>
          <MetaTag tag={tag} tip={tip} />
          {overridden && onReset && <ResetOverride onReset={onReset} />}
        </>
      }
    >
      {children}
    </Field>
  );
}
