import type { UserScript } from '@/types';
import { getScript, listScripts, updateScriptPartial } from '@/lib/db';
import { parseMetadata, resolveMetadataUrls } from '@/lib/script/metadata';
import { isNewerVersion } from '@/lib/script/semver';
import { sha256Hex } from '@/lib/script/hash';
import { storage } from '@/store/storage';
import { broadcast, commitInstall, getAllScripts, prepareInstall } from './scripts';
import { requestRegistration } from './registry';

const UPDATE_ALARM = 'lumo:update-check';

function sameSet(a: string[] = [], b: string[] = []): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

function sameScriptPermission(a: UserScript, b: UserScript): boolean {
  return (
    sameSet(a.grant, b.grant) &&
    sameSet(a.connect, b.connect) &&
    sameSet(a.require, b.require) &&
    sameSet(a.resource, b.resource)
  );
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export interface UpdateCheckResult {
  checked: number;
  updated: number;
  available: number;
  errors: string[];
}

export async function checkScriptUpdates(uuid?: string): Promise<UpdateCheckResult> {
  const settings = await storage.getUISettings();
  const scripts = (await getAllScripts(false)).filter(
    (script) => (!uuid || script.uuid === uuid) && script.enabled && script.checkUpdate && (script.downloadUrl || script.updateUrl),
  );
  const result: UpdateCheckResult = { checked: 0, updated: 0, available: 0, errors: [] };

  for (const script of scripts) {
    result.checked += 1;
    await updateScriptPartial(script.uuid, { updateState: 'checking' });
    try {
      const downloadUrl = script.downloadUrl || script.updateUrl!;
      const code = await fetchText(downloadUrl);
      const parsed = parseMetadata(code);
      const version = parsed.metadata.version?.[0] ?? '';
      const hash = await sha256Hex(code);
      if (hash === script.codeHash) {
        await updateScriptPartial(script.uuid, { updateState: 'idle', lastError: undefined });
        continue;
      }
      if (script.version && version && !isNewerVersion(version, script.version)) {
        await updateScriptPartial(script.uuid, { updateState: 'idle', lastError: undefined });
        continue;
      }

      const { token } = await prepareInstall({ code, sourceUrl: downloadUrl });
      const draftParsed = parseMetadata(code);
      const draftMetadata = resolveMetadataUrls(draftParsed.metadata, downloadUrl);
      const candidate: UserScript = {
        ...script,
        version: draftMetadata.version?.[0] ?? script.version,
        grant: draftMetadata.grant ?? ['none'],
        connect: draftMetadata.connect ?? [],
        require: draftMetadata.require ?? [],
        resource: (draftMetadata.resource ?? []).map((value) => value.trim().split(/\s+/, 1)[0]!),
      };

      if (settings.autoUpdate && sameScriptPermission(script, candidate)) {
        await commitInstall(token, { enabled: script.enabled });
        result.updated += 1;
        broadcast('scripts-changed');
      } else {
        await updateScriptPartial(script.uuid, {
          updateState: 'update-available',
          pendingInstallToken: token,
          pendingVersion: candidate.version,
          lastError: undefined,
        });
        result.available += 1;
        broadcast('scripts-changed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${script.name}: ${message}`);
      await updateScriptPartial(script.uuid, { updateState: 'error', lastError: message });
    }
  }

  await requestRegistration();
  broadcast('updates-checked', result as unknown as Record<string, unknown>);
  return result;
}

export async function setupUpdateAlarm(): Promise<void> {
  const settings = await storage.getUISettings();
  await chrome.alarms.clear(UPDATE_ALARM);
  if (settings.autoUpdate) {
    chrome.alarms.create(UPDATE_ALARM, {
      periodInMinutes: Math.max(60, settings.updateIntervalHours * 60),
    });
  }
}

export function isUpdateAlarm(name: string): boolean {
  return name === UPDATE_ALARM;
}

export async function loadAllScripts(): Promise<UserScript[]> {
  return listScripts(false);
}

export async function loadScript(uuid: string): Promise<UserScript | undefined> {
  return getScript(uuid);
}
