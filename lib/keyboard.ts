/**
 * Keyboard helpers shared by every text field that implements its own
 * Enter-to-submit shortcut.
 *
 * A keydown whose `key` is Enter is also the key that confirms an active IME
 * composition. Acting on it would submit the half-composed text. `isComposing`
 * is the native signal; WebKit/Safari has historically delivered
 * `compositionend` before the confirming keydown, so `keyCode === 229` is kept
 * as the cross-engine fallback (modern-web-guidance `ime-safe-enter-submit`).
 */
interface ImeEventLike {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export function isImeComposing(event: ImeEventLike): boolean {
  const source = event.nativeEvent ?? event;
  return Boolean(source.isComposing || source.keyCode === 229);
}
