# Lumo Userscript Manager 设计方案

> 目标：在现有 `lumo-userscript-manager` 脚手架（WXT + React 19 + Tailwind 4 + shadcn/ui + CodeMirror 6 + Zustand + i18n）上，构建一个 Chrome MV3 原生、兼容主流用户脚本、可长期维护的用户脚本管理器。
>
> 参考实现：
> - Greasemonkey：`~/repo/github/greasemonkey`
> - Violentmonkey：`~/repo/github/violentmonkey`
> - ScriptCat：`~/repo/github/scriptcat`
>
> 本文只讨论 Chrome MV3；Firefox 的 MV2 `webRequestBlocking`、`contentScripts` 路径不作为设计前提。

---

## 实现状态（当前）

已落地的核心闭环：

- `chrome.userScripts` 每脚本注册、MAIN/USER_SCRIPT 双运行时、固定 runner/host 引擎
- `@match/@include/@exclude/@exclude-match` 编译与运行时二次校验
- metadata 解析、URL 规则、launcher 编译、`@require`/`@resource` 抓取
- MAIN / USER_SCRIPT ↔ ISOLATED content bridge、GM API 作用域隔离、值变更广播
- 常用 GM API：值、XHR、Cookie、下载、通知、菜单、样式、元素、剪贴板、Tab 状态
- 安装页、DNR `.user.js` 重定向、metadata/权限/代码预览
- Popup 当前页脚本控制、Options 脚本列表/编辑器/设置/日志/关于
- IndexedDB 数据层、回收站、JSON/ZIP 备份、更新检查与权限感知自动更新
- Chrome 138+、`cookies`/`downloads` 默认权限（按已确认决策）

仍有边界（见 README “Known limitations”）：网络规则编辑、跨设备同步、编辑器多标签等。`unsafeWindow` 已可用：`@grant unsafeWindow` 优先 MAIN 世界，USER_SCRIPT 脚本保留隔离世界 `window`。

---

## 0. 结论先行

### 0.1 推荐架构

采用 **“双世界运行时 + 每脚本声明式注册”**：

1. **Service Worker（SW）**
   - 唯一的数据与权限中心：脚本索引、代码、值存储、安装草稿、更新、资源缓存。
   - 负责把脚本编译成 `chrome.userScripts.RegisteredUserScript`，并维护注册表。
   - 负责所有需要扩展特权的 GM API：跨域请求、Cookie、下载、通知、标签页、剪贴板。

2. **MAIN 世界 Runner（页面世界）**
   - 通过 `chrome.userScripts` 注册到 `world: 'MAIN'`，`document_start`，按脚本的 URL 规则匹配。
   - 在页面 realm 中执行脚本，保证 `window`、页面全局变量、jQuery 等页面对象可直接访问。
   - 提供 `GM_*` 代理对象，但只存在于脚本的 `with` 作用域内，不挂到 `window`，避免页面任意代码直接调用 GM API。
   - 通过惰性的 `MessageChannel` 直接连接 ISOLATED content bridge；不再经过 USER_SCRIPT Host。

3. **USER_SCRIPT Host（沙箱宿主）**
   - 通过 `chrome.userScripts` 注册到 `world: 'USER_SCRIPT'`，`document_start`。
   - **不使用** `chrome.runtime`：Chromium（包括 Chrome 156）在部分版本中即使配置了 `configureWorld({ messaging: true })`，USER_SCRIPT world 的 `runtime.sendMessage/connect` 仍可能返回 `Receiving end does not exist`。
   - 实现 GM API 的本地部分：值快照、菜单命令、资源、样式、元素、日志；与 MAIN Runner 共用同一套 engine 和 BridgeClient。
   - 只在实际执行 `@inject-into content` / 强制沙箱脚本时注册，页面无法看到 GM 对象。

4. **ISOLATED Content Bridge**
   - 通过普通 `content_scripts` 注入，`document_start`、`all_frames`。
   - 唯一持有 `chrome.runtime` 的运行时组件：RPC 走 `sendMessage`，事件走一条懒连接、可重连的 `connect` 端口。
   - 接收 MAIN / USER_SCRIPT 引擎的 `MessageChannel` 握手，校验 nonce，只转发白名单 `host:*` 请求。

5. **每个脚本一个注册项**
   - `id = us-<uuid>`
   - `matches/includeGlobs/excludeMatches/excludeGlobs` 由脚本 metadata 编译。
   - `runAt`、`allFrames`、`world` 由 metadata 与设置决定。
   - `js: [{ code: wrap(script) }]`，代码是「启动器 + 脚本体」，体积可控。
   - 引擎（Runner/Host）作为固定注册项，按需存在，注册顺序在前；脚本启动器对引擎未就绪做队列兜底。

> 这套结构接近 ScriptCat 的 `chrome.userScripts.register` 每脚本注册 + MAIN/USER_SCRIPT 双运行时，也吸收了 Violentmonkey 的「页面桥 + 值快照 + safe global wrapper」；区别是我们把页面桥的扩展上下文一侧收敛到唯一的 ISOLATED content bridge。Greasemonkey 的 MV2 `tabs.executeScript(code)` 方式在 MV3 不可用，但其 metadata 解析和 grant 生成 API 的思路仍可借鉴。

### 0.2 为什么不直接照搬 Greasemonkey

Greasemonkey 是 Firefox MV2：

- `background` 常驻，`chrome.tabs.executeScript({ code })` 直接执行字符串。
- MV3 移除了 `tabs.executeScript` 和 `webRequestBlocking`（普通扩展）。
- `chrome.scripting.executeScript` 只接受函数/文件，不接受任意代码字符串。
- MV3 动态用户脚本的正确入口是 `chrome.userScripts`。

因此 Greasemonkey 只能作为 **metadata 语义、GM API 形状、值存储** 的参考，不能作为注入架构参考。

### 0.3 为什么不是“全部脚本都放 USER_SCRIPT 沙箱”

沙箱更安全，但兼容性差：

- 大量脚本依赖页面全局对象、页面框架、`unsafeWindow`。
- 沙箱里的 `window` 是隔离 world，不是页面 JS realm。
- 主流管理器（Tampermonkey、VM、ScriptCat）默认都尽量让脚本接近页面世界。

所以默认策略：

- `@grant none` → MAIN world，无 GM API。
- 有 `@grant` → MAIN world + GM 代理桥（默认），或按 `@inject-into content` 进入 USER_SCRIPT 沙箱。
- 高风险脚本/用户选择 → 强制 `content` 沙箱。

---

## 1. 三份参考实现的核心逻辑提取

### 1.1 Greasemonkey（MV2，Firefox）

| 关注点 | 实现 |
|---|---|
| 注入时机 | `src/bg/execute.run.js` 监听 `chrome.webNavigation.onCommitted`，然后 `src/bg/execute.js` 对每个匹配脚本调用 `chrome.tabs.executeScript` |
| 执行代码 | `src/user-script-obj.js` 的 `calculateEvalContent()` 生成完整字符串：`(function scopeWrapper(){ function userScript(){ ...code... } const unsafeWindow = window.wrappedJSObject; ...GM info... ...API provider... ...@require... userScript(); })()` |
| GM API | `src/bg/api-provider-source.js` 按 `@grant` 拼接函数源码；每个 API 通过 `chrome.runtime.sendMessage` / `connect` 回后台 |
| 值存储 | `src/bg/value-store.js`：每个脚本一个 IndexedDB 数据库 `user-script-<uuid>`，object store `values` |
| URL 匹配 | `MatchPattern` + `convert2RegExp`；`@include/@exclude` 转正则，`@match` 用 MatchPattern |
| 安装检测 | `src/bg/user-script-detect.js`：`webRequest.onHeadersReceived` 检查 Content-Type，命中 `.user.js` 时打开安装弹窗 |
| 安装流程 | `src/content/install-dialog.js` + downloader，下载脚本、`@require`、`@resource`，展示信息，用户确认后写入 registry |
| 编辑 | `src/content/edit-user-script.html/js`，CodeMirror + metadata lint |
| 结论 | 架构简单但绑定 MV2；不能直接用于 MV3。可复用 metadata 语义、GM API 行为、安装确认 UX。 |

### 1.2 Violentmonkey（MV2 + MV3）

| 关注点 | 实现 |
|---|---|
| MV3 注入 | `src/common/browser-scripts-api.js`：MV3 用 `chrome.userScripts.execute/register/configureWorld`；MV2 用 `browser.tabs.executeScript` |
| 固定引擎 | `src/manifest.yml` 的 `content_scripts` 在 MV2 注入 `injected-web.js` + `injected.js`；MV3 在 `registerInjector()` 中注册 `injected-web.js`（MAIN）和 `injected.js`（USER_SCRIPT），`document_start`、`all_frames` |
| 预注入数据 | `src/background/utils/preinject-core.js`：`onSendHeaders` 准备 `prepare()`，`registerScriptDataMV3()` 用 `chrome.userScripts.register` 注册一个只匹配当前 URL 的数据脚本，把 `VMInjection` 负载写入页面 |
| 代码生成 | `src/background/utils/preinject-prepare.js`：把脚本体包成 `function dataKey(GM, dataKey){ with(this) with(c) delete c, (define,module,exports)=>{ ...code... })() }`，并用 `window[winKey]` setter 在正确时机执行 |
| 页面执行 | `src/injected/content/inject.js`：创建 `<script>` / iframe 注入页面；`src/injected/web/index.js` 接收 `ScriptData`，通过 `onCodeSet` 调用 `makeGmApiWrapper`，执行脚本 |
| GM API | `src/injected/web/gm-api.js` + `gm-api-wrapper.js`：GM API 在页面 world 的闭包 `gm` 对象里；`makeGlobalWrapper` 用 Proxy 模拟页面全局对象；GM4 别名同时支持 `GM_*` 与 `GM.*` |
| 值存储 | 后台 `src/background/utils/values.js` + 注入侧 `gm-values.js`；页面拿到值快照，`GM_setValue` 通过 bridge 回写 |
| 页面桥 | `src/injected/web/bridge.js` + `src/injected/content/bridge.js`，CustomEvent + 随机 id，Firefox 用 vault/handshake 防页面伪造 |
| 安装 | `src/background/utils/tab-redirector.js`：MV3 用 DNR 改 `Content-Type`（Chrome < 152）或 `tabs.onUpdated` 捕获 `.user.js`，再打开 `confirm` 页面；`src/confirm/views/app.vue` 展示依赖、权限、代码并确认 |
| 编辑器 | Vue + CodeMirror（`src/common/ui/code.vue`），options 内嵌编辑视图 |
| 结论 | MV3 兼容性最好的一手参考；核心是“固定引擎 + 预注入负载 + 页面桥 + 值快照”。复杂度主要来自页面桥安全和 Firefox 兼容，我们只保留 Chrome 需要的部分。 |

### 1.3 ScriptCat（MV3）

| 关注点 | 实现 |
|---|---|
| MV3 注册 | `src/app/service/service_worker/runtime.ts`：`registerUserscripts()` 批量注册所有启用脚本；`getParticularScriptList()` 为每个脚本生成 `chrome.userScripts.RegisteredUserScript`；同时用 `chrome.scripting.registerContentScripts` 注册 `scriptcat-scripting` |
| 固定引擎 | `src/app/service/service_worker/runtime.ts` 的 `getContentAndInjectScript()`：`scriptcat-inject` 注册到 `world: 'MAIN'`，`scriptcat-content` 注册到 `world: 'USER_SCRIPT'`，均 `document_start`、`all_frames`、`<all_urls>` |
| 每脚本注册 | `src/app/service/service_worker/utils.ts` 的 `getUserScriptRegister()`：`id`、`matches`、`includeGlobs`、`excludeMatches`、`excludeGlobs`、`allFrames`、`world`、`runAt` |
| 代码包装 | `src/app/service/content/utils.ts`：`compileScriptCode()` 生成 `with(arguments[0]||this.$){ ... return (async function(){ code }).call(this) }`；`compileInjectScriptByFlag()` 生成 `window[flag] = function(){ code }` |
| 执行器 | `src/app/service/content/exec_script.ts`：`new Function(code)` 编译；`createContext()` 按 `@grant` 收集 API；`createProxyContext()` 生成 `this.$`；`scriptFunc.call(ctx, named, name)` |
| GM API | `src/app/service/content/gm_api/gm_api.ts` 用 `@GMContext.API()` 装饰器注册；`GM_getValue` 同步读快照，`GM.getValue` 异步；`grant.ts` 同时生成 `GM_*` 与 `GM.*` 候选 |
| 消息 | `@Packages/message`（CustomEventMessage / ExtensionMessage 等）在 page/content/SW 间传递；`configureWorld({ messaging: true })` 让 USER_SCRIPT world 可访问 runtime |
| 值存储 | `src/app/repo/value.ts` + `ValueService`；`GM_setValue` 同步更新本地快照并异步持久化；`valueUpdate` 广播到 content |
| URL 匹配 | `src/pkg/utils/url_matcher.ts`：`extractUrlPatterns()` 把 `@match/@include/@exclude/@exclude-match` 解析成 `MATCH/GLOB/REGEX` 规则；`getApiMatchesAndGlobs()` 转成 Chrome API 的 `matches/includeGlobs/excludeMatches/excludeGlobs`；无法表达的规则在运行时用 `scriptUrlPatterns` 再检查 |
| 安装 | `src/app/service/service_worker/script.ts`：DNR 规则把 `*.user.js` 重定向到 `install.html?url=...`；`webNavigation.onBeforeNavigate` 兼容 file:// 和文档页；`getInstallPageUrl()`/`openUpdateOrInstallPage()` 暂存草稿；`src/pages/install/App.tsx` 展示身份、权限、代码、更新 diff |
| 编辑器 | `src/pages/options/routes/ScriptEditor/*`：Monaco、多标签、Code/Settings/Storage/Resource 子视图、保存冲突检测、未保存离开拦截 |
| 结论 | 与我们的目标架构最接近；它的“每脚本注册 + URL 规则编译 + 双运行时 + 安装页暂存”可以直接作为蓝本。我们可以把它较重的 AI/Agent、订阅、云端部分裁掉，换成 Lumo 的 UI 与数据层。 |

---

## 2. Chrome MV3 注入方案

### 2.1 可用 API 与限制

| API | 能力 | 限制 |
|---|---|---|
| `chrome.userScripts.register` | 动态注册用户脚本；支持 `world: MAIN / USER_SCRIPT`、`matches`、`includeGlobs`、`excludeMatches`、`excludeGlobs`、`allFrames`、`runAt` | 需要 `userScripts` 权限；用户可能需要在 `chrome://extensions` 打开 “Allow User Scripts”（Chrome 138+）或开发者模式（更早版本）；`runAt` 只有 `document_start/end/idle` |
| `chrome.userScripts.configureWorld` | 配置 USER_SCRIPT world 的 CSP（可选 `messaging`） | 本实现不依赖 `messaging: true`；USER_SCRIPT world 的 runtime 消息在部分 Chromium 版本不可靠，统一走 content bridge |
| `chrome.userScripts.execute` | 在指定 tab/frame 执行代码 | 版本较新，且不能替代 `document_start` 注册；只作为“在当前页立即运行/调试”的补充 |
| `chrome.scripting.registerContentScripts` | 注册普通 content script（ISOLATED/MAIN） | 只能注册文件，不能注册动态代码；适合固定 host/诊断脚本，不适合每脚本代码 |
| `chrome.declarativeNetRequest` | 安装 URL 重定向、请求头/响应头修改 | MV3 没有 `webRequestBlocking`；DNR 的 `responseHeaders` 条件需要较新 Chrome；规则数量/优先级有限 |
| `chrome.tabs.sendMessage` | 给 content script 发消息 | 对 `userScripts` world 的投递行为不如端口稳定；跨 world 事件建议用 `runtime.connect` 端口 |

### 2.2 注册模型

```ts
type RegisteredScript = chrome.userScripts.RegisteredUserScript;

interface RegistrationPlan {
  engines: RegisteredScript[];   // runner / host
  scripts: RegisteredScript[];   // 每个用户脚本
}

interface ScriptRegistrationMeta {
  uuid: string;
  world: 'MAIN' | 'USER_SCRIPT';
  runAt: 'document_start' | 'document_end' | 'document_idle';
  allFrames: boolean;
  matches: string[];
  includeGlobs?: string[];
  excludeMatches?: string[];
  excludeGlobs?: string[];
  needsRuntimeCheck: boolean;
  rules: CompiledUrlRule[];      // 用于运行时精确校验
}
```

固定引擎：

```ts
const RUNNER: RegisteredScript = {
  id: 'us:runner',
  js: [{ file: 'user-scripts/runner.js' }],
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',
};

const HOST: RegisteredScript = {
  id: 'us:host',
  js: [{ file: 'user-scripts/host.js' }],
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  world: 'USER_SCRIPT',
};
```

每个脚本：

```ts
const entry: RegisteredScript = {
  id: `us:${script.uuid}`,
  js: [{ code: compileLauncher(script) }],
  matches: plan.matches,
  includeGlobs: plan.includeGlobs,
  excludeMatches: plan.excludeMatches,
  excludeGlobs: plan.excludeGlobs,
  allFrames: !script.noFrames,
  runAt: plan.runAt,
  world: plan.world,
};
```

> 引擎只在存在对应 world 的脚本时注册：
> - 有 grant 脚本 → `RUNNER`；`@inject-into content` / 强制沙箱 → `HOST`
> - 只有 `@grant none` 且 `@inject-into content` 不需要 → 不注册引擎
> - 只有 `@inject-into content` 的脚本 → 只注册 `HOST`
> 这样可以避免在无关页面注入引擎。

### 2.3 脚本启动器（Launcher）

Runner 侧：

```js
// compileLauncher(script) 产物，由 chrome.userScripts 在 MAIN world 执行
(function () {
  var payload = {
    uuid: "...",
    runToken: "...",          // 每次注册生成的随机 token
    meta: { /* 精简 metadata */ },
    rules: [ /* 编译后的 URL 规则 */ ],
    grant: ["GM_setValue", "GM_xmlhttpRequest"],
    code: "...",              // 原始脚本体
    requires: [{ url, code }],// 已缓存的 @require
    resourceNames: ["logo"],
    injectInto: "page",
    runAt: "document_start",
    noFrames: false
  };
  if (!globalThis.__LUMO_RUNNER__) {
    (globalThis.__LUMO_RUNNER_QUEUE__ || (globalThis.__LUMO_RUNNER_QUEUE__ = [])).push(payload);
    return;
  }
  globalThis.__LUMO_RUNNER__.run(payload);
})();
```

Host 侧 `@inject-into content` 的启动器同理，调用 `globalThis.__LUMO_HOST__.run(payload)`。

设计要点：

- **不在启动器里放大段引擎代码**：避免每个脚本重复 ~50KB 运行时。
- **启动器内含 URL 规则**：因为 `userScripts` 的 `matches/includeGlobs` 无法表达所有 `@include` 正则、Magic TLD、复杂 glob；启动器在真正执行前再精确校验一次。
- **`runToken`**：Host 只接受带合法 token 的 GM 请求，降低页面伪造桥消息的风险。
- **`code` 是字符串**：`chrome.userScripts.register` 支持 `js: [{ code }]`；这也是 MV3 下注入动态脚本的唯一稳定方式。

### 2.4 运行时顺序与兜底

`chrome.userScripts` 的执行顺序按注册/更新时间，但不建议把正确性建立在顺序上：

1. 先注册 `RUNNER`/`HOST`（一次注册，长期存在）。
2. 再注册脚本。若引擎尚未执行，启动器把 payload 推入全局队列。
3. 引擎执行时：
   - `RUNNER`：设置 `globalThis.__LUMO_RUNNER__`，并 drain `__LUMO_RUNNER_QUEUE__`。
   - `HOST`：设置 `globalThis.__LUMO_HOST__`，并 drain `__LUMO_HOST_QUEUE__`。
4. 引擎与启动器之间不需要互相等待；队列保证不丢脚本。

### 2.5 world 选择策略

| metadata / 设置 | world | 说明 |
|---|---|---|
| `@grant none`，`@inject-into auto/page` | `MAIN` | 页面 realm，无 GM API；最兼容 |
| 有 `@grant`，`@inject-into auto/page` | `MAIN` | 页面 realm + GM 代理桥；默认，兼容性最好 |
| `@inject-into content` | `USER_SCRIPT` | 沙箱；页面无法看到 GM 对象；适合高风险脚本 |
| `@grant none` + `@inject-into content` | `USER_SCRIPT` | 隔离但不提供 GM API（除非脚本声明 grant） |
| 用户设置为“强制沙箱” | `USER_SCRIPT` | 全局安全偏好 |
| `@inject-into page` + 用户禁止页面桥 | `MAIN` 但无 GM API | 明确告警，避免静默丢 API |

默认 `auto` 选择 MAIN，是为了兼容现有生态；安全偏好放在设置里，而不是默认牺牲兼容性。

### 2.6 `@run-at` 映射

| metadata | 注册 `runAt` | 运行时处理 |
|---|---|---|
| `document-start` | `document_start` | 直接执行 |
| `document-body` | `document_end` | Chrome 没有 body-ready 事件，`document_end` 是最接近的时机 |
| `document-end` / 缺省 | `document_end` | 直接执行 |
| `document-idle` | `document_idle` | 直接执行 |
| `context-menu` | `document_idle` | 不自动执行；包装成 `GM_registerMenuCommand(name, () => code)`，由 popup/菜单触发 |
| `early-start` | `document_start` | MVP 等价 `document-start`，设置中标注“实验性” |

> 缺省值建议 `document-idle`（ScriptCat 默认），比 `document-end` 更安全；如果希望更贴近 Tampermonkey，可改为 `document-end`。这是需要确认的产品决策。

### 2.7 运行时传输协议

MAIN / USER_SCRIPT 引擎都不直接访问 `chrome.runtime`，而是通过 ISOLATED
content bridge 转发。这样跨 world 通信只剩一条可测试的链路：

```
Engine (MAIN / USER_SCRIPT)
  └─ BridgeClient
       hello(nonce, clientId, kind) + MessagePort
       ◀── ready(nonce, bridgeId)
       ──▶ rpc / result / event / resume
            │
Content Bridge (ISOLATED)
  ├─ chrome.runtime.sendMessage(type, payload)  # 一次性 RPC
  └─ chrome.runtime.connect({name:'lumo:bridge'}) # 事件通道，懒连接
            │
Background Host Service (SW)
  ├─ runtime token 校验（HMAC，绑定 uuid + world）
  ├─ sender.tab / sender.frameId 作为唯一可信上下文
  └─ gm / values / menus / logs / run
```

消息契约（`lib/runtime/protocol.ts`）：

```ts
type BridgeMessage =
  | { __lumo: 'lumo:bridge-hello'; nonce: string; clientId: string; kind: 'main' | 'userscript' }
  | { __lumo: 'lumo:bridge-ready'; nonce: string; bridgeId: string }
  | { __lumo: 'lumo:bridge-rpc'; id: string; type: string; payload: Record<string, unknown> }
  | { __lumo: 'lumo:bridge-result'; id: string; result?: unknown; error?: string; code?: string }
  | { __lumo: 'lumo:bridge-event'; event: RuntimeEventName; payload: Record<string, unknown> }
  | { __lumo: 'lumo:bridge-resume' };
```

设计要求：

- **懒握手**：引擎只在 `run(payload)` 时发起握手；没有匹配脚本的页面不建立
  port、不唤醒 SW。
- **nonce 校验**：`ready` 通过引擎自己的 MessagePort 返回，且必须回显本次
  `hello` 的 nonce；页面无法用旧握手劫持新客户端。
- **RPC 与事件分离**：RPC 永远走 `sendMessage`，事件端口断开不会阻塞
  bootstrap / GM 调用；事件端口按指数退避重连。
- **token 校验**：`buildPlannedScript()` 为每个 `(uuid, world)` 生成
  `HMAC(installSecret, uuid:world)`，随 payload 注入。所有 `host:*` 请求必须
  携带该 token；Background 用 `sender.tab/frameId` 构造上下文，不信任
  `payload.uuid` 以外的页面字段。
- **事件恢复**：事件端口重连后发送 `bridge-resume`，引擎重放菜单注册；
  值监听器是本地状态，无需重放。
- **值变更语义**：Background 广播 `{uuid, originUuid, storageName, key,
  oldValue, newValue, remote}`。origin 引擎跳过（它已在 `GM_setValue` 时同步
  触发 `remote=false`），其他脚本 / frame / tab 收到 `remote=true`。
- **页面导航**：content bridge 在每个 RPC 中附带当前 `location.href`，避免
  SPA 软导航后 `sender.url` 过期。

> 页面仍然可以在 `window` 上监听 `message` 事件。对 MAIN 脚本，token 本来
> 就与脚本同处页面 realm；对 USER_SCRIPT 脚本，token 不离开隔离 world。
> 两种情况下 Background 都只按 token 授权的 uuid 提供 GM 能力。

### 2.8 健康检查与重注册

```ts
async function ensureRegistered() {
  const desired = buildRegistrationPlan(await loadEnabledScripts());
  const actual = await chrome.userScripts.getScripts();
  // 1. 删除不再需要的
  // 2. update 已存在且 id 相同的
  // 3. register 缺失的
  // 4. 失败则 unregister 全部后按 desired 顺序重新 register
}
```

触发时机：

- `chrome.runtime.onInstalled` / `onStartup`
- 脚本增删改、启用/禁用、metadata 覆盖变更
- 设置中切换“强制沙箱”/全局开关
- `chrome.alarms` 定期健康检查（例如每 30 分钟）
- 用户手动“修复注入”按钮

注册失败优先降级为单条注册（ScriptCat 的做法），并记录 `runtime.lastError`，在 popup/options 中展示可读错误。

---

## 3. 脚本模型与 metadata

### 3.1 数据模型

```ts
interface UserScript {
  uuid: string;                 // 稳定主键
  name: string;
  namespace: string;
  version: string;              // 允许空
  description?: string;
  author?: string;
  homepage?: string;
  icon?: string;                // URL / data URL / 缓存 key

  enabled: boolean;
  removedAt?: number;           // 回收站
  sort: number;

  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  runCount: number;

  origin: string;               // 安装来源 URL（可为空）
  downloadUrl?: string;
  updateUrl?: string;
  checkUpdate: boolean;
  updateIntervalHours?: number;

  metadata: ScriptMetadata;      // 原始 metablock
  selfMetadata?: ScriptMetadata; // 用户覆盖（match/include/exclude/run-at/...）
  effectiveMetadata: ScriptMetadata; // 运行时合并结果（可计算，不必持久化）

  codeHash: string;
  codeSize: number;

  tags: string[];
  grant: string[];
  connect: string[];
  require: ScriptResourceRef[];
  resource: ScriptResourceRef[];

  runAt: ScriptRunAt;
  noFrames: boolean;
  injectInto: 'auto' | 'page' | 'content';
  unwrap: boolean;
  topLevelAwait: boolean;

  updateState: 'idle' | 'checking' | 'update-available' | 'error';
  lastError?: string;
}
```

分开存储：

- `scripts`：元数据与索引字段（可放 IndexedDB）。
- `scriptCode`：`uuid -> code`。
- `scriptVersions`：每次安装/更新/编辑的快照（用于回滚与 diff）。
- `scriptValues`：`[storageName, key] -> value`。
- `scriptResources`：`[uuid, url] -> { content, contentType, hash, fetchedAt }`。
- `scriptLogs`：环形日志。
- `installDrafts`：安装页草稿，带 `expiresAt`。

### 3.2 metadata 解析

兼容 `// ==UserScript==` 与 `// ==UserScript==` 之间的行：

```ts
interface ScriptMetadata {
  name: string[];
  namespace: string[];
  version: string[];
  description: string[];
  author: string[];
  match: string[];
  include: string[];
  exclude: string[];
  'exclude-match': string[];
  grant: string[];
  connect: string[];
  require: string[];
  resource: string[]; // "name url"
  'run-at': string[];
  'inject-into': string[];
  noframes: string[];
  unwrap: string[];
  'top-level-await': string[];
  updateurl: string[];
  downloadurl: string[];
  icon: string[];
  [key: string]: string[] | undefined;
}
```

规则：

- 大小写归一：tag 小写，值保留原始大小写（URL 大小写敏感，主机不敏感）。
- `@name` 必填；`@namespace` 可为空；`@version` 可空。
- 重复 tag 聚合为数组；`@resource` 需要解析 `name url`，name 唯一。
- 支持 `@name:zh-CN` / `@description:en` 之类的 locale 后缀；UI 按当前语言选择，回退到无后缀值。
- 解析错误不阻塞安装，但要在安装页/编辑器给出诊断（行号、原因）。
- 保留原始 metablock 字符串，用于 `GM_info.scriptMetaStr` 和编辑器展示。

### 3.3 URL 规则与注册计划

规则类型（参考 ScriptCat `url_matcher.ts`）：

```ts
type UrlRule =
  | { kind: 'match-include'; pattern: string }
  | { kind: 'match-exclude'; pattern: string }
  | { kind: 'glob-include'; pattern: string }
  | { kind: 'glob-exclude'; pattern: string }
  | { kind: 'regex-include'; source: string; flags: string }
  | { kind: 'regex-exclude'; source: string; flags: string };
```

编译步骤：

1. `@match` → 校验/规范化为 Chrome match pattern；非法规则丢弃并告警。
2. `@exclude-match` → 同上，归入 exclude。
3. `@include`：
   - 如果本身是合法 match pattern → 作为 match include；
   - 如果是 `/regex/flags` → regex include；
   - 否则 → glob include；处理 Magic TLD `.tld/` → `.??*/`（Greasemonkey/VM 兼容）。
4. `@exclude` 同理，归入 exclude。
5. 默认：没有 include/match → 全站（`*://*/*` + `file:///*`，可配置是否包含 file）。
6. 编译 `RegistrationPlan`：
   - `matches` = 所有 match-include 的 pattern；若为空但有 glob/regex include，使用 `['*://*/*']` 作为安全超集。
   - `includeGlobs` = glob include。
   - `excludeMatches` / `excludeGlobs` = 对应排除。
   - `needsRuntimeCheck` = 存在 regex 或无法精确表达为 Chrome API 的规则。
7. 启动器内置 `rules`，运行时执行 `urlMatches(location.href, rules)`：
   - 先任意 exclude 命中 → 不执行；
   - 再任意 include/match 命中 → 执行；
   - 两者都为空 → 执行（全站）。

> 关键点：Chrome 的 `matches` 匹配发生在脚本注入前，无法处理正则；因此要么在注册时放宽，要么运行时二次校验。ScriptCat 正是这样处理的（`getUserScriptRegister()` + `scriptUrlPatterns`）。

### 3.4 有效 metadata（用户覆盖）

`selfMetadata` 只保存用户显式覆盖的字段：

- `match`, `include`, `exclude`, `exclude-match`
- `run-at`, `inject-into`, `noframes`
- `updateurl`, `downloadurl`
- `enabled` 不放在 metadata，放在 `UserScript.enabled`

合并规则：

```ts
effective = { ...metadata, ...selfMetadata }
```

编辑器 UI 需要：

- 显示“来自脚本”与“用户覆盖”的差异；
- 支持“重置为脚本默认”；
- 修改 match 后立即重新计算注册计划并重注册；
- 警告空匹配（脚本不会在任何页面运行）。

---

## 4. GM API 设计

### 4.1 分层

```
脚本代码
  └─ GM 对象（Runner/Host 闭包内）
       ├─ 本地实现：GM_info、GM_addStyle、GM_addElement、GM_log、值快照、菜单命令
       └─ 桥接实现：GM_xmlhttpRequest、GM_cookie、GM_download、GM_notification、
                    GM_openInTab、GM_setClipboard、GM_getResourceURL...
                        └─ Host → SW（runtime port）
                              └─ Chrome 特权 API
```

### 4.2 支持矩阵（MVP / 后续）

| API | MVP | 实现位置 | 说明 |
|---|---|---|---|
| `GM_info` / `GM.info` | ✅ | Runner/Host | metadata、scriptHandler、version、scriptMetaStr、sandboxMode |
| `GM_getValue` / `GM.getValue` | ✅ | Host 本地快照 + SW | 同步读快照；异步写/读 |
| `GM_setValue` / `GM.setValue` | ✅ | Host → SW | 写后更新本地快照，广播变更 |
| `GM_deleteValue` / `GM.deleteValue` | ✅ | 同上 | |
| `GM_listValues` / `GM.listValues` | ✅ | 同上 | |
| `GM_getValues` / `GM_setValues` / `GM_deleteValues` | ✅ | 同上 | 批量 API |
| `GM_addValueChangeListener` / `GM.removeValueChangeListener` | ✅ | Host + SW 广播 | 同页立即触发，跨 tab 广播 |
| `GM_addStyle` | ✅ | Runner/Host | 插入 `<style>`；沙箱/页面均可用 |
| `GM_addElement` | ✅ | Runner/Host | 插入元素，绕过部分 CSP（需测试） |
| `GM_log` / `GM.log` | ✅ | Host | console + 日志环 |
| `GM_registerMenuCommand` / `GM.unregisterMenuCommand` | ✅ | Host + SW | popup/菜单展示，点击回传 |
| `GM_notification` / `GM.closeNotification` / `GM.updateNotification` | ✅ | SW | `chrome.notifications`；click/button/close/oncreate 回调 |
| `GM_openInTab` / `GM_closeInTab` | ✅ | SW | `chrome.tabs.create/remove`；`onclose` 回调 |
| `GM_setClipboard` | ✅ | Host/SW | `clipboardWrite`；text/html |
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | ✅ | SW | `@connect` 校验、进度、二进制、document |
| `GM_getResourceText` / `GM_getResourceURL` | ✅ | Host | 资源缓存；URL 用 blob/data |
| `GM_download` / `GM.download` | ✅ | SW | `chrome.downloads`；progress/onload/onerror/abort |
| `GM_cookie` / `GM.cookie` | ✅ | SW | `chrome.cookies`；需用户授权 |
| `GM_getTab` / `GM_saveTab` / `GM_getTabs` | ✅ | SW | 按脚本 + tab 状态 |
| `unsafeWindow` | ✅ | Runner | 页面世界真实 window；content 为隔离 window |
| `window.close` / `window.focus` / `window.onurlchange` | ✅ | SW / Runner | tab 操作 + Navigation API |
| `GM_addValueChangeListener` 远端标记 | ✅ | Host | `remote` 参数；跨 tab/共享 storageName |
| `GM_xmlhttpRequest` `@connect` 未授权 | ❌ | SW | 返回明确错误，弹授权 UI |
| `@require` / `@resource` | ✅ | SW 缓存 + Host | 安装时抓取，支持 hash |
| `@crontab` / `@background` | ⏳ | SW | 非标准；后续扩展 |
| `CAT_*` / `GM.agent*` | ❌ | — | ScriptCat 私有，不纳入 |

### 4.3 值存储语义

- `storageName = metadata.storageName?.[0] || uuid`，允许多脚本共享值空间（ScriptCat/VM 兼容）。
- 持久化：IndexedDB object store `values`，key `[storageName, key]`。
- 注入时 Host 向 SW 请求当前 URL 匹配脚本的 values 快照：
  ```ts
  { [uuid]: { [key]: encodedValue } }
  ```
- `GM_getValue` 同步返回快照；`GM.getValue` 返回 Promise。
- `GM_setValue`：
  1. 更新 Host 本地快照；
  2. 发 `gm:setValue` 给 SW；
  3. SW 持久化并广播 `valueChanged` 给所有 tab/frame 中同 storageName 的脚本；
  4. 同 tab 的 Host 立即触发本地 listener（`remote: false`）。
- 值编码：JSON 可序列化值直接存；`undefined` 表示删除；循环引用/函数报错。
- 限制单值大小（例如 1MB）与总大小，超出时给出明确错误，避免占满 IndexedDB。

### 4.4 `GM_xmlhttpRequest`

MVP 推荐 SW + `fetch`：

- 校验 `@connect`：目标 host 必须在 `connect` 列表，或用户显式授权。
- `credentials: 'include'`（需要 cookies 时）；`redirect: 'follow'`。
- 支持 `method/headers/data/responseType`：
  - `text/arraybuffer/blob` → 通过 base64 或 `ArrayBuffer` 结构化克隆回传；
  - `document` → 用 `DOMParser` 在 Host/SW 解析（视需要）。
- 进度：`fetch` 流式读取，向 Host 发 `progress` 事件；若不需要进度，直接返回。
- 超时：`AbortController`。
- 错误：网络错误、CORS（SW 不受 CORS 限制但受 host permissions）、`@connect` 拒绝、超时。
- Header 修改：普通请求用 `fetch` headers；需要 `Referer`/`Cookie` 等受限头时用 DNR session rule（参考 ScriptCat/VM 的 `gm_xhr` + DNR）。
- 大响应：不要一次性把巨量 base64 放进消息；优先 `ArrayBuffer` 结构化克隆，必要时用 offscreen document 或临时 blob URL。

### 4.5 `@connect` 授权

- 安装页展示脚本要访问的 host 列表。
- 设置页提供“网络访问策略”：每次询问 / 允许已确认 host / 拒绝。
- SW 维护 `connectGrants: { [uuid]: string[] }`（持久化），更新脚本新增 host 时必须重新确认。
- 支持 `*` 作为通配，但 UI 明确标红高风险。

### 4.6 API 兼容细节

- 同时提供 `GM_foo` 与 `GM.foo` 两套命名；`GM_foo` 保持同步/回调语义，`GM.foo` 返回 Promise。
- `GM_info.script` 字段尽量对齐 Tampermonkey：`name`、`namespace`、`version`、`author`、`description`、`matches`、`includes`、`excludes`、`run-at`、`grant`、`connect`、`downloadURL`、`updateURL`、`icon`、`lastModified`。
- `GM_info.scriptHandler = 'Lumo Userscripts'`。
- `GM_info.version` = 扩展版本。
- `GM_info.sandboxMode`：`'raw'`（MAIN）或 `'content'`（USER_SCRIPT）。
- `GM_info.scriptMetaStr`：原始 metablock。
- `GM_addStyle` 返回元素，并兼容 `.then()`（VM 的做法）以便 await。
- `GM_notification` 支持 `text/title/image/onclick/ondone`，返回/回调语义对齐 VM。

### 4.7 与参考仓库的 API / metadata 对照结论

- **Greasemonkey**：保留其 metadata 解析、`@require` 拼接、GM 值/通知/菜单/剪贴板的调用形状；MV2 执行架构不采用。
- **Violentmonkey**：对齐 `GM_*`/`GM.*` 双命名、值快照与 `remote` 语义、`GM_addStyle` thenable、`@inject-into`、`@noframes`、`@unwrap`、`@storageName`、`unsafeWindow` 在页面/内容世界的行为。
- **ScriptCat**：补齐 `GM_closeNotification`、`GM_updateNotification`、`GM_closeInTab`、`GM_openInTab` 返回 tab 对象、`GM_download` 回调/进度、`GM_notification` button/click 事件、`GM_log` level/labels、`GM_info.script.resources`、`window.close`/`window.focus`。
- **刻意不纳入**：`CAT_*`、`GM.agent*` 等 ScriptCat 私有 API；`@background`、`@crontab`、`@run-in` 等尚未实现的非标准配置（安装页明确告警，不静默生效）。
- **metadata URL 解析**：`@require`、`@require-css`、`@resource`、`@icon`、`@homepageURL`、`@supportURL`、`@updateURL`、`@downloadURL` 等相对 URL 按安装 URL 解析。
- **metadata 展示字段补全**：`@icon`/`@iconURL`/`@icon64`/`@icon64URL`/`@defaulticon` 回退、`@homepageURL`/`@website`/`@source` 回退、`@supportURL`、`@antifeature`、`@downloadURL`、`@storageName`、`@early-start`、`@unwrap`。

---

## 5. 安装流程

### 5.1 触发入口

1. **网页 `.user.js` 导航**
   - 首选：DNR `redirect` 规则，把主 frame 的 `.user.js` 请求重定向到 `install.html?src=<encoded>`。
   - Chrome 128+ 加 `responseHeaders` 条件，只对 JS/纯文本响应生效，避免误伤。
   - Chrome < 128 可退化为宽松匹配（仅 `.user.js` 后缀）。
   - 参考：ScriptCat `script.ts` 的 DNR 规则；VM `dnr.js` + `tab-redirector.js`。

2. **从 URL 安装**
   - Options → New → “From URL”，输入 URL，调用 `install.prepare(url)`。

3. **文件 / 拖拽**
   - Options 拖入 `.user.js`，读取文本；`.zip` 作为备份包导入。
   - 弹出安装页或直接进入草稿。

4. **剪贴板**
   - “Paste script” 读取剪贴板文本，解析 metadata 后进入安装页。

5. **开发模式**
   - 编辑器新建脚本直接保存，不走安装页。

### 5.2 草稿与暂存

不要用 URL 传递脚本体。流程：

```ts
// install.prepare
const draft = await prepareInstall({ sourceUrl, code? });
// SW:
// 1. fetch sourceUrl（超时、大小限制、content-type 检查）
// 2. parse metadata
// 3. 查找已安装的同 name+namespace
// 4. 抓取 @require / @resource（并发限制、hash 校验）
// 5. 计算 diff（新增/更新/降级、权限变化、代码差异）
// 6. 存 installDraft（TTL 10 分钟）
// 7. 返回 installToken + summary
```

安装页只拿到 `installToken`，再通过消息读取草稿摘要与代码预览。

### 5.3 安装页信息架构

```
┌──────────────────────────────────────────────────────┐
│  Install script                               [×]    │
├──────────────────────────────────────────────────────┤
│  [icon]  Name                             v1.2.3     │
│          namespace · author                          │
│          description                                 │
│          source: https://...                         │
├──────────────────────────────────────────────────────┤
│  Permissions                                         │
│  ✓ GM_setValue     ✓ GM_xmlhttpRequest               │
│  ✓ @connect api.example.com                          │
│  ! @require 2 external scripts                       │
│  ! @grant none / unsafeWindow                        │
├──────────────────────────────────────────────────────┤
│  Changes (update only)                               │
│  ↑ v1.2.2 → v1.2.3  ·  match +1  ·  grant +1         │
│  [View code diff]                                    │
├──────────────────────────────────────────────────────┤
│  Code preview (collapsible, Shiki)                   │
├──────────────────────────────────────────────────────┤
│  [ ] Enable after install   [ ] Open editor          │
│                           [Cancel] [Install]         │
└──────────────────────────────────────────────────────┘
```

安全要求：

- 页面必须在顶层窗口（`window.top === window`），否则拒绝渲染。
- 安装按钮必须由用户点击；更新时若新增 `@grant` / `@connect` / `@require`，必须二次确认。
- 显示代码预览，默认折叠；高风险 API 用 destructive badge。
- 安装页不使用 `dangerouslySetInnerHTML` 渲染脚本文本。

### 5.4 安装落库

```ts
async function commitInstall(token: string, opts: { enabled: boolean; openEditor: boolean }) {
  const draft = await drafts.take(token); // 单次消费
  const existing = await scripts.findByNameNamespace(draft.meta);
  const uuid = existing?.uuid ?? draft.uuid;
  // 1. 写入 scriptCode + version snapshot
  // 2. 写入/更新 scripts
  // 3. 保留/迁移 values（同 storageName）
  // 4. 写 resources
  // 5. 计算 registration plan
  // 6. ensureRegistered()（只更新受影响脚本）
  // 7. 广播 scriptsChanged
  // 8. 若 openEditor，打开 /script/<uuid>
}
```

当前页应用：

- 注册表更新只影响后续导航；安装完成后提示：
  - “Installed. Reload this tab to run it.” + `Reload` 按钮；
  - 不自动 reload，避免丢失页面状态。
- 若提供“Run now”，通过 Host 注入当前页运行，需用户显式点击。

### 5.5 更新

- `@updateURL` / `@downloadURL`；缺失时回退 `origin`。
- 定时 `chrome.alarms`（默认 6 小时）+ 手动“检查更新”。
- 条件请求 `If-None-Match` / `If-Modified-Since`；比较 `@version`（semver 宽松）与代码 hash。
- 更新策略：
  - 权限未变化且用户开启自动更新 → 静默更新；
  - 新增 `@grant` / `@connect` / `@require` → 打开安装页确认；
  - 降级（版本变小）→ 仅手动确认。
- 更新后写入 `scriptVersions`，支持回滚。

---

## 6. Popup 交互设计

### 6.1 定位

Popup 是“当前页面的脚本控制台”，不是完整管理器。完整管理、编辑、设置放在 Options。

宽度建议 `380–420px`；高度由内容决定，最大 `600px` 内滚动；不要写死高度（Chrome popup 上限受缩放影响）。

### 6.2 信息架构

```
┌─────────────────────────────────────────────┐
│ [logo] Lumo Userscripts        [⚙] [＋] [⋯] │
│ ── 当前页面：example.com ─────────────────  │
│ [●] 启用脚本（全局）        3/5 个脚本匹配  │
├─────────────────────────────────────────────┤
│ 页面脚本                                     │
│  [icon] Script A        v1.2   [switch] [⋯] │
│  [icon] Script B        v2.0   [switch] [⋯] │
│  [icon] Script C（已排除）      [switch] [⋯] │
│  ...                                         │
├─────────────────────────────────────────────┤
│ 脚本菜单命令（GM_registerMenuCommand）       │
│  > Do something                              │
├─────────────────────────────────────────────┤
│ 状态：UserScripts API 不可用？[去开启]       │
├─────────────────────────────────────────────┤
│ [打开管理面板]                               │
└─────────────────────────────────────────────┘
```

### 6.3 交互规则

- **全局开关**：顶部 switch；关闭后脚本不注入，popup 显示“已暂停”。
- **每行**：
  - 图标 + 名称 + 版本 + 匹配状态；
  - 右侧 switch（启用/禁用）；
  - kebab：编辑、脚本设置、排除此站点、更新、删除、查看值。
- **当前页脚本列表**：
  - 默认只显示匹配当前 URL 的脚本，包括被 `@exclude` 排除的（灰色，标注原因）。
  - 显示“为什么没运行”：未启用、被排除、用户脚本 API 不可用、语法错误。
  - 空状态：`No scripts for this page` + “安装/新建”入口。
- **菜单命令**：
  - 按脚本分组，折叠展示；支持 accessKey。
  - 点击后通过 Host 调用脚本回调；回调结果/错误以 toast 展示。
- **搜索**：脚本超过 ~15 个时显示搜索框（渐进式披露）。
- **状态横幅**：
  - `userScripts` 不可用 → 显示“开启用户脚本”指引，按钮打开 `chrome://extensions/?id=<id>`。
  - 当前页不在可注入范围（chrome://、Web Store、file）→ 说明原因，不列无关脚本。
- **快捷键**：`Ctrl/Cmd+Enter` 打开管理面板？可选；不要与浏览器冲突。
- **动效**：列表展开/折叠 150ms；开关 120ms；尊重 `prefers-reduced-motion`。

### 6.4 组件映射（复用现有 UI）

- `Button`、`Switch`、`Badge`、`DropdownMenu`、`ScrollArea`、`Tooltip`、`Dialog`。
- 列表行使用 `flex min-w-0`，文本 `truncate`；避免侧栏宽度变化导致换行破坏布局。
- 空状态复用 `components/layout/EmptyState.tsx`。

---

## 7. Options 页面设计

### 7.1 路由

采用 `react-router-dom` 的 `createHashRouter`（扩展页面必须 hash 路由）：

```
#/scripts
#/scripts/trash
#/script/:uuid?view=code|settings|values|resources
#/install?token=...
#/settings/general
#/settings/appearance
#/settings/injection
#/settings/network
#/settings/data
#/settings/about
#/logs
```

> 也可以继续用现有 hash nav 手写路由，但脚本编辑器/安装页/多级设置会让手写路由迅速失控；推荐引入 `react-router-dom`。

### 7.2 侧边栏

分组：

- **Scripts**
  - Installed
  - Recycle Bin
  - Logs
- **Settings**
  - General
  - Appearance
  - Injection
  - Network
  - Data & Backup
  - About

窄窗口折叠为图标栏（与现有 Options App 的响应式行为一致）。

### 7.3 脚本列表

工具栏：

- `＋ New`：空白脚本 / 模板 / 从 URL / 从文件 / 从剪贴板。
- `Import`：`.user.js` / `.zip` 备份。
- `Check updates`：全部/选中。
- 搜索框：名称、namespace、描述、tag、match host。
- 过滤：启用/禁用/有更新/有错误/标签/站点。
- 排序：名称、创建时间、更新时间、最近运行、手动顺序。
- 视图：表格 / 紧凑列表。
- 批量栏：启用、禁用、导出、删除、检查更新、置顶。

表格列：

| 列 | 内容 |
|---|---|
| 选择 | checkbox |
| 脚本 | 图标、名称、namespace、tag、错误/更新 badge |
| 版本 | version + 更新可用标记 |
| 匹配 | `@match/@include` 摘要（host 列表，超出折叠） |
| 状态 | 启用 switch、运行状态、最后运行 |
| 操作 | kebab（编辑、设置、值、资源、导出、删除） |

空状态：`No scripts yet` + 新建/导入按钮；不要堆叠说明文字。

### 7.4 脚本编辑器

布局：

```
┌──────────────────────────────────────────────────────────────┐
│ [<] Script name   [dirty]      [Save] [Run] [⋯]              │
├────────────┬─────────────────────────────────┬───────────────┤
│ Script list│  CodeMirror editor              │ Meta / Values │
│ (collapsible)                                 │ / Resources   │
│            │                                 │               │
├────────────┴─────────────────────────────────┴───────────────┤
│ Ln 12, Col 3 · JavaScript · UTF-8 · LF · 2 spaces · v1.2.3    │
└──────────────────────────────────────────────────────────────┘
```

能力：

- 多标签：同时打开多个脚本；未保存标记；关闭确认。
- 未保存离开拦截：`beforeunload` + 路由 blocker。
- CodeMirror 6：
  - JavaScript 语法高亮、括号匹配、折叠、自动补全、搜索替换、多光标；
  - `@codemirror/lint` 显示 JS 语法错误（可用 `acorn` 轻量解析）；
  - metadata 行内诊断：非法 `@match`、缺失 `@name`、重复 `@grant`、`@grant none` 与 `GM_*` 冲突、`@connect` 空值；
  - `@` 触发 metadata 自动补全；
  - 主题跟随应用主题（GitHub/VSCode theme）。
- 右侧面板（Tabs）：
  - **Metadata**：解析结果 + 用户覆盖；match/include/exclude 列表编辑；run-at、inject-into、noframes、update URL；重置；校验。
  - **Values**：GM 值列表，JSON 编辑，删除，导入/导出。
  - **Resources**：`@require` / `@resource` 列表、大小、hash、抓取状态、预览、重新下载。
  - **Info**：来源、安装时间、更新时间、代码大小、运行次数、最后错误。
- 保存流程：
  1. 取编辑器代码；
  2. 解析 metadata；
  3. 校验 name/namespace/version/match；
  4. 检查编辑冲突（DB `updatedAt` 与编辑器打开时不一致）；
  5. 检查同名同 namespace；
  6. 写 DB + version snapshot；
  7. 重算注册计划并注册；
  8. toast + 更新列表/标签状态。
- 新建脚本模板：
  ```js
  // ==UserScript==
  // @name         New script
  // @namespace    lumo
  // @version      1.0.0
  // @description
  // @match        https://example.com/*
  // @grant        none
  // ==/UserScript==
  ```
- 快捷键：
  - `Ctrl/Cmd+S` 保存；
  - `Ctrl/Cmd+Shift+S` 另存为；
  - `Ctrl/Cmd+Enter` 在当前 tab 运行（若支持）；
  - `Ctrl/Cmd+F` 搜索；
  - `Ctrl/Cmd+P` 快速打开脚本（后续）。
- 自动保存草稿：默认关闭；可每 2 秒写 IndexedDB 草稿，崩溃恢复。避免“看似保存其实没保存”的陷阱。

### 7.5 设置页

#### General

- 全局启用脚本。
- 默认 `@run-at`。
- 自动检查更新（开/关、间隔）。
- 自动更新策略：全部自动 / 仅无权限变化 / 仅提示。
- 启动时打开：Popup / Options / 不打开。
- 语言、主题、字体大小（复用现有 Appearance）。

#### Injection

- 默认 `inject-into`：`auto / page / content`。
- `@grant none` 脚本是否允许页面世界（默认允许）。
- 强制沙箱模式（所有有 grant 的脚本进入 USER_SCRIPT）。
- `unsafeWindow`：页面世界/`@grant unsafeWindow` 为真实页面对象；USER_SCRIPT 无 `unsafeWindow` grant 时为隔离世界 `window`（与 VM/ScriptCat 一致）。
- `@noframes` 默认。
- CSP 策略：`configureWorld` 的 `script-src` 选项（默认允许 inline/eval 以兼容；提供严格模式）。
- 站点黑名单/白名单（glob/regex）。
- UserScripts 状态卡：
  - API 是否可用；
  - 已注册脚本数；
  - 最近一次注册错误；
  - “打开扩展详情页” / “重新注册”。
- 当前 Chrome 版本与 `userScripts` 开关说明。

#### Network

- `@connect` 策略：每次询问 / 已确认允许 / 全部允许（不推荐）。
- 请求超时。
- Cookie 访问开关（`GM_cookie`）。
- 下载模式（浏览器 downloads / 原生）。
- 已授权 host 列表，可撤销。

#### Data & Backup

- 导出：JSON（脚本+值+设置）/ ZIP（`.user.js` + values）。
- 导入：文件/ZIP/URL；冲突策略（跳过/覆盖/保留两者）。
- 备份到文件（后续可扩展 WebDAV/S3）。
- 清空日志、清空回收站、重置所有设置。
- 存储用量：脚本数/代码大小/值大小/资源大小。

#### About

- 版本、构建信息、开源链接、隐私说明。
- `userScripts` 权限说明。
- 第三方参考与许可（Greasemonkey MIT、VM MIT、ScriptCat GPLv3——注意：不要复制 GPL 代码；只参考架构与思想，独立实现）。

---

## 8. 数据与存储

### 8.1 分层

| 数据 | 存储 | 原因 |
|---|---|---|
| 设置（主题、语言、注入偏好） | `chrome.storage.local` | 小、有界、跨上下文 `onChanged` |
| 脚本索引/元数据 | IndexedDB `scripts` | 数量增长，需要查询/排序 |
| 脚本代码 | IndexedDB `scriptCode` | 大文本，不能放 storage |
| 版本快照 | IndexedDB `scriptVersions` | 回滚/diff |
| GM 值 | IndexedDB `values` | 增长，按 storageName 共享 |
| 资源 | IndexedDB `resources` | 二进制/文本，可缓存 |
| 日志 | IndexedDB `logs` 环形 | 高频写入，可裁剪 |
| 安装草稿 | IndexedDB `installDrafts` + TTL | 不在 URL 传代码 |
| 注册表健康状态 | `chrome.storage.session` | 仅当前浏览器会话 |

> 现有 `store/storage-schema.ts` 只保留 `uiSettings`；新增设置继续加到 registry。脚本数据不要塞进 `chrome.storage.local`，避免 10MB 配额拖垮设置写入（Lumo 曾因 `conversations` 单 key 耗尽配额）。

### 8.2 IndexedDB schema

```ts
const DB_NAME = 'lumo-us';
const DB_VERSION = 1;

// scripts: keyPath 'uuid'
//   indexes: name, namespace, enabled, updatedAt, 'nameNamespace' (unique)
// scriptCode: keyPath 'uuid'
// scriptVersions: keyPath 'id' ('uuid:timestamp'), index 'uuid'
// values: keyPath ['storageName', 'key'], index 'storageName'
// resources: keyPath ['uuid', 'url'], index 'uuid'
// logs: keyPath 'id' (autoIncrement), index ['uuid','time'], index 'time'
// installDrafts: keyPath 'token', index 'expiresAt'
```

迁移策略：`onupgradeneeded` 按版本递增，禁止删除旧 store；每次升级写迁移日志。

### 8.3 值编码

```ts
type EncodedValue =
  | { t: 'json'; v: unknown }
  | { t: 'undefined' }
  | { t: 'blob'; v: Blob }
  | { t: 'arraybuffer'; v: ArrayBuffer };
```

MVP 只支持 JSON 可序列化值；Blob/ArrayBuffer 作为后续扩展。`GM_setValue` 遇到不可序列化值必须抛错，而不是静默字符串化。

---

## 9. Service Worker 结构

```
entrypoints/background.ts
  └─ lib/background/
       ├─ install.ts          # onInstalled / onStartup / 安装提交
       ├─ registry.ts         # registration plan, ensureRegistered, diff
       ├─ scripts.ts          # CRUD, toggle, reorder, trash
       ├─ install-service.ts  # prepareInstall, fetch, parse, draft, commit
       ├─ update-service.ts   # alarms, check updates, semver
       ├─ gm/
       │   ├─ router.ts       # host port 消息路由, token 校验
       │   ├─ values.ts
       │   ├─ xhr.ts
       │   ├─ cookies.ts
       │   ├─ downloads.ts
       │   ├─ notifications.ts
       │   ├─ tabs.ts
       │   └─ clipboard.ts
       ├─ menus.ts            # GM_registerMenuCommand / contextMenus
       ├─ dnr.ts              # 安装重定向规则、XHR header 规则
       └─ alarms.ts
```

原则：

- 所有事件监听在顶层同步注册（MV3 SW 会被挂起）。
- 不依赖 SW 内存保存用户数据；内存只做缓存，可随时重建。
- 长生命周期端口（Host）要有重连；SW 重启后从 IndexedDB 恢复。
- 注册表变更串行化：`registrationQueue = registrationQueue.then(...)`，避免并发 register/unregister 竞态。

---

## 10. 目录规划（在当前项目内）

```
entrypoints/
  background.ts                 # 现有，扩展为 SW 入口
  popup/
    index.html
    main.tsx
    App.tsx
  options/
    index.html
    main.tsx
    App.tsx                     # 路由 + 布局
  install/
    index.html
    main.tsx
    App.tsx
  popup/                        # 当前页快捷控制
components/
  ui/                           # 现有 shadcn 基础组件
  layout/                       # EmptyState 等
  settings/
  scripts/                      # ScriptRow, ScriptTable, FilterBar, BatchBar
  editor/                       # CodeEditor, EditorTabs, MetadataPanel, ValuesPanel
  install/                      # InstallIdentity, PermissionCard, CodePreview
lib/
  script/
    metadata.ts                 # metablock 解析
    url-rules.ts                # match/include/exclude 编译
    registration.ts             # registration plan
    compile.ts                  # launcher 生成
    semver.ts
    template.ts
  runtime/
    runner/                     # MAIN 世界运行时（IIFE 构建）
    host/                       # USER_SCRIPT 世界运行时（IIFE 构建）
    protocol.ts                 # 共享消息类型/常量
  db/
    idb.ts
    scripts.ts
    values.ts
    resources.ts
    logs.ts
    drafts.ts
  background/                   # SW 服务
  install/                      # 安装服务
  update/                       # 更新服务
  gm/                           # GM API 客户端类型 + 权限表
store/
  storage-schema.ts             # 仅设置
  storage.ts
  useStorageWatch.ts
  useScripts.ts                 # Zustand
  useRuntimeStatus.ts
entrypoints/... pages
types/
  script.ts
  gm.ts
  messages.ts
```

构建：

- `lib/runtime/runner` 和 `lib/runtime/host` 必须是 **IIFE、无 code splitting、无 ESM import** 的独立 bundle，输出到 `.output/chrome-mv3/user-scripts/runner.js` / `host.js`。
- 可以用 Vite 的 library mode 或独立 `vite build` 配置；WXT 的 `vite` 配置里增加一个 build 插件，在 `buildStart`/`writeBundle` 阶段产出这两个文件。
- 不要让 WXT 把 runtime 拆成共享 chunk；`chrome.userScripts.register({ file })` 加载的是经典脚本，不能包含 `import`。
- 开发模式下也要产出可加载的 runtime（`wxt dev` 时监听重建）。

---

## 11. 权限与安全

### 11.1 manifest

```jsonc
{
  "manifest_version": 3,
  "minimum_chrome_version": "138",
  "permissions": [
    "userScripts",
    "scripting",
    "storage",
    "unlimitedStorage",
    "tabs",
    "activeTab",
    "webNavigation",
    "declarativeNetRequest",
    "cookies",
    "downloads",
    "notifications",
    "contextMenus",
    "alarms",
    "clipboardWrite"
  ],
  "host_permissions": ["<all_urls>"],
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "action": { "default_popup": "popup.html" },
  "web_accessible_resources": [
    { "resources": ["install.html"], "matches": ["<all_urls>"] }
  ]
}
```

说明：

- `userScripts` 是核心；没有它无法注入动态代码。
- `scripting` 用于可选的固定 content script/诊断（如果最终不需要可去掉）。
- `declarativeNetRequest` 用于安装重定向和受限 header 修改。
- `cookies` 只用于 `GM_cookie`，可在设置中关闭；若不想申请，可将 `GM_cookie` 设为可选权限（`optional_permissions`）并在首次使用时请求。
- `downloads` 用于 `GM_download`，同样可设为 optional。
- `<all_urls>` 是用户脚本管理器的必要能力；安装页需明确说明。

### 11.2 `userScripts` 可用性

检测：

```ts
async function getUserScriptsStatus() {
  if (!chrome.userScripts) return { ok: false, reason: 'api-missing' };
  try {
    await chrome.userScripts.getScripts();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'permission-or-toggle', error: String(e) };
  }
}
```

UI 指引：

- Chrome 138+：`chrome://extensions/?id=<id>` → “Allow User Scripts” 开关。
- 更早版本：开启右上角 Developer mode。
- Edge/Chromium 分支：文案保持通用，不写死版本。

### 11.3 安全边界

1. **GM 对象不挂 window**：只通过 `with(gm)` / 闭包参数暴露给当前脚本；页面代码无法直接调用。
2. **Host 校验 runToken**：每个注册脚本生成随机 token；Host 拒绝无 token 的 GM 请求。
3. **消息校验**：`event.source === window`、`event.origin`、端口 handshake nonce。
4. **安装确认**：展示 grant/connect/require；新增权限必须二次确认。
5. **`@connect` 强校验**：SW 侧匹配 host，不依赖前端。
6. **代码预览**：安装页用 Shiki 渲染纯文本，不用 `dangerouslySetInnerHTML`。
7. **CSP**：`configureWorld` 的 CSP 尽量收紧；若为兼容必须 `unsafe-eval`，在设置/隐私说明中明确。
8. **不执行远程代码**：`@require` 是用户脚本语义的一部分，但安装时要显示来源和 hash；可选“禁止远程 require”严格模式。
9. **回收站**：删除先入回收站，保留值/资源/代码；彻底删除需二次确认。
10. **不记录页面内容**：日志只记录脚本 console/错误，不抓页面 DOM/网络正文。

---

## 12. 状态管理与 UI 数据流

```
Options/Popup
  ├─ useScriptsStore (Zustand)
  │    ├─ list, filters, selection, loading
  │    └─ actions -> messageClient -> SW
  ├─ useRuntimeStatusStore
  │    ├─ userScriptsAvailable
  │    ├─ registeredCount
  │    └─ lastError
  └─ useSettings (existing storage hooks)
```

- UI 不直接读 IndexedDB；所有写操作走 SW，读操作可走 SW 或直接读 DB（Options 页面可以直接读 DB 降低延迟，但写完必须广播）。
- SW 广播 `scriptsChanged` / `valuesChanged` / `runtimeStatusChanged`；Options/Popup 用 `chrome.runtime.onMessage` 或 `BroadcastChannel` 更新。
- 现有 `useStorageWatch` 只覆盖 `chrome.storage` 设置；脚本数据用自定义事件总线 + `BroadcastChannel('lumo-us')`。

---

## 13. 日志与诊断

- 记录：
  - 脚本 `console.log/info/warn/error`（通过 Host 拦截/转发）；
  - 未捕获异常（含脚本名、URL、行号）；
  - GM API 调用错误；
  - 注册失败；
  - 安装/更新结果。
- 存储：IndexedDB `logs`，每脚本最多 N 条（默认 500），全局最多 M 条（默认 5000），超出环形淘汰。
- 日志页：
  - 按脚本/级别/时间过滤；
  - 复制/导出；
  - 清空；
  - 点击跳转脚本编辑器。
- 诊断面板（Options → Injection）：
  - `userScripts` 状态；
  - 注册项数量与 ID 列表；
  - 最近一次注册耗时/错误；
  - 当前 tab 匹配测试：输入 URL，列出会运行的脚本与原因；
  - “重新注册”按钮。

---

## 14. 导入 / 导出 / 备份

### 14.1 JSON

```json
{
  "format": "lumo-userscripts",
  "version": 1,
  "exportedAt": "2026-...",
  "settings": { "uiSettings": { "...": "..." } },
  "scripts": [
    {
      "uuid": "...",
      "meta": { "name": ["..."], "namespace": ["..."] },
      "selfMetadata": {},
      "code": "...",
      "enabled": true,
      "values": { "key": "value" },
      "resources": { "url": { "content": "...", "contentType": "..." } }
    }
  ]
}
```

### 14.2 ZIP

```
lumo-backup/
  manifest.json
  settings.json
  scripts/<uuid>.user.js
  scripts/<uuid>.meta.json
  values/<storageName>.json
  resources/<uuid>/<hash>.<ext>
```

用现有 `fflate` 依赖压缩/解压。

### 14.3 冲突策略

- 按 `uuid` 优先；没有 uuid 时按 `name + namespace` 匹配。
- 选项：跳过 / 覆盖 / 保留两者（生成新 uuid）。
- 导入前展示差异摘要；值默认保留现有，除非用户勾选覆盖。

---

## 15. 测试方案

### 15.1 单元测试

- metadata 解析：
  - 标准 metablock；
  - 缺 `@name`；
  - 多语言 `@name:zh-CN`；
  - 重复 `@resource`；
  - CRLF / BOM；
  - 非法行/注释。
- URL 规则：
  - `@match` 规范化；
  - `@include` glob / regex / Magic TLD；
  - `@exclude` 优先级；
  - 空规则 → 全站；
  - Chrome API 不支持的规则 → `needsRuntimeCheck`。
- 注册计划：
  - `@noframes`；
  - `@run-at` 映射；
  - `@inject-into` world；
  - 无匹配脚本不生成引擎。
- 值编码/冲突/导入导出。
- semver 比较与更新策略。

### 15.2 集成测试（Playwright + 加载扩展）

- 加载 `.output/chrome-mv3`，打开测试页。
- `@grant none` 脚本在 MAIN world 修改 DOM。
- 有 grant 脚本调用 `GM_setValue` / `GM_getValue` / `GM_addStyle`。
- `GM_xmlhttpRequest` 访问允许/拒绝 host。
- popup 列出当前页脚本，开关生效。
- 安装页：DNR 重定向、安装确认、权限展示、更新 diff。
- 禁用/删除后不再注入（新导航）。
- `@inject-into content` 沙箱脚本运行，页面无法访问 GM 对象。
- forked/iframe 行为。
- CSP 严格页面（`script-src 'self'`）下的注入。
- `userScripts` 不可用时的引导 UI。

### 15.3 回归清单

- Chrome 138 / 152（DNR responseHeaders 行为差异）。
- 大量脚本（500+）列表性能与注册耗时。
- 大脚本（>1MB）与大值（>1MB）。
- 快速连续 toggle / 安装 / 更新时的注册竞态。
- SW 被挂起后 Host 重连。
- 页面伪造 bridge 消息不能调用 GM API。

---

## 16. 分阶段实施路线

### Phase 1：可用的最小闭环（MVP）

1. metadata 解析 + URL 规则 + 注册计划。
2. IndexedDB 数据层。
3. SW 注册表 + 固定 Runner/Host 骨架。
4. `@grant none` MAIN 脚本注入。
5. 有 grant 脚本的 MAIN + Host GM 桥（至少 `GM_info` / value / style / log / menu）。
6. 安装页（URL 安装）+ 脚本列表 + 启用/禁用/删除。
7. Popup 当前页列表 + 全局开关 + 状态提示。
8. 重注册/健康检查/错误展示。

### Phase 2：编辑器与完整安装

1. CodeMirror 编辑器、多标签、保存冲突、未保存拦截。
2. Metadata/Values/Resources 面板。
3. 文件/剪贴板/ZIP 导入；导出。
4. 更新检查（alarm + 手动）+ 更新确认。
5. 回收站、批量操作、搜索/过滤/排序。
6. 日志页与诊断面板。

### Phase 3：兼容性与高级能力

1. `@inject-into content` 沙箱完整支持。
2. `unsafeWindow` 传输加固（nonce + runtime token；当前 `@grant unsafeWindow` 已通过 MAIN 世界提供真实页面对象）。
3. `GM_xmlhttpRequest` 进度/二进制/DNR header 修改。
4. `GM_cookie` / `GM_download` / `GM_notification` 完整语义。
5. `@require`/`@resource` hash 校验、资源更新。
6. 同步/备份扩展（WebDAV/S3，可选）。
7. 性能优化：注册 diff、列表虚拟化、值懒加载。

### Phase 4：生态与打磨

1. 脚本模板、快速创建、示例脚本。
2. 更新通道/灰度、错误上报（可选，默认关闭）。
3. 导入 Tampermonkey/Violentmonkey/ScriptCat 备份的兼容层。
4. 键盘快捷键、命令面板。
5. 可访问性与动效细节。

---

## 17. 关键风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `userScripts` 开关未开启 | 所有脚本不运行 | popup/options 常驻状态检查 + 一键跳转；README/onboarding 说明 |
| `userScripts` API 版本差异 | Chrome 138+ 使用 Allow User Scripts 开关；企业策略可能关闭 | 运行时探测，不硬编码版本；状态提示 |
| DNR 安装重定向误伤 | 直接打开 `.user.js` 变成安装页 | 响应头条件（Chrome 128+）；host 白名单；失败时 allow 规则回退 |
| 页面桥被伪造 | 页面调用 GM API | nonce + MessageChannel + HMAC runtime token（uuid + world）+ sender.tab/frame 校验 |
| CSP 严格站点 | 页面世界脚本/样式被拦 | USER_SCRIPT 沙箱执行；`configureWorld` CSP；`GM_addStyle` 在沙箱插入 |
| SW 被挂起 | 端口断开、事件丢失 | 所有状态落 IndexedDB；端口重连；顶层注册监听；alarm 健康检查 |
| 注册竞态 | 脚本重复/缺失 | 串行队列 + 全量 diff + 失败回退单条注册 |
| 大脚本/大值 | 消息超限、注入慢 | 分块/懒加载；限制单值大小；资源按需取 |
| 远程 `@require` 供应链 | 执行恶意代码 | 安装页展示来源/hash；可选严格模式禁止远程 require |
| 参考项目许可证 | 代码复用风险 | Greasemonkey MIT / VM MIT 可参考；ScriptCat GPLv3 只参考架构，不复制代码；所有实现独立编写 |

---

## 18. 已确认的产品决策

以下决策已确认，后续实现以此为准：

| # | 决策 | 选择 | 含义 |
|---|---|---|---|
| 1 | 默认 `@run-at` | **1B：`document-idle`** | 与 ScriptCat 一致；需要早执行的脚本显式声明 `document-start/end` |
| 2 | 有 `@grant` 的脚本默认注入世界 | **2A：页面优先（MAIN + GM 桥）** | 最大兼容性；保留设置项允许强制沙箱 |
| 3 | `@inject-into page` + `@grant` | **3A：完整支持** | 引擎 → ISOLATED bridge 是核心组件，不做降级方案 |
| 4 | `GM_cookie` / `GM_download` | **4A：默认申请 `cookies` + `downloads`** | 安装时即声明，减少首次使用时的权限中断 |
| 5 | 远程 `@require` | **5A：默认允许 + 安装页展示来源/大小/警告** | 不做默认禁止；后续可加严格模式 |
| 6 | 侧边栏 | **6A：不保留 sidepanel** | 入口为 popup + options；sidepanel 仅作为未来可选调试面板 |
| 7 | 安装拦截范围 | **7A：只拦 `*.user.js` + 手动 URL/文件导入** | 不做通用 Content-Type 嗅探；后续可扩展到 `.user.sub.js`/`.user.bg.js` |
| 8 | Chrome 最低版本 | **8C：Chrome 138+** | 使用 “Allow User Scripts” 开关体验；`minimum_chrome_version: '138'` |

### 决策带来的直接约束

- **1B + 2A + 3A**：注册计划必须同时支持 MAIN 与 USER_SCRIPT world；ISOLATED bridge、runtime token、GM 代理是 Phase 1 的核心，不是可选项。
- **4A**：`wxt.config.ts` 的 `permissions` 直接包含 `cookies`、`downloads`；`GM_cookie` / `GM_download` 仍需在 SW 内做 `@connect` 与用户确认校验。
- **5A**：安装页必须展示每个 `@require` 的 URL、大小、hash/来源；后续可增加“严格模式”开关，但不作为默认。
- **6A**：不注册 `sidePanel` 权限、不生成 `sidepanel.html`；`action.default_popup = 'popup.html'`。
- **7A**：DNR 规则只针对 `.user.js`（含 query/hash 变体）；其他 `.js` 通过 Options 的“从 URL/文件/剪贴板安装”显式导入。
- **8C**：不再需要兼容 Chrome 120–137 的开发者模式引导；popup/options 仍保留 `userScripts` 状态检查，以应对用户关闭开关或企业策略。

### 仍需在实现时决定的次一级问题

1. `@require` 严格模式是否进入 Phase 2（默认关闭，只影响新安装/更新）。
2. `GM_xmlhttpRequest` 的二进制/进度实现是否使用 offscreen document（Phase 3 再定）。
3. 是否在 Phase 2 引入 `react-router-dom`，还是继续现有手写 hash 导航。
4. 是否提供 `@inject-into content` 的全局默认值（默认仍是 `auto`）。

---

## 19. 参考代码索引

### Greasemonkey

- `src/bg/execute.js`：MV2 `tabs.executeScript` 注入。
- `src/user-script-obj.js`：`calculateEvalContent()`、`calculateGmInfo()`。
- `src/bg/api-provider-source.js`：按 grant 生成 GM API 源码。
- `src/bg/value-store.js`：每脚本 IndexedDB 值存储。
- `src/parse-user-script.js` / `src/parse-meta-line.js`：metadata 解析。
- `src/bg/user-script-detect.js`：安装检测。
- `src/content/install-dialog.js`：安装确认 UI。

### Violentmonkey

- `src/common/browser-scripts-api.js`：MV3 `chrome.userScripts` / MV2 fallback。
- `src/background/utils/preinject-core.js`：预注入、按 URL 注册数据脚本。
- `src/background/utils/preinject-prepare.js`：脚本包装、`with(this)with(c)`、`@require`。
- `src/injected/content/inject.js`：页面 `<script>` 注入、vault handshake。
- `src/injected/web/index.js`：`ScriptData` / `onCodeSet` / 执行。
- `src/injected/web/gm-api-wrapper.js` / `gm-api.js` / `gm-global-wrapper.js`：GM API 与 safe global Proxy。
- `src/background/utils/tab-redirector.js` / `dnr.js`：安装检测。
- `src/confirm/views/app.vue`：安装确认页。

### ScriptCat

- `src/app/service/service_worker/runtime.ts`：`registerUserscripts()`、`getContentAndInjectScript()`。
- `src/app/service/service_worker/utils.ts`：`getUserScriptRegister()`。
- `src/app/service/content/exec_script.ts`：`ExecScript`、`new Function`、sandbox context。
- `src/app/service/content/create_context.ts`：按 grant 构建 context。
- `src/app/service/content/utils.ts`：`compileScriptCode()`、`compileInjectScript()`、`compilePreInjectScript()`。
- `src/app/service/content/gm_api/gm_api.ts`：GM API 实现与装饰器。
- `src/pkg/utils/url_matcher.ts`：URL 规则解析/匹配。
- `src/app/service/service_worker/script.ts`：安装/更新/DNR 重定向/草稿。
- `src/pages/install/App.tsx`：安装页信息架构。
- `src/pages/options/routes/ScriptEditor/*`：编辑器/设置/值/资源面板。
- `src/pages/popup/App.tsx`：popup 信息架构。

---

## 20. 一句话总结

**用 `chrome.userScripts` 每脚本声明式注册，MAIN 世界执行 + USER_SCRIPT Host 桥接，SW 统一管理数据与特权 API；安装走 DNR 重定向 + 草稿确认，编辑器以 CodeMirror 为核心，Popup 做当前页控制台，Options 做完整管理器。**
