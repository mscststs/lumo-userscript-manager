import type { LogEntry, RuntimeMenuCommand, ScriptMetadata, UserScript } from '@/types';
import { getResources, getScript } from '@/lib/db';
import { mergeMetadata } from '@/lib/script/metadata';
import { compileUrlRules, urlMatches } from '@/lib/script/url-rules';
import { resourcesForRuntime } from '@/lib/background/resources';
import { getValuesForScript, setValueForScript, deleteValueForScript } from '@/lib/background/values';
import { recordLog } from '@/lib/background/logs';
import { registerMenuCommand, unregisterMenuCommand } from '@/lib/background/menus';
import { handleGmApi } from '@/lib/background/gm';
import { markScriptRun, broadcast } from '@/lib/background/scripts';
import { verifyRuntimeToken } from '@/lib/background/runtime-token';
import type { HostErrorCode } from '@/lib/runtime/protocol';

export interface HostContext {
  tabId: number;
  frameId: number;
  url: string;
  uuid: string;
}

export class HostError extends Error {
  readonly code: HostErrorCode;

  constructor(message: string, code: HostErrorCode) {
    super(message);
    this.name = 'HostError';
    this.code = code;
  }
}

export function createHostContext(
  sender: chrome.runtime.MessageSender | undefined,
  payload: Record<string, unknown>,
): HostContext {
  const bridgeUrl = String(payload.__pageUrl ?? '');
  return {
    tabId: sender?.tab?.id ?? -1,
    frameId: sender?.frameId ?? 0,
    url: bridgeUrl || sender?.url || sender?.tab?.url || '',
    uuid: String(payload.uuid ?? ''),
  };
}

async function requireActiveScript(uuid: string): Promise<UserScript> {
  if (!uuid) throw new HostError('Missing script id.', 'BAD_REQUEST');
  const script = await getScript(uuid);
  if (!script || !script.enabled || script.removedAt) {
    throw new HostError('Script is not active.', 'SCRIPT_NOT_ACTIVE');
  }
  return script;
}

/**
 * Verify the runtime token before doing any work. The token is scoped to the
 * script UUID and execution world, and combined with `sender.tab/frameId` it
 * prevents a page from invoking another script's GM APIs.
 */
async function requireToken(payload: Record<string, unknown>, uuid: string): Promise<void> {
  const token = String(payload.token ?? '');
  if (!(await verifyRuntimeToken(token, uuid))) {
    throw new HostError('Invalid runtime token.', 'INVALID_TOKEN');
  }
}

export async function handleHostRequest(
  type: string,
  payload: Record<string, unknown>,
  ctx: HostContext,
): Promise<unknown> {
  switch (type) {
    case 'host:ready':
      return undefined;
    case 'host:ping':
      return { time: Date.now() };
    case 'host:bootstrap': {
      const script = await requireActiveScript(ctx.uuid);
      await requireToken(payload, ctx.uuid);

      const effective = mergeMetadata(script.metadata, script.selfMetadata) as ScriptMetadata;
      const url = ctx.url || String(payload.href ?? '');
      if (url && !urlMatches(url, compileUrlRules(effective))) {
        throw new HostError('Script does not match this page.', 'NOT_MATCHED');
      }

      const { values, storageName } = await getValuesForScript(ctx.uuid);
      const resources = resourcesForRuntime(await getResources(ctx.uuid), effective);
      return { storageName, values, resources };
    }
    case 'host:gm': {
      await requireToken(payload, ctx.uuid);
      const api = String(payload.api ?? '');
      if (!api) throw new HostError('Missing GM API name.', 'BAD_REQUEST');
      return handleGmApi(api, (payload.args as unknown[]) ?? [], ctx);
    }
    case 'host:value:set': {
      await requireToken(payload, ctx.uuid);
      await setValueForScript(ctx.uuid, String(payload.key ?? ''), payload.value, {
        originUuid: ctx.uuid,
      });
      return undefined;
    }
    case 'host:value:delete': {
      await requireToken(payload, ctx.uuid);
      await deleteValueForScript(ctx.uuid, String(payload.key ?? ''), {
        originUuid: ctx.uuid,
      });
      return undefined;
    }
    case 'host:run': {
      await requireToken(payload, ctx.uuid);
      await markScriptRun(ctx.uuid, payload.error ? String(payload.error) : undefined);
      return undefined;
    }
    case 'host:log': {
      await requireToken(payload, ctx.uuid);
      await recordLog(
        (String(payload.level ?? 'info') as LogEntry['level']) ?? 'info',
        (payload.args as unknown[]) ?? [],
        ctx.uuid,
        ctx.url,
      );
      return undefined;
    }
    case 'host:menu:register': {
      await requireToken(payload, ctx.uuid);
      await requireActiveScript(ctx.uuid);
      const options = (payload.options ?? {}) as Record<string, unknown>;
      const id =
        String(payload.id ?? '') ||
        `${ctx.uuid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const command: RuntimeMenuCommand = {
        id,
        uuid: ctx.uuid,
        title: String(payload.title ?? ''),
        accessKey: typeof options.accessKey === 'string' ? options.accessKey : undefined,
        tabId: ctx.tabId,
        frameId: ctx.frameId,
      };
      registerMenuCommand(command);
      broadcast('menus-changed', { tabId: ctx.tabId });
      return id;
    }
    case 'host:menu:unregister': {
      await requireToken(payload, ctx.uuid);
      unregisterMenuCommand(ctx.tabId, ctx.frameId, ctx.uuid, String(payload.id ?? ''));
      broadcast('menus-changed', { tabId: ctx.tabId });
      return undefined;
    }
    default:
      throw new HostError(`Unknown host message: ${type}`, 'UNSUPPORTED');
  }
}
