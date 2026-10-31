import type {
  RuntimeScriptPayload,
  RuntimeStatus,
  ScriptMetadata,
  ScriptRunAt,
  ScriptWorld,
  UserScript,
} from '@/types';
import { getScriptCode, listScripts } from '@/lib/db';
import { storage } from '@/store/storage';
import {
  mergeMetadata,
  parseMetadata,
  getMeta,
  getMetaList,
  hasMeta,
  resolveMetadataUrls,
} from '@/lib/script/metadata';
import { compileUrlRules, toRegistrationPatterns } from '@/lib/script/url-rules';
import { compileLauncher } from '@/lib/script/compile';
import { createRuntimeToken } from '@/lib/background/runtime-token';
import { getRequireCssSources, getRequireSources } from './resources';
import { invalidateBadgeIndex, refreshAllBadges } from './badge';

const RUNNER_ID = 'us-runner';
const HOST_ID = 'us-host';
const RUNNER_FILE = 'user-scripts/runner.js';
const HOST_FILE = 'user-scripts/host.js';

let status: RuntimeStatus = {
  userScriptsAvailable: false,
  scriptsEnabled: true,
  registeredCount: 0,
  engineCount: 0,
  lastCheckedAt: 0,
};

let registrationChain: Promise<RuntimeStatus> = Promise.resolve(status);

export function getRuntimeStatus(): RuntimeStatus {
  return { ...status };
}

export async function checkUserScriptsAvailable(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!chrome.userScripts || typeof chrome.userScripts.getScripts !== 'function') {
      return { ok: false, error: 'chrome.userScripts API is not available.' };
    }
    const scripts = await chrome.userScripts.getScripts();
    if (!Array.isArray(scripts)) {
      return { ok: false, error: 'chrome.userScripts returned an unexpected result.' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'User scripts are disabled. Enable "Allow User Scripts" in chrome://extensions.',
    };
  }
}

function resolveRunAt(metadata: ScriptMetadata, fallback: string): ScriptRunAt {
  const value = getMeta(metadata, 'run-at') ?? fallback;
  const normalized = value.replace(/^document-/, 'document-');
  if (normalized === 'document-start' || normalized === 'document-end') return normalized;
  if (normalized === 'document-body') return 'document-body';
  if (normalized === 'context-menu') return 'context-menu';
  if (normalized === 'early-start') return 'early-start';
  if (normalized === 'document-idle') return 'document-idle';
  return 'document-idle';
}

function registrationRunAt(runAt: ScriptRunAt): 'document_start' | 'document_end' | 'document_idle' {
  switch (runAt) {
    case 'document-start':
    case 'early-start':
      return 'document_start';
    case 'document-end':
    case 'document-body':
      return 'document_end';
    case 'context-menu':
    case 'document-idle':
    default:
      return 'document_idle';
  }
}

function resolveInjectInto(
  metadata: ScriptMetadata,
  script: UserScript,
  fallback: string,
  forceSandbox: boolean,
  grant: string[],
): { injectInto: 'page' | 'content'; world: ScriptWorld } {
  const declared =
    getMeta(metadata, 'inject-into') ??
    (script.injectInto === 'auto' ? fallback : script.injectInto) ??
    fallback;
  const wantsContent = declared === 'content';
  const wantsPage = declared === 'page';
  const hasGrants = grant.length > 0 && !grant.includes('none');
  // unsafeWindow is a page-realm capability. Running such a script in
  // USER_SCRIPT would silently hand it the isolated world's window instead.
  // Page execution wins over forceSandbox/@inject-into content.
  if (grant.includes('unsafeWindow')) return { injectInto: 'page', world: 'MAIN' };
  if (forceSandbox && hasGrants) return { injectInto: 'content', world: 'USER_SCRIPT' };
  if (wantsContent) return { injectInto: 'content', world: 'USER_SCRIPT' };
  if (wantsPage) return { injectInto: 'page', world: 'MAIN' };
  return { injectInto: 'page', world: 'MAIN' };
}

interface PlannedScript {
  payload: RuntimeScriptPayload;
  world: ScriptWorld;
  needsHost: boolean;
  registration: chrome.userScripts.RegisteredUserScript;
}

export async function buildRuntimePayload(uuid: string): Promise<PlannedScript | null> {
  const script = (await listScripts(false)).find((item) => item.uuid === uuid);
  if (!script) return null;
  const settings = await storage.getUISettings();
  return buildPlannedScript(script, settings);
}

async function buildPlannedScript(
  script: UserScript,
  settings: Awaited<ReturnType<typeof storage.getUISettings>>,
): Promise<PlannedScript | null> {
  const code = await getScriptCode(script.uuid);
  if (code === undefined) return null;

  const effective = resolveMetadataUrls(
    mergeMetadata(script.metadata, script.selfMetadata),
    script.origin || script.downloadUrl || script.updateUrl,
  );
  const rules = compileUrlRules(effective);
  const patterns = toRegistrationPatterns(rules);
  let grant = effective.grant?.length ? [...effective.grant] : ['none'];
  const contextMenu = getMeta(effective, 'run-at') === 'context-menu';
  if (contextMenu && grant.includes('none')) {
    grant = ['GM_registerMenuCommand'];
  } else if (contextMenu && !grant.includes('GM_registerMenuCommand')) {
    grant.push('GM_registerMenuCommand');
  }
  const runAt = resolveRunAt(effective, settings.defaultRunAt);
  const resolved = resolveInjectInto(
    effective,
    script,
    settings.defaultInjectInto,
    settings.forceSandbox,
    grant,
  );
  const metaStr = parseMetadata(code).metaStr;
  const requires = await getRequireSources(script.uuid, effective);
  const requireCss = await getRequireCssSources(script.uuid, effective);
  const resourceNames = (effective.resource ?? [])
    .map((value) => value.trim().split(/\s+/, 1)[0])
    .filter((value): value is string => Boolean(value));

  const payload: RuntimeScriptPayload = {
    uuid: script.uuid,
    runtimeToken: await createRuntimeToken(script.uuid, resolved.world),
    name: getMeta(effective, 'name') ?? script.name,
    namespace: getMeta(effective, 'namespace') ?? script.namespace,
    version: getMeta(effective, 'version') ?? script.version,
    description: getMeta(effective, 'description'),
    metaStr,
    meta: effective,
    handlerVersion: chrome.runtime.getManifest().version,
    grant,
    connect: effective.connect ?? [],
    rules,
    code,
    requires,
    requireCss,
    resourceNames,
    runAt,
    injectInto: resolved.injectInto,
    noFrames: hasMeta(effective, 'noframes'),
    unwrap: hasMeta(effective, 'unwrap'),
    contextMenu,
  };

  const registration: chrome.userScripts.RegisteredUserScript = {
    id: `us-${script.uuid}`,
    js: [{ code: compileLauncher(payload, resolved.world) }],
    matches: patterns.matches,
    allFrames: !payload.noFrames,
    runAt: registrationRunAt(runAt),
    world: resolved.world,
  };
  if (patterns.includeGlobs.length) registration.includeGlobs = patterns.includeGlobs;
  if (patterns.excludeMatches.length) registration.excludeMatches = patterns.excludeMatches;
  if (patterns.excludeGlobs.length) registration.excludeGlobs = patterns.excludeGlobs;

  return {
    payload,
    world: resolved.world,
    needsHost: resolved.world === 'USER_SCRIPT',
    registration,
  };
}

function registrationSignature(registration: chrome.userScripts.RegisteredUserScript): string {
  const js = (registration.js ?? []).map((item) =>
    'file' in item && item.file ? `file:${item.file}` : `code:${'code' in item ? item.code : ''}`,
  );
  return JSON.stringify({
    id: registration.id,
    matches: registration.matches ?? [],
    includeGlobs: registration.includeGlobs ?? [],
    excludeMatches: registration.excludeMatches ?? [],
    excludeGlobs: registration.excludeGlobs ?? [],
    allFrames: registration.allFrames ?? false,
    runAt: registration.runAt ?? '',
    world: registration.world ?? '',
    js,
  });
}

function sameRegistrations(
  current: chrome.userScripts.RegisteredUserScript[],
  planned: chrome.userScripts.RegisteredUserScript[],
): boolean {
  if (current.length !== planned.length) return false;
  const currentSet = new Set(current.map(registrationSignature));
  return planned.every((registration) => currentSet.has(registrationSignature(registration)));
}

function buildEngineRegistrations(needsRunner: boolean, needsHost: boolean): chrome.userScripts.RegisteredUserScript[] {
  const engines: chrome.userScripts.RegisteredUserScript[] = [];
  if (needsRunner) {
    engines.push({
      id: RUNNER_ID,
      js: [{ file: RUNNER_FILE }],
      matches: ['<all_urls>'],
      allFrames: true,
      runAt: 'document_start',
      world: 'MAIN',
    });
  }
  if (needsHost) {
    engines.push({
      id: HOST_ID,
      js: [{ file: HOST_FILE }],
      matches: ['<all_urls>'],
      allFrames: true,
      runAt: 'document_start',
      world: 'USER_SCRIPT',
    });
  }
  return engines;
}

async function performRegistration(): Promise<RuntimeStatus> {
  const availability = await checkUserScriptsAvailable();
  const settings = await storage.getUISettings();
  const scripts = await listScripts(false);
  const enabled = scripts.filter((script) => script.enabled && !script.removedAt);

  if (!availability.ok) {
    status = {
      userScriptsAvailable: false,
      scriptsEnabled: settings.scriptsEnabled,
      registeredCount: 0,
      engineCount: 0,
      lastError: availability.error,
      lastCheckedAt: Date.now(),
    };
    return status;
  }

  if (!settings.scriptsEnabled || enabled.length === 0) {
    try {
      await chrome.userScripts.unregister();
    } catch {
      // Already empty / API vanished; the status below is the useful signal.
    }
    status = {
      userScriptsAvailable: true,
      scriptsEnabled: settings.scriptsEnabled,
      registeredCount: 0,
      engineCount: 0,
      lastCheckedAt: Date.now(),
    };
    return status;
  }

  const planned: PlannedScript[] = [];
  for (const script of enabled) {
    const item = await buildPlannedScript(script, settings);
    if (item) planned.push(item);
  }

  const needsRunner = planned.some((item) => item.world === 'MAIN');
  const needsHost = planned.some((item) => item.needsHost);
  const engines = buildEngineRegistrations(needsRunner, needsHost);
  const registrations = [...engines, ...planned.map((item) => item.registration)];

  try {
    // configureWorld is cheap and its settings may not survive an extension
    // reload even when the registered scripts themselves do. Always reapply it
    // before deciding whether the registration list is already current. The
    // sandbox world gets an eval-friendly CSP; messaging is intentionally not
    // enabled because the content-script bridge is the only extension channel.
    if (needsHost) {
      try {
        await chrome.userScripts.configureWorld({
          csp:
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; " +
            "style-src * 'unsafe-inline' data: blob:;",
        });
      } catch {
        try {
          await chrome.userScripts.configureWorld({});
        } catch {
          // Older builds may reject the CSP value; the world still runs with
          // its default CSP.
        }
      }
    }
    let alreadyRegistered = false;
    try {
      alreadyRegistered = sameRegistrations(await chrome.userScripts.getScripts(), registrations);
    } catch {
      // Treat an unreadable registration list as stale.
    }
    if (alreadyRegistered) {
      status = {
        userScriptsAvailable: true,
        scriptsEnabled: true,
        registeredCount: planned.length,
        engineCount: engines.length,
        lastCheckedAt: Date.now(),
      };
      return status;
    }
    try {
      await chrome.userScripts.unregister();
    } catch {
      // Nothing registered yet.
    }
    try {
      await chrome.userScripts.register(registrations);
    } catch (batchError) {
      // A single malformed script must not prevent every other script from
      // running. Register one by one and keep the first failure as the status.
      let firstError: unknown = batchError;
      for (const registration of registrations) {
        try {
          await chrome.userScripts.register([registration]);
        } catch (error) {
          if (firstError === batchError) firstError = error;
        }
      }
      if (firstError !== batchError) {
        // At least one registration succeeded; surface the first failure.
        console.warn('[Lumo Userscripts] A script failed to register:', firstError);
      }
    }
    status = {
      userScriptsAvailable: true,
      scriptsEnabled: true,
      registeredCount: planned.length,
      engineCount: engines.length,
      lastCheckedAt: Date.now(),
    };
  } catch (error) {
    status = {
      userScriptsAvailable: true,
      scriptsEnabled: true,
      registeredCount: 0,
      engineCount: 0,
      lastError: error instanceof Error ? error.message : String(error),
      lastCheckedAt: Date.now(),
    };
  }
  return status;
}

/** Serialize registration changes; concurrent toggles must not race. */
function safelyRegister(): Promise<RuntimeStatus> {
  return performRegistration().catch((error) => {
    status = {
      ...status,
      lastError: error instanceof Error ? error.message : String(error),
      lastCheckedAt: Date.now(),
    };
    return status;
  });
}

export function requestRegistration(): Promise<RuntimeStatus> {
  registrationChain = registrationChain.then(safelyRegister, safelyRegister);
  // The badge counts the reported scripts that are still active, so it has to
  // follow every change that re-registers scripts (toggle, save, install,
  // import, update) — in every tab, not just the front one. Refreshing is
  // fire-and-forget: callers must never wait on toolbar decoration.
  return registrationChain.then((result) => {
    invalidateBadgeIndex();
    void refreshAllBadges();
    return result;
  });
}

export function resetRuntimeStatus(): void {
  status = {
    userScriptsAvailable: false,
    scriptsEnabled: true,
    registeredCount: 0,
    engineCount: 0,
    lastCheckedAt: Date.now(),
  };
}
