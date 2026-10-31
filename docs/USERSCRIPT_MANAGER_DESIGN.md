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

### 1.1 文档生命周期

`pagehide` 不是终态信号。进入 back/forward cache 的文档被**冻结**而非销毁：JS 域、`MessageChannel` 端口与 `chrome.runtime` 端口都保留，而且恢复时**不会重新注入**任何 content script / userScript。因此三个运行时组件（bridge、BridgeClient、engine）统一使用 `lib/runtime/lifecycle.ts` 的三态模型：

```
            pagehide(persisted=true)
   active ─────────────────────────────▶ suspended（空操作）
     ▲                                       │
     └──────── pageshow(persisted=true) ─────┘

   active/suspended ── pagehide(persisted=false) ──▶ terminated（一次性终态）
```

不变式：

1. **suspend 必须是空操作。** 浏览器可能先派发 `pagehide(persisted=true)` 再拒绝缓存该页（此时没有 `pageshow`），任何破坏性动作都会留下悬挂状态。
2. **terminate 最多一次且不可逆。** `persisted` 缺失（无 bfcache 环境）按真正卸载处理，与旧行为一致。
3. **resume 只由 `pageshow(persisted=true)` 驱动。** 新文档的首次 `pageshow` 是 `persisted=false`，必须忽略，否则注册会被重放两次。
4. **恢复只能靠幂等重放，不能靠重新注入。** 页面被从 bfcache 驱逐或关闭标签页时不会再派发事件，清理依赖浏览器与端口 `onDisconnect`。

恢复路径（两条路径最终都汇聚到 `BridgeClient.onResume`，engine 只实现一个重放动作）：

| 场景 | 恢复动作 |
| --- | --- |
| bfcache 往返，端口健康 | 无动作（零抖动，不产生多余 RPC） |
| bfcache 往返，worker 曾被回收 | bridge `host:ping` 探活 → 立即重连 → `BRIDGE_RESUME` → 重放 |
| bfcache 往返，引擎通道丢失 | BridgeClient 重建握手 → `onResume` → 重放 |
| 从未建立过通道的文档 | 保持惰性，不唤醒 worker |
| 冻结期间扩展被重载 | bridge 进入终态，引擎按 `BACKGROUND_UNAVAILABLE` 处理 |

重放内容是瞬态注册（`GM_registerMenuCommand`）：`lib/background/menus.ts` 按 `(tab, frame, uuid, id)` 覆盖写入，因此重放幂等，且只有标签真正变化时才广播。

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

`lib/page-access.ts` 是「页面能否注入」的唯一判定：`chrome://`、`chrome-extension://`、`devtools://`、`view-source:`、Web Store 等特权页面一律不可注入。`urlMatches()` 在匹配规则前先做该判定，因此 popup 列表、host RPC 守卫与运行时启动器不会出现「列表说有、实际不执行」的分歧。`file://` 还需扩展具备「允许访问文件网址」，由 `getPopupData()` 异步确认。

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
- 菜单命令经由 host 注册并在 popup 中列出。注册按 `(脚本, 命令 id)` 跨帧合并：同一条命令在 top 与 iframe 里各注册一次，popup 只显示一行，调用时依次投向 top 帧与注册过该命令的其它帧（`lib/background/menus.ts`）。命令 id 取 `options.id` 或标题，因此跨帧稳定。事件端口在 SW 被回收后重连并重放注册。

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
| `chrome.storage.session` | `injectedFrames`（每个 tab 已上报启动的脚本 id） | 仅后台可读，随浏览器会话结束清空；用于 service worker 重启后恢复角标 |
| IndexedDB | `scripts`、`code`、`versions`、`values`、`resources`、`logs`、`drafts`、`icons` | 会增长的数据，禁止塞进单个 storage key |

备份导出为 JSON 或 ZIP，包含脚本、代码、覆盖、值、资源、回收站与可导出设置；不导出 `runtimeSecret`，也不导出智能体允许列表。导入先在页面侧解析并展示预览，由用户选择同名脚本的覆盖/跳过策略与是否恢复设置，结果按导入/跳过/失败分组返回。

## 8. 界面结构

- **Popup**：全局注入开关 → 当前页面只读条（域名 / 本页脚本数）→ 脚本行。作用域分离是硬规则。不可注入页面显示权限空态，不给虚假的脚本列表。脚本行首是脚本自己的 `@icon`（后台缓存，缺失时用矢量兜底）。
- **工具栏角标**：扩展图标上显示当前页面实际运行的脚本数 —— 引擎在脚本体执行前上报 `host:run`，background 按 tab 跨帧去重后计数，再与「已启用 / 未回收」求交集（`lib/background/injected-state.ts`）。主文档 commit 时清零并丢弃角标缓存（Chrome 会在新文档提交时清空 per-tab 角标）。0 时不画，>99 为 `99+`，跟随主题色；可在 外观 → 界面 关闭（`showBadge`）。
- **Options**：导航顺序为 `#/scripts`、`#/settings/:section`、`#/appearance`、`#/logs`、`#/about`（日志紧靠关于：两者都是诊断/构建信息面），编辑器为 `#/script/:uuid`。
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
