/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '@/i18n';
import {
  LUMO_CHROME_STORE_URL,
  LUMO_EDGE_ADDONS_URL,
  LUMO_REPOSITORY_URL,
} from '@/lib/lumo-agent';
import { AgentIntro } from '@/components/agent/AgentIntro';

const EXTENSION_ID = 'b'.repeat(32);

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

describe('AgentIntro', () => {
  it('collapses to a single row until opened', async () => {
    render(<AgentIntro />);

    expect(screen.getByRole('button', { name: /About agent access/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the three-step walkthrough', async () => {
    render(<AgentIntro />);
    fireEvent.click(screen.getByRole('button', { name: /About agent access/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Install Lumo Agent');
    expect(dialog.textContent).toContain('Add an extension service in Lumo');
    expect(dialog.textContent).toContain('Settings › MCP › Extensions');
    expect(dialog.textContent).toContain('Paste this extension’s ID');
    expect(dialog.textContent).toContain(EXTENSION_ID);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('offers both store listings and the repository', async () => {
    render(<AgentIntro />);
    fireEvent.click(screen.getByRole('button', { name: /About agent access/ }));

    const dialog = await screen.findByRole('dialog');
    const hrefs = Array.from(dialog.querySelectorAll('a')).map((anchor) =>
      anchor.getAttribute('href'),
    );
    expect(hrefs).toEqual([
      LUMO_CHROME_STORE_URL,
      LUMO_EDGE_ADDONS_URL,
      LUMO_REPOSITORY_URL,
    ]);
    for (const anchor of Array.from(dialog.querySelectorAll('a'))) {
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('rel')).toBe('noreferrer');
    }
  });

  it('copies this extension id from the last step', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<AgentIntro />);
    fireEvent.click(screen.getByRole('button', { name: /About agent access/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog.querySelector('button[aria-label="Copy extension ID"]')!);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(EXTENSION_ID));
    await waitFor(() => expect(dialog.textContent).toContain('Extension ID copied'));
  });
});
