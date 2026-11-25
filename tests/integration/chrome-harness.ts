import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Minimal Chrome DevTools Protocol harness for real-extension tests.
 *
 * It is intentionally dependency-free: Chrome is driven through the same
 * WebSocket API Node exposes globally, and the extension is loaded with
 * `Extensions.loadUnpacked` (the supported replacement for the removed
 * `--load-extension` switch).
 */

const OUTPUT_DIR = path.resolve(process.cwd(), '.output/chrome-mv3');
const CHROME_PATH = process.env.CHROME_PATH ?? 'google-chrome';

export function canRunChromeE2E(): boolean {
  return (
    process.env.LUMO_E2E === '1' &&
    chromeAvailable() &&
    existsSync(path.join(OUTPUT_DIR, 'manifest.json'))
  );
}

function chromeAvailable(): boolean {
  if (CHROME_PATH.includes('/')) return existsSync(CHROME_PATH);
  try {
    return spawnSync('which', [CHROME_PATH]).status === 0;
  } catch {
    return false;
  }
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
}

export class Cdp {
  private readonly ws: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly listeners: ((message: CdpMessage) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  static async connect(webSocketUrl: string): Promise<Cdp> {
    const ws = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`Cannot connect to ${webSocketUrl}`)), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onMessage(listener: (message: CdpMessage) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

export interface EchoRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface TargetInfo {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface HarnessOptions {
  /** Called for every console message / exception from the test page. */
  onPageConsole?: (line: string) => void;
}

export class ExtensionHarness {
  private chrome: ChildProcess | null = null;
  private profile = '';
  private port = 0;
  private browser: Cdp | null = null;
  private extensionPage: Cdp | null = null;
  private page: Cdp | null = null;
  private pageTargetId = '';
  private fixture: Server | null = null;
  private stderr = '';

  extId = '';
  pageUrl = '';
  pageConsole: string[] = [];
  /** Requests the fixture served for `/echo`, in arrival order. */
  echoRequests: EchoRequest[] = [];

  constructor(private readonly options: HarnessOptions = {}) {}

  async start(): Promise<void> {
    if (!canRunChromeE2E()) {
      throw new Error('Chrome E2E is disabled (set LUMO_E2E=1 and build the extension first).');
    }

    this.profile = mkdtempSync(path.join(tmpdir(), 'lumo-e2e-'));
    this.port = await freePort();
    this.chrome = spawn(
      CHROME_PATH,
      [
        '--headless=new',
        `--user-data-dir=${this.profile}`,
        '--enable-unsafe-extension-debugging',
        `--remote-debugging-port=${this.port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.chrome.stderr?.on('data', (chunk: unknown) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_000);
    });

    const version = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);
      return response.json();
    }, 15_000);

    this.browser = await Cdp.connect(version.webSocketDebuggerUrl);
    const loaded = await this.browser.send<{ id: string }>('Extensions.loadUnpacked', {
      path: OUTPUT_DIR,
    });
    this.extId = loaded.id;

    await this.enableExtensionPermissions();
    await this.openExtensionPage();

    this.fixture = createServer((request, response) => {
      if (request.url?.startsWith('/echo')) {
        // GM_xmlhttpRequest header repair needs to see the headers Chrome
        // actually put on the wire, including the ones DNR rewrote.
        this.echoRequests.push({ method: request.method ?? '', headers: request.headers });
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.end(JSON.stringify({ method: request.method, headers: request.headers }));
        return;
      }
      if (request.url?.startsWith('/require.js')) {
        response.setHeader('content-type', 'text/javascript; charset=utf-8');
        response.end('window.__lumoRequireLoaded = (window.__lumoRequireLoaded || 0) + 1;');
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><html><head><title>Lumo E2E</title></head><body><h1>fixture</h1></body></html>',
      );
    });
    await new Promise<void>((resolve) => this.fixture!.listen(0, '127.0.0.1', resolve));
    const address = this.fixture.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server has no port.');
    this.pageUrl = `http://127.0.0.1:${address.port}/`;
  }

  private async enableExtensionPermissions(): Promise<void> {
    await this.browser!.send('Target.createTarget', { url: 'chrome://extensions' });
    const info = await waitFor(async () => {
      const targets = await this.targets();
      return targets.find((target) => target.url.startsWith('chrome://extensions'));
    }, 10_000);
    const extensionsPage = await Cdp.connect(info.webSocketDebuggerUrl!);
    await extensionsPage.send('Runtime.enable');
    await evaluate(extensionsPage, 'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})');
    await evaluate(
      extensionsPage,
      `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(this.extId)},userScriptsAccess:true})`,
    );

    // The extension enters DISABLED while developer mode is off; reload it now
    // that the profile and the per-extension user-script toggle are set.
    await this.browser!.send('Extensions.loadUnpacked', { path: OUTPUT_DIR });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const state = await evaluate(
      extensionsPage,
      `chrome.developerPrivate.getExtensionInfo(${JSON.stringify(this.extId)}).then(i=>i.state)`,
    );
    extensionsPage.close();
    if (state !== 'ENABLED') throw new Error(`Extension did not enable (state=${String(state)}).`);
  }

  private async openExtensionPage(): Promise<void> {
    const { targetId } = await this.browser!.send<{ targetId: string }>('Target.createTarget', {
      url: `chrome-extension://${this.extId}/popup.html`,
    });
    const target = await waitFor(async () => {
      const targets = await this.targets();
      return targets.find((item) => item.id === targetId);
    }, 10_000);
    this.extensionPage = await Cdp.connect(target.webSocketDebuggerUrl!);
    await this.extensionPage.send('Runtime.enable');
  }

  async targets(): Promise<TargetInfo[]> {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    return response.json() as Promise<TargetInfo[]>;
  }

  /** Evaluate an expression in an extension page (popup). */
  async extEval<T = unknown>(expression: string): Promise<T> {
    return evaluate<T>(this.extensionPage!, expression);
  }

  /**
   * Load another unpacked extension and return its id.
   *
   * Needed for anything that only happens *between* extensions
   * (`onConnectExternal`, `onMessageExternal`): an extension can never be its
   * own external sender, so a second pinned extension is the only real test.
   */
  async loadExtension(directory: string): Promise<string> {
    const loaded = await this.browser!.send<{ id: string }>('Extensions.loadUnpacked', {
      path: directory,
    });
    return loaded.id;
  }

  /** Open a page belonging to another loaded extension and attach CDP to it. */
  async attachExtensionPage(extensionId: string, page: string): Promise<Cdp> {
    const { targetId } = await this.browser!.send<{ targetId: string }>('Target.createTarget', {
      url: `chrome-extension://${extensionId}/${page}`,
    });
    const target = await waitFor(async () => {
      const targets = await this.targets();
      return targets.find((item) => item.id === targetId);
    }, 10_000);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    await cdp.send('Runtime.enable');
    return cdp;
  }

  /** Console lines and exceptions from the extension's service worker. */
  async watchServiceWorker(): Promise<{ lines: string[]; close: () => void }> {
    const target = await waitFor(async () => {
      const targets = await this.targets();
      return targets.find(
        (item) => item.type === 'service_worker' && item.url.includes(this.extId),
      );
    }, 10_000);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    const lines: string[] = [];
    cdp.onMessage((message) => {
      if (message.method === 'Runtime.consoleAPICalled') {
        lines.push(
          `${message.params.type}: ${message.params.args
            .map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description)
            .join(' ')}`,
        );
      }
      if (message.method === 'Runtime.exceptionThrown') {
        lines.push(`exception: ${message.params.exceptionDetails.text}`);
      }
      if (message.method === 'Log.entryAdded') {
        lines.push(`log: ${message.params.entry.level} ${message.params.entry.text}`);
      }
    });
    return { lines, close: () => cdp.close() };
  }

  async installScript(code: string): Promise<string> {
    return this.extEval<string>(`(async()=>{
      const response = await chrome.runtime.sendMessage({type:'scripts:save',payload:{code:${JSON.stringify(code)}}});
      if (!response.ok) throw new Error(response.error);
      return response.result.uuid;
    })()`);
  }

  async refresh(): Promise<void> {
    await this.extEval(`chrome.runtime.sendMessage({type:'runtime:refresh'})`);
  }

  async purgeScript(uuid: string): Promise<void> {
    await this.extEval(
      `chrome.runtime.sendMessage({type:'scripts:purge',payload:{uuid:${JSON.stringify(uuid)}}})`,
    );
  }

  async setScriptsEnabled(enabled: boolean): Promise<void> {
    await this.extEval(`(async()=>{
      const stored = await chrome.storage.local.get('uiSettings');
      await chrome.storage.local.set({
        uiSettings: { ...(stored.uiSettings ?? {}), scriptsEnabled: ${enabled} },
      });
    })()`);
  }

  async registeredScriptIds(): Promise<string[]> {
    return this.extEval<string[]>(
      `chrome.userScripts.getScripts().then((scripts)=>scripts.map((script)=>script.id))`,
    );
  }

  async values(uuid: string): Promise<Record<string, unknown>> {
    const response = await this.extEval<{ ok: boolean; result: { values: Record<string, unknown> } }>(
      `chrome.runtime.sendMessage({type:'values:list',payload:{uuid:${JSON.stringify(uuid)}}})`,
    );
    return response.result.values;
  }

  async setValue(uuid: string, key: string, value: unknown): Promise<void> {
    await this.extEval(
      `chrome.runtime.sendMessage({type:'values:set',payload:{uuid:${JSON.stringify(uuid)},key:${JSON.stringify(key)},value:${JSON.stringify(value)}}})`,
    );
  }

  async menuCommands(tabId: number): Promise<any[]> {
    const response = await this.extEval<{ ok: boolean; result: any[] }>(
      `chrome.runtime.sendMessage({type:'menus:list',payload:{tabId:${tabId}}})`,
    );
    return response.result;
  }

  async invokeMenu(tabId: number, uuid: string, id: string): Promise<void> {
    await this.extEval(
      `chrome.runtime.sendMessage({type:'menus:invoke',payload:{tabId:${tabId},frameId:0,uuid:${JSON.stringify(uuid)},id:${JSON.stringify(id)}}})`,
    );
  }

  /** Wait until the fixture saw `count` `/echo` requests. */
  async waitForEcho(count: number, timeoutMs = 20_000): Promise<EchoRequest[]> {
    await waitFor(async () => (this.echoRequests.length >= count ? this.echoRequests : false), timeoutMs);
    return this.echoRequests;
  }

  async openPage(): Promise<void> {
    // Navigate through the extension's own tabs API. The CDP `Page.navigate`
    // path can stall in current headless Chrome when an unpacked extension with
    // a document_start content script is loaded, even though the page itself
    // loads normally.
    await this.extEval(`chrome.tabs.create({url: ${JSON.stringify(this.pageUrl)}})`);
    const target = await waitFor(async () => {
      const targets = await this.targets();
      return targets.find((item) => item.url.startsWith(this.pageUrl));
    }, 10_000);
    this.pageTargetId = target.id;
    this.page = await Cdp.connect(target.webSocketDebuggerUrl!);
    await this.page.send('Runtime.enable');
    await this.page.send('Page.enable');
    await this.page.send('Log.enable');

    const report = (line: string) => {
      this.pageConsole.push(line);
      this.options.onPageConsole?.(line);
    };
    this.page.onMessage((message) => {
      if (message.method === 'Runtime.consoleAPICalled') {
        report(
          `console.${message.params.type}: ${message.params.args
            .map((arg: any) => arg.value ?? arg.description)
            .join(' ')}`,
        );
      } else if (message.method === 'Runtime.exceptionThrown') {
        report(
          `exception: ${
            message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text
          }`,
        );
      }
    });

    await this.waitForPage(`document.readyState === 'complete'`, 15_000);
  }

  async pageEval<T = unknown>(expression: string): Promise<T> {
    return evaluate<T>(this.page!, expression);
  }

  async reloadPage(): Promise<void> {
    await this.page!.send('Page.reload', { ignoreCache: true });
    await this.waitForPage(`document.readyState === 'complete'`, 15_000);
  }

  async waitForPage<T = unknown>(expression: string, timeoutMs = 10_000): Promise<T> {
    return waitFor(() => this.pageEval<T>(expression), timeoutMs);
  }

  async tabId(): Promise<number> {
    const tabs = await this.extEval<{ id?: number }[]>(
      `chrome.tabs.query({url:${JSON.stringify(`${this.pageUrl}*`)}}).then((tabs)=>tabs.map((tab)=>({id:tab.id})))`,
    );
    const id = tabs[0]?.id;
    if (id === undefined) throw new Error('Test tab not found.');
    return id;
  }

  /** Terminate the MV3 worker without closing the tab. */
  async stopServiceWorker(): Promise<boolean> {
    const target = (await this.targets()).find(
      (item) => item.type === 'service_worker' && item.url.includes(this.extId),
    );
    if (!target) return false;
    const result = await this.browser!.send<{ success: boolean }>('Target.closeTarget', {
      targetId: target.id,
    });
    return result.success;
  }

  async close(): Promise<void> {
    this.page?.close();
    this.extensionPage?.close();
    this.browser?.close();
    if (this.chrome) {
      this.chrome.kill('SIGKILL');
      this.chrome = null;
    }
    if (this.fixture) {
      await new Promise<void>((resolve) => this.fixture!.close(() => resolve()));
      this.fixture = null;
    }
    if (this.profile) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
      } catch {
        // Best effort; a straggling renderer may still hold a file.
      }
    }
    if (this.stderr) {
      // Keep the last few lines for a failing assertion message.
      this.pageConsole.push(`chrome-stderr: ${this.stderr.split('\n').slice(-5).join(' | ')}`);
    }
  }
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const result = await cdp.send<{
    result: { value?: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  return result.result.value as T;
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for condition.');
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
