/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MotionConfig } from 'motion/react';
import i18n from '@/i18n';
import type { AgentPendingRequest, AgentSettings } from '@/types';
import type { AgentAccess } from '@/store/useAgentAccess';
import { AgentAccessDialog } from '@/components/agent/AgentAccessDialog';
import { ToastProvider } from '@/components/ui/toast';

const HOST_ID = 'c'.repeat(32);

const SETTINGS: AgentSettings = {
  enabled: false,
  allowedExtensionIds: [],
  allowWrites: false,
  reviewWrites: true,
  promptOnRequest: true,
};

function request(patch: Partial<AgentPendingRequest> = {}): AgentPendingRequest {
  const now = Date.now();
  return {
    id: HOST_ID,
    name: 'Acme Agent',
    version: '1.2.3',
    firstSeen: now - 10_000,
    lastSeen: now - 5_000,
    promptedAt: now - 1_000,
    ...patch,
  };
}

function makeAccess(
  requests: AgentPendingRequest[],
  patch: Partial<AgentAccess> = {},
): AgentAccess {
  return {
    settings: SETTINGS,
    requests,
    actionable: requests.filter((entry) => !entry.dismissedAt),
    approve: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
    ...patch,
  };
}

function renderDialog(access: AgentAccess) {
  return render(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <AgentAccessDialog access={access} />
      </ToastProvider>
    </MotionConfig>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
});

describe('AgentAccessDialog', () => {
  it('interrupts with the caller identity for a freshly prompted request', async () => {
    renderDialog(makeAccess([request()]));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Acme Agent');
    expect(dialog.textContent).toContain(HOST_ID);
    expect(dialog.textContent).toContain('1.2.3');
  });

  it('shows the remaining queue size', async () => {
    renderDialog(
      makeAccess([request(), request({ id: 'd'.repeat(32), name: 'Second Agent' })]),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('1 more');
  });

  it('approves the caller from the dialog', async () => {
    const access = makeAccess([request()]);
    renderDialog(access);

    fireEvent.click(await screen.findByRole('button', { name: 'Allow and enable' }));

    await waitFor(() => expect(access.approve).toHaveBeenCalledWith(HOST_ID));
  });

  it('does not hijack the page when prompting is turned off', async () => {
    renderDialog(makeAccess([request()], { settings: { ...SETTINGS, promptOnRequest: false } }));

    // Give the auto-open effect a chance to run before asserting absence.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('stays quiet for a stale queue the user opened manually', async () => {
    renderDialog(makeAccess([request({ promptedAt: Date.now() - 5 * 60_000 })]));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('ignores already dismissed requests', async () => {
    renderDialog(makeAccess([request({ dismissedAt: Date.now() })]));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('defers a request without approving it', async () => {
    const access = makeAccess([request()]);
    renderDialog(access);

    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(access.approve).not.toHaveBeenCalled();
    expect(access.dismiss).not.toHaveBeenCalled();
  });
});
