import { describe, expect, it } from 'vitest';
import type { AgentPendingRequest } from '@/types';
import { PROMPT_FRESH_MS, shouldOpenAgentPrompt } from '@/lib/agent/prompt-policy';

const NOW = 1_700_000_000_000;

function request(patch: Partial<AgentPendingRequest> = {}): AgentPendingRequest {
  return {
    id: 'c'.repeat(32),
    firstSeen: NOW - 10_000,
    lastSeen: NOW - 5_000,
    ...patch,
  };
}

const allowed = { promptOnRequest: true };

describe('shouldOpenAgentPrompt', () => {
  it('opens for a request the background just announced', () => {
    expect(
      shouldOpenAgentPrompt({
        request: request({ promptedAt: NOW - 1_000 }),
        settings: allowed,
        now: NOW,
        open: false,
        engaged: false,
        deferred: new Set(),
      }),
    ).toBe(true);
  });

  it('does nothing without a request or while the dialog is open', () => {
    expect(
      shouldOpenAgentPrompt({
        request: undefined,
        settings: allowed,
        now: NOW,
        open: false,
        engaged: false,
        deferred: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldOpenAgentPrompt({
        request: request({ promptedAt: NOW - 1_000 }),
        settings: allowed,
        now: NOW,
        open: true,
        engaged: false,
        deferred: new Set(),
      }),
    ).toBe(false);
  });

  it('respects the prompt-on-request switch', () => {
    expect(
      shouldOpenAgentPrompt({
        request: request({ promptedAt: NOW - 1_000 }),
        settings: { promptOnRequest: false },
        now: NOW,
        open: false,
        engaged: true,
        deferred: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldOpenAgentPrompt({
        request: request({ promptedAt: NOW - 1_000 }),
        settings: null,
        now: NOW,
        open: false,
        engaged: true,
        deferred: new Set(),
      }),
    ).toBe(false);
  });

  it('stays quiet for a stale queue the user opened manually', () => {
    expect(
      shouldOpenAgentPrompt({
        request: request({ promptedAt: NOW - PROMPT_FRESH_MS - 1 }),
        settings: allowed,
        now: NOW,
        open: false,
        engaged: false,
        deferred: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldOpenAgentPrompt({
        request: request(),
        settings: allowed,
        now: NOW,
        open: false,
        engaged: false,
        deferred: new Set(),
      }),
    ).toBe(false);
  });

  it('keeps walking the queue once it has interrupted', () => {
    expect(
      shouldOpenAgentPrompt({
        request: request({ promptedAt: NOW - PROMPT_FRESH_MS - 1 }),
        settings: allowed,
        now: NOW,
        open: false,
        engaged: true,
        deferred: new Set(),
      }),
    ).toBe(true);
  });

  it('never re-opens for a request the user pushed aside', () => {
    expect(
      shouldOpenAgentPrompt({
        request: request({ promptedAt: NOW - 1_000 }),
        settings: allowed,
        now: NOW,
        open: false,
        engaged: true,
        deferred: new Set(['c'.repeat(32)]),
      }),
    ).toBe(false);
  });
});
