/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '@/i18n';
import { ExtensionIdValue } from '@/components/agent/ExtensionIdValue';

const EXTENSION_ID = 'c'.repeat(32);

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { id: EXTENSION_ID } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ExtensionIdValue', () => {
  it('shows the whole id, wrapping instead of truncating it', () => {
    render(<ExtensionIdValue />);

    const code = document.querySelector('code');
    expect(code?.textContent).toBe(EXTENSION_ID);
    // A take-away value must never hide its middle; it wraps in the field form.
    expect(code?.className).toContain('break-all');
    expect(code?.className).not.toContain('truncate');
  });

  it('keeps the compact form inside the walkthrough step', () => {
    render(<ExtensionIdValue variant="inline" />);

    expect(document.querySelector('code')?.className).toContain('truncate');
  });

  it('copies the id and reports it through a live region', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<ExtensionIdValue />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy extension ID' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(EXTENSION_ID));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('copied'));
  });

  it('stays silent when the clipboard rejects', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<ExtensionIdValue />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy extension ID' }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // The id stays selectable in place; no status claim, no error banner.
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
