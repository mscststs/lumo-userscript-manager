import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOWED_CLIENTS,
  findAllowedClient,
  isAllowedClient,
  removeAllowedClient,
  upsertAllowedClient,
} from '@/lib/agent/allowlist';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

describe('agent allowlist', () => {
  it('resolves a client by its authoritative ID only', () => {
    const settings = { allowedClients: [{ id: A, name: 'Lumo' }] };
    expect(findAllowedClient(settings, A)).toEqual({ id: A, name: 'Lumo' });
    expect(findAllowedClient(settings, B)).toBeUndefined();
    expect(findAllowedClient(settings, undefined)).toBeUndefined();
    expect(isAllowedClient(settings, A)).toBe(true);
    expect(isAllowedClient(settings, B)).toBe(false);
  });

  it('adds a new client at the front without duplicating an existing one', () => {
    const first = upsertAllowedClient([], { id: A, name: 'Lumo' });
    expect(first).toEqual([{ id: A, name: 'Lumo' }]);

    const second = upsertAllowedClient(first, { id: B, name: 'Other' });
    expect(second.map((client) => client.id)).toEqual([B, A]);

    expect(upsertAllowedClient(second, { id: A }).map((client) => client.id)).toEqual([
      B,
      A,
    ]);
  });

  it('refreshes details without erasing what is already known', () => {
    const clients = [{ id: A, name: 'Lumo', version: '1.0.0' }];
    // A later message that only carries a name must keep the version.
    expect(upsertAllowedClient(clients, { id: A, name: 'Lumo Agent' })).toEqual([
      { id: A, name: 'Lumo Agent', version: '1.0.0' },
    ]);
    // A bare re-add (manual duplicate) keeps both.
    expect(upsertAllowedClient(clients, { id: A })).toEqual(clients);
  });

  it('caps the list so the storage record stays bounded', () => {
    let clients = upsertAllowedClient([], { id: A });
    for (let index = 0; index < MAX_ALLOWED_CLIENTS + 4; index += 1) {
      clients = upsertAllowedClient(clients, {
        id: String.fromCharCode(97 + (index % 16)).repeat(32),
      });
    }
    expect(clients).toHaveLength(MAX_ALLOWED_CLIENTS);
  });

  it('removes exactly one client', () => {
    const clients = [
      { id: A, name: 'Lumo' },
      { id: B, name: 'Other' },
    ];
    expect(removeAllowedClient(clients, A)).toEqual([{ id: B, name: 'Other' }]);
    expect(removeAllowedClient(clients, 'c'.repeat(32))).toEqual(clients);
  });
});
