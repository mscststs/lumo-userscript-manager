# Lumo Userscripts — 架构说明

> 目标：Chrome MV3 原生、可长期维护的用户脚本管理器。
> UI 规范见 [`DESIGN.md`](DESIGN.md)；本文只描述运行时、数据与安全边界。

---

## 1. 运行时拓扑

```
Service Worker（唯一数据/权限中心）
  ├─ chrome.userScripts 注册表（固定引擎 + 每脚本启动器）
  └─ host RPC（GM API 的扩展特权部分）

页面
  ├─ MAIN world        us-runner（页面世界执行）
  ├─ USER_SCRIPT world us-host  （隔离沙箱执行）
  └─ ISOLATED          bridge（唯一持有 chrome.runtime 的运行时组件）
        ↕ MessageChannel + nonce
     引擎 BridgeClient
```

- **Service Worker**：脚本索引、代码、值、资源、草稿、更新；注册/重注册；跨域请求、Cookie、下载、通知、标签页、剪贴板。
- **引擎**：`us-runner`（`user-scripts/runner.js`）与 `us-host`（`user-scripts/host.js`）是固定注册项，先于所有脚本启动器注册。两个引擎共享 `lib/runtime/engine.ts` 的实现，只有 sandbox 标志与可用全局不同。
- **ISOLATED bridge**：普通 `content_scripts`，`document_start` + `all_frames`。RPC 走 `chrome.runtime.sendMessage`，事件走一条惰性、可重连的 `connect` 端口。
- **USER_SCRIPT 不直接调用 `chrome.runtime`**：即使配置了 `configureWorld({ messaging: true })`，Chromium 仍可能在部分版本返回 `Receiving end does not exist`。所有扩展调用都经 bridge 转发。

## 2. 注册模型

每个启用脚本一个 `chrome.userScripts.RegisteredUserScript`：

| 字段 | 来源 |
| --- | --- |
| `id` | `us-<uuid>` |
| `matches` / `includeGlobs` / `excludeMatches` / `excludeGlobs` | `compileUrlRules()` + `toRegistrationPatterns()` |
| `runAt` | metadata `@run-at` → 设置默认值 → `document_start / document_end / document_idle` |
| `allFrames` | `@noframes` 取反 |
| `world` | `resolveInjectInto()`（见 §3） |
| `js` | `compileLauncher(payload, world)`，启动器 + 脚本体 |

启动器只负责把 payload 交给引擎；引擎未就绪时进入队列，引擎加载后统一 drain。注册表按签名对比，内容未变化时跳过重建，避免页面加载期间无谓的拆装。

## 3. 世界选择与运行时机

| 条件（按优先级） | 结果 |
| --- | --- |
| `@grant unsafeWindow` | `MAIN`（隔离世界无法提供同步的页面对象） |
| 设置「强制沙箱」且有任意 `@grant` | `USER_SCRIPT` |
| `@inject-into content` | `USER_SCRIPT` |
| `@inject-into page` | `MAIN` |
| `@inject-into auto` / 未声明 | 设置默认值，缺省 `MAIN` |

`@run-at` 映射：

| metadata | chrome 注册值 |
| --- | --- |
| `document-start` / `early-start` | `document_start` |
| `document-end` / `document-body` | `document_end` |
| `document-idle` / `context-menu` / 未声明 | `document_idle` |

## 4. 脚本模型与 metadata

- `parseMetadata()` 解析 `// ==UserScript==` 块，输出规范化字段与诊断信息；编辑器实时展示。
- 用户覆盖（`selfMetadata`）与源码分离存储，通过 `mergeMetadata()` 合并，优先级高于源码。
- 相对 `@require` / `@require-css` / `@resource` / `@icon` / `@updateURL` / `@downloadURL` 以安装来源 URL 为基准解析。
- URL 规则编译为四类（match / include / exclude / exclude-match）。`chrome.userScripts` 的 `matches` 只接受粗粒度 pattern，正则 glob 通过 `includeGlobs` 放宽注册，运行时再用 `urlMatches()` 二次校验。

## 5. GM API 与安全

- GM 对象只存在于脚本的 `with` 作用域内，不挂到 `window`；页面任意代码无法直接调用。
- **运行时令牌**：每次注册派生一个 HMAC 令牌，绑定脚本 `uuid` 与 world。background 校验令牌，并从 content script sender 推导 tab/frame，脚本之间不能互调 GM API。
- 值存储按 `storageName`（缺省为 uuid）分区，支持多脚本共享；变更通过事件广播。
- 网络：`GM_xmlhttpRequest` 在 SW 中执行，先校验 `@connect` 允许列表；需要受限头时使用 DNR session rule。`GM_cookie` 走 `chrome.cookies`，`GM_download` 走 `chrome.downloads`。
- 菜单命令经由 host 注册并在 popup 中列出；事件端口在 SW 被回收后重连并重放注册。

## 6. 安装与更新

1. `declarativeNetRequest` 把 `*.user.js` 导航重定向到 `install.html?token=…`（或 `?src=…`）。
2. 草稿写入 IndexedDB `drafts`；安装页展示名称、版本、`@grant`、`@connect`、`@require`、匹配范围、代码预览与告警。
3. `install:commit` 写入脚本与代码、注册运行项；`enabled` 可取消。
4. 更新检查由 `chrome.alarms` 驱动（默认 6 小时，最小 60 分钟），使用条件请求，比较 `@version` 与代码 hash。
5. 自动更新只在权限未变化时静默执行；新增 `@grant` / `@connect` / `@require` 会生成待确认草稿，降级版本必须手动确认。

## 7. 数据分层

| 存储 | 内容 | 约束 |
| --- | --- | --- |
| `chrome.storage.local` | `uiSettings`（外观、语言、执行偏好）、`runtimeSecret` | 有界小数据，可被各上下文监听 |
| IndexedDB | `scripts`、`code`、`versions`、`values`、`resources`、`logs`、`drafts` | 会增长的数据，禁止塞进单个 storage key |

备份导出为 JSON 或 ZIP，包含脚本、代码、覆盖、值与资源；不导出 `runtimeSecret`。

## 8. 界面结构

- **Popup**：全局注入开关 → 当前页面只读条（域名 / 本页脚本数）→ 脚本行。作用域分离是硬规则。
- **Options**：`#/scripts`、`#/script/:uuid`、`#/logs`、`#/settings/:section`、`#/appearance`、`#/about`。
- 脚本编辑器用标签页切换代码 / 元数据 / 值 / 资源 / 信息，不左右分栏。
- 组件与令牌规范见 [`DESIGN.md`](DESIGN.md)。

## 9. 权限

| 权限 | 用途 |
| --- | --- |
| `userScripts` | 动态注册用户脚本 |
| `storage` / `unlimitedStorage` | 设置与有界元数据 |
| `tabs` / `activeTab` / `webNavigation` / `scripting` | 标签页上下文与诊断 |
| `declarativeNetRequest` | 把 `.user.js` 导航重定向到安装页 |
| `cookies` / `downloads` | `GM_cookie` / `GM_download` |
| `notifications` / `contextMenus` / `alarms` / `clipboardWrite` | GM API 与后台任务 |
| `<all_urls>` | 用户配置的用户脚本作用域 |

## 10. 验证

- `npm run compile`：TypeScript 全量检查。
- `npm test`：默认套件无浏览器依赖（元数据、URL 规则、桥接、存储、主题与对比度）。
- `LUMO_E2E=1 npm test -- tests/integration`：真实 Chrome 回归，覆盖两个执行世界、GM 值、菜单、`@require` 与 SW 回收。
