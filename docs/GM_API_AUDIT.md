# GM API 实现审计报告

> 范围：`lib/runtime/gm-api.ts`、`lib/background/gm.ts`、`lib/background/{values,host-service,resources,registry}.ts`、`lib/script/{metadata,url-rules,grants}.ts`、`lib/runtime/engine.ts`
> 对照基线：Violentmonkey `97eb799`、ScriptCat `9d639df` (v1.5.0)、Greasemonkey `6080f91` (4.14)
> 触发案例：B 站脚本 `GM_xmlhttpRequest` 412（已由 `a7116ac` 修复）
> 结论：412 不是孤例，而是「用 `fetch` 复刻 XHR 语义 + 白名单靠人工枚举 + 缺少兼容矩阵验收」这一类问题的第一次显性化。

---

## 0. 实施状态（本轮改造）

已完成，均带测试：

| 项 | 实现位置 | 验证 |
| --- | --- | --- |
| 原生 XHR（readyState/responseXML/upload/document/overrideMimeType/timeout/abort） | `entrypoints/offscreen`、`lib/offscreen/xhr.ts`、`lib/background/offscreen.ts` | `tests/integration/gm-api.e2e.test.ts`（states 含 2/3/4、responseXML 非空） |
| per-request DNR 规则（受限头 / Origin / Cookie / UA） | `lib/background/xhr/header-rules.ts` | `tests/xhr-rules.test.ts`、`tests/integration/xhr-headers.e2e.test.ts` |
| `FormData`/`Blob`/`ArrayBuffer` 请求体 | `lib/runtime/xhr-body.ts` | 单测 + e2e（multipart 与二进制回显） |
| `responseType: json` 非法 JSON → `response = null` | `lib/offscreen/xhr.ts`、`lib/runtime/gm-api.ts` | e2e |
| `GM_getValue`/`GM_getValues` 返回副本 | `lib/runtime/gm-api.ts` | e2e（`{a:99}` → `{a:1}`） |
| `GM_registerMenuCommand` 同步返回 id | `lib/runtime/gm-api.ts` | e2e（`typeof === 'string'`） |
| `GM_setValues`/`GM_deleteValues` 批量 RPC | `lib/runtime/engine.ts`、`lib/background/{values,host-service}.ts` | 单测/类型 |
| `GM_cookie` URL 推导 + HttpOnly 过滤 | `lib/background/cookie.ts` | 单测/类型 |
| `GM_setClipboard` → offscreen | `lib/background/offscreen.ts` | 构建 + e2e |
| `GM_download` headers/anonymous/timeout | `lib/background/download.ts` | 构建 + 单测 |
| `GM_getTab*` → `storage.session` | `lib/background/tabs.ts` | 类型 |
| `GM_info.sandboxMode` → `js`/`raw` | `lib/runtime/gm-api.ts` | 单测 |
| `GM_info.scriptWillUpdate` / `lastModified` | `lib/runtime/gm-api.ts` | 类型 |
| grant 精确暴露 + 后台 grant 校验 | `lib/runtime/gm-api.ts`、`lib/script/grants.ts`、`lib/background/host-service.ts` | 单测 |
| `@grant` 写权限校验 | `lib/background/host-service.ts` | 类型 |
| 通知图标本地化 + `byUser` | `lib/background/notification.ts` | 类型 |
| `GM_openInTab` insert/setParent | `lib/background/gm.ts` | 类型 |
| 资源 Blob URL 缓存/释放 | `lib/runtime/gm-api.ts` | 类型 |
| 默认携带 cookie（`withCredentials` 与 `anonymous` 对应） | `lib/offscreen/xhr.ts` | e2e |
| `@connect` 逐跳重定向校验（越界立即 abort） | `lib/background/xhr/index.ts` | 类型 + 构建 |
| 模块拆分（cookie/download/notification/tabs/offscreen/xhr） | `lib/background/*` | 构建 + lint |

保留的已知取舍（已在 §7 记录）：
- `redirect: "manual"` 无法由 XHR 表达，降级为 `follow`；`error` 已按落地 URL 判定。
- `@grant unsafeWindow` 仍映射到 MAIN world（隔离语义与 TM 不同，属架构决策）。
- 大响应一次性 base64 传输（未分块），超过 ~50MB 会触及消息上限。
- `GM_addStyle`/`GM_addElement` 仍受页面 CSP 约束（与 VM 相同）。

## 1. 结论摘要

| 级别 | 含义 | 数量 |
| --- | --- | --- |
| P0 | 已修复（本次 412） | 1 |
| P1 | 兼容性/正确性缺陷，脚本会直接跑坏或行为错误 | 10 |
| P2 | 语义偏差、健壮性/安全加固 | 15 |
| P3 | 细节差异、文档级不一致 | 8 |

**根因只有五条**（详见 §5）：

1. 网络层用 `fetch()` 代替原生 `XMLHttpRequest`，XHR 的事件/属性语义无法靠补丁复现；
2. 桥接序列化白名单（`serializeXhrOptions`）靠人工枚举，规范里成体系的选项被逐个漏掉；
3. 验收标准是「业务脚本能跑通」，不是「与 TM/VM 的兼容矩阵逐项一致」；
4. 授权与校验只看「初始 URL / 当前匹配」，不看「每次跳转 / 每个 API」；
5. 沙箱与世界模型（`unsafeWindow` → MAIN world）与 TM 的语义相反。

---

## 2. 三家实现横向对比

### 2.1 网络层架构

| 项目 | 请求执行位置 | 请求原语 | 受限头/Origin 处理 | 并发隔离 |
| --- | --- | --- | --- | --- |
| **本仓** | MV3 Service Worker | `fetch()` | 每 host 一条 DNR 规则（`initiatorDomains` + `requestDomains`），租约串行 | 同 host 不同头策略**串行** |
| Violentmonkey | MV3: offscreen document；MV2: background | **原生 `XMLHttpRequest`** | **每请求**一条 DNR 规则：`tabIds: [-1]` + `urlFilter: |xhrUrl|`（URL 带 `#<reqId>` 唯一化），请求结束即删 | 每请求独立规则，可并发 |
| ScriptCat | MV3: SW / offscreen | `fetch` + `XMLHttpRequest` 双策略 | **每请求**一条 DNR 规则：`tabIds: [TAB_ID_NONE]` + `urlFilter` + `requestMethods`，`headerModifierMap` 关联生命周期 | 每请求独立规则，可并发 |
| Greasemonkey | background | `XMLHttpRequest` | 走自身 privileged 层 | 并发 |

证据：

- VM 请求实现：`violentmonkey/src/background/utils/requests.js:178`（`httpRequest`）、`:236-252`（per-request DNR + `callOffscreen('XHRStart')`）、`src/offscreen/xhr.js:24`（原生 XHR）
- VM 扩展 Origin 剥离：`src/background/utils/requests-core.js:107-111`（`name === 'origin' && h.value === extensionOrigin` 时 `continue`）
- VM forbidden header 全表：`src/background/utils/requests-core.js:14-32`
- SC per-request DNR：`scriptcat/src/app/service/service_worker/gm_api/gm_api.ts:810-845`
- SC 双策略：`src/app/service/service_worker/gm_api/gm_xhr.ts:91-138`

### 2.2 我们的修复（`a7116ac`）与两家做法的差距

| 维度 | 本仓现状 | VM / SC | 影响 |
| --- | --- | --- | --- |
| 规则作用域 | `initiatorDomains: [extensionId]` | `tabIds: [-1]`（TAB_ID_NONE） | Firefox 的 `initiatorDomains` 不接受扩展 ID；`tabIds` 三家通用 |
| 并发 | 同 host 不同头策略必须排队 | 每请求一条规则 | 图片/接口混合并发时吞吐下降，租约等待可能被慢请求拖住 |
| 规则粒度 | host + 头签名 | 请求 URL（VM 还加 `#id`） | 同 host 不同路径的不同策略无法同时生效 |
| 请求原语 | `fetch` | 原生 XHR（VM/SC） | 见 §3.1 |

**结论**：`a7116ac` 是正确方向的止血，但 DNR 应当改为 **per-request + `tabIds: [TAB_ID_NONE]`**，否则并发模型和 Firefox 兼容都受限。

---

## 3. 逐项审计

> 本节记录**改造前的状态与证据**，用于说明每个决定从哪来；修复状态以 §0 为准。

### 3.1 `GM_xmlhttpRequest`

#### 3.1.1 已修复（P0）

- 扩展 Origin 导致 WAF 412；`redirect` 选项未透传。

#### 3.1.2 `data` 被 JSON 序列化（P1，严重）

```ts
// lib/background/gm.ts（handleXhr）
body:
  options.data && typeof options.data === 'object'
    ? JSON.stringify(options.data)
    : (options.data ?? undefined),
```

`FormData`、`Blob`、`ArrayBuffer`、`URLSearchParams` 都是 `object`，会走到两条错误路径（已实测，见 §3.13）：

- `FormData`：跨 MessagePort 时 `DataCloneError`，请求根本发不出去，脚本只看到 `onerror`；
- `ArrayBuffer` / `Blob`（可克隆）：到达后台后被 `JSON.stringify` 成 `"{}"`，服务器收到 200/空内容——**静默数据损坏**，比报错更难排查。

上传类脚本（表单、图片、文件）因此全部失效。

- VM 有专门的 `decodeBody()` 处理 `fd` / `usp` / data URL / 二进制（`violentmonkey/src/background/utils/requests.js:264-300`）。
- SC 在 content 侧做 `dataEncode()` 再传（`scriptcat/src/app/service/content/gm_api/gm_xhr.ts` 顶部 import）。

#### 3.1.3 `responseType` 语义（P1/P2）

| 场景 | 本仓 | 原生 XHR / VM | 级别 |
| --- | --- | --- | --- |
| `json` 且响应不是 JSON | 后台 `JSON.parse` 抛错 → 走 `onerror`（实测 `BridgeError: Unexpected token '<'`） | `response = null`，`onload` 正常触发 | P1 |
| `document` | `contentType.includes('html') ? text/html : application/xml` | 按 `text/html`/`xhtml`/`xml`/`svg` 列表解析，失败为 `null`（VM `requests.js:117-130`） | P2 |
| `stream` | 未实现，落回文本 | SC 支持 `ReadableStream` | P3 |
| 未知值 | 原样下发 | 告警并回退 `''`（VM `requests.js:196-199`） | P3 |
| `overrideMimeType` | 序列化了但后台**从未使用** | 原生 XHR 生效 | P2 |

#### 3.1.4 事件模型（P2）

本仓 `makeXhr` 只调用一次 `onreadystatechange`，且 `readyState` 在后台硬编码为 `4`：

```ts
// lib/background/gm.ts base
readyState: 4,
```

- 缺 `readyState = 2 (HEADERS_RECEIVED)` / `3 (LOADING)`；依赖 `onreadystatechange + readyState < 4` 提前读头/流式处理的脚本行为错误。
- **`responseXML` 完全缺失**（TM/VM/SC 都提供；VM `requests.js:86`，SC `gm_xhr.ts:75`）。
- `onloadstart` 收到 `{}`，TM/VM 收到 `readyState = 1` 的完整响应对象。
- 上传进度（`upload.onprogress`）未实现（VM 用原生 XHR 的 `xhr.upload`）。
- `onerror` / `ontimeout` 收到 `{ error }`，缺 `status: 0`、`readyState: 4`、`finalUrl`，脚本用 `status === 0` 判断网络失败时失效。
- `abort()` 后 `onloadend` 只有 `{ error }`；`context` 在错误/中止路径丢失。

#### 3.1.5 `responseHeaders` 格式（P3）

本仓 `name: value\r\n`；SC 注释明确「TM 兼容：使用 `\r\n` 且不包含空白」（`gm_xhr.ts:44-49`），VM 走 `encodeWebRequestHeader`。需实测 TM 后统一，否则 `split(': ')` 的脚本会踩坑。

#### 3.1.6 其他被白名单吞掉的选项（P2/P3）

`serializeXhrOptions` 只放行 10 个键（`lib/runtime/gm-api.ts:66-90`），以下 TM 选项被静默丢弃：

`binary`、`nocache`、`revalidate`、`fetch`、`cookie`、`cookiePartition`、`user`、`password`、`responseCharset`、`anonymous` 之外的 cookie 策略。

其中 `user`/`password` 会被序列化，但后台**从不使用**（fetch 不支持 URL 凭证）；`overrideMimeType` 同上——属于「看着支持、实际无效」的隐性坑。

#### 3.1.7 `anonymous` 与 Cookie（P2）

本仓只做 `credentials: 'omit'`；VM 额外在响应侧删除 `Set-Cookie`（`requests.js:216-220`），并在请求侧移除 `Cookie` 头（`requests-core.js:107-111`）。对「匿名但通过 Set-Cookie 落 cookie」的站点，语义不同。

#### 3.1.8 重定向与 `@connect`（P1 安全）

`requireConnect()` 只校验**初始 URL**，随后 `redirect: 'follow'`：

```ts
// lib/background/gm.ts
requireConnect(script, url, 'GM_xmlhttpRequest', pageUrl);
...
redirect: normalizeRedirect(options.redirect), // follow
```

任何 `@connect api.example.com` 的脚本都能被 302 到 `http://127.0.0.1:...` 或内网地址，绕过 `@connect` 与私有网络策略。`finalUrl` 校验发生在响应之后，且脚本可以不做。

- VM 在 `onBeforeSendHeaders` 每个跳转上重新 `vetUrl`（`requests-core.js:95-105` + `src/background/utils/url.js`）。
- SC 在重定向后重新处理 unsafe headers（`gm_api.ts:1798`）。

#### 3.1.9 DNR 规则作用域与生命周期（P2）

- `initiatorDomains: [extensionId]`：Chrome 实测有效（见 `tests/integration/xhr-headers.e2e.test.ts`），但 Firefox 的 `initiatorDomains` 只接受域名，规则会静默不匹配。
- 同 host 单规则 + 租约：一个慢请求会阻塞同 host 其他头策略的请求（DNR `MAX_HOST_RULES = 100` 时还会触发 LRU 驱逐）。
- 建议对齐 VM/SC：**每请求一条规则**，`tabIds: [TAB_ID_NONE]`，`urlFilter` 用带唯一 fragment 的 URL（VM 做法），请求结束在 `finally` 删除。

### 3.2 存储与 values

| 问题 | 本仓 | 对照 | 级别 |
| --- | --- | --- | --- |
| `GM_getValue` 返回内部对象引用（实测 `{"a":99}`，见 §3.13） | `values[key]` 直接返回（`gm-api.ts:334`） | SC 返回 `customClone(value)`（`gm_api.ts:398-430`）；VM 存 raw 字符串天然隔离（`gm-values.js`） | P1 |
| `GM_getValues()` 浅拷贝 | `{ ...values }`（嵌套仍共享） | SC `customClone` 深拷贝 | P1 |
| `GM_setValues` 非批量 | 逐个 `setValue` → N 次 RPC + N 次监听 | SC 一次 `GM_setValues` 消息（`gm_api.ts:390-396`） | P2 |
| 启动全量拉取 | `host:bootstrap` 返回**全部 values + 全部 resources**（`host-service.ts:118-124`） | VM 用 storage 缓存 + 增量更新（`gm-values.js:13-25`） | P2 |
| `@resource` 内容随 bootstrap 传输 | `resourcesForRuntime()` 全量 | VM 按需由 `GM_getResourceURL` 取 | P2 |
| 写入失败只 log | `void transport.call(...).catch(log)` | TM 会抛/回调错误 | P3 |

`GM_getValue` 引用污染的后果：脚本 `const cfg = GM_getValue('cfg'); cfg.a = 1;` 不调用 `GM_setValue` 也会污染本 frame 缓存，刷新后又变回去——数据层表现不一致。

### 3.3 菜单命令

| 问题 | 本仓 | 对照 | 级别 |
| --- | --- | --- | --- |
| 返回值是 Promise（实测 `[object Promise]`，见 §3.13） | `define('GM_registerMenuCommand', async ...)`（`gm-api.ts:432`） | TM/VM 同步返回 id（VM `gm-api.js:126-137`） | P1 |
| 命令 id | `options.id || title` | VM 相同（`gm-api.js:129-135`） | 一致 |
| 按 title 反查卸载 | 支持 | VM 相同 | 一致 |
| SW 重启后 resume | 支持 | VM/SC 支持 | 一致 |

脚本常见写法 `const id = GM_registerMenuCommand(...); ... GM_unregisterMenuCommand(id)` 会传入 `[object Promise]`，命令无法注销。

### 3.4 样式与资源

| 问题 | 本仓 | 对照 | 级别 |
| --- | --- | --- | --- |
| `GM_getResourceURL` 每次新建 Blob URL，从不 revoke | `gm-api.ts:395-410` | VM 用 `leaseBlobUrl` + 生命周期管理（`offscreen/xhr.js`、`common/util`） | P2（内存泄漏） |
| `GM_addStyle` 返回 thenable 元素 | 已实现 | VM 相同（`gm-api.js:186-192`） | 一致 |
| `GM_addElement` 无 thenable | 直接返回元素 | VM 返回带 `.then` 的元素 | P3 |
| `@require-css` 注入 | 由 bootstrap 处理 | — | 需补 e2e |

### 3.5 通知

| 问题 | 本仓 | 对照 | 级别 |
| --- | --- | --- | --- |
| `image` 直接当 `iconUrl` | `handleNotification` 用 `details.image`（`gm.ts:228-236`） | VM/SC 会先本地化/dataURL（远程 URL 常被 `chrome.notifications` 拒绝） | P1 |
| `onClosed` 的 `byUser` | `onNotificationClosed(id, byUser = false)`；`background.ts` 监听未传该参数 | Chrome 的 `onClosed(id, byUser)` 可传 | P3 |
| `onclick` 触发后清空 | `emitNotificationClick` 里 `callbacks.onclick = undefined` | TM 每次点击都触发 | P3 |
| `GM_updateNotification` 字段 | 原样透传 | Chrome 只接受部分字段，非法字段会导致 update 失败 | P3 |
| 按钮上限 2 | 已 slice(0,2) | Chrome 限制 | 一致 |

### 3.6 下载

| 问题 | 本仓 | 对照 | 级别 |
| --- | --- | --- | --- |
| `headers` / `anonymous` 被忽略 | `chrome.downloads.download({url, filename, saveAs, conflictAction})`（`gm.ts:400-420`） | TM/VM 支持自定义头/匿名（VM `requests.js:38-58` `dlInApi`） | P1 |
| `data:` / `blob:` URL | 不支持（`chrome.downloads` 接受 data URL，但 VM 用 offscreen 处理 blob） | VM `registerDnrBlob` / `leaseBlobUrl` | P2 |
| `ontimeout` 永不触发 | 回调注册了但无事件 | TM 有超时 | P2 |
| `onerror` payload | `{ error }` + download 字段 | TM 给 `{ error, ... }` | P3 |
| 进度 | `downloads.search` 单次 + 变更事件 | VM 有完整进度 | P2 |
| 重定向 | 同 §3.1.8，未逐跳校验 | VM `vetUrl` | P1（安全） |

### 3.7 剪贴板

`GM_setClipboard` 在**页面上下文**执行（`engine.ts` 的 `copyToClipboard`），后台路径直接抛错（`gm.ts:455`）。

- 后台标签页 / 无焦点页面：`navigator.clipboard.writeText` 需要 focus 或权限，`execCommand` 也可能失败 → 静默失败。
- VM / SC 都放到 **offscreen document**（`violentmonkey/src/background/utils/offscreen.js`、`scriptcat/src/app/service/offscreen/gm_api.ts:25-27` `nativePageSetClipboard`）。
- 级别：P1。

### 3.8 `GM_openInTab` / `GM_getTab*`

| 问题 | 本仓 | 对照 | 级别 |
| --- | --- | --- | --- |
| `insert` / `setParent` / `openerTabId` | 未实现（只透传 `active`） | TM 支持；VM `tabs.js` 处理 insert/active | P2 |
| `GM_getTab` 数据 | `tabState` 内存 Map（`gm.ts:19`） | TM 存 session store，跨导航/重启保留 | P2 |
| tab 关闭清理 | 无 | VM 有 `clearRequestsByTabId` 类似的清理 | P2 |
| `GM4.openInTab` 返回 Promise\<handle\> | 直接 `Promise.resolve(handle)` | VM 返回 tab 对象 Promise | P3 |

### 3.9 `GM_cookie`（P1）

```ts
// lib/background/gm.ts handleCookie
const target = details.url || `https://${details.domain || ''}${details.path || '/'}`;
requireConnect(script, target, 'GM_cookie', pageUrl);
```

| 场景 | 本仓 | 对照 |
| --- | --- | --- |
| `list({ domain: '.bilibili.com' })` | 不抛错，但 `new URL('https://.bilibili.com/').hostname === '.bilibili.com'`，授权判断作用在畸形 host 上（`hostMatches` 可能误判） | VM 会 `domain.replace(/^\./, '')` 再校验（`cookies.js:81-83`） |
| `list({})`（默认当前页） | `https:///` → `Invalid URL` 抛错 | VM 回退到 `src.url`（`cookies.js:70-78`） |
| httpOnly | 全量返回 | VM 默认过滤，需脚本配置开启（`cookies.js:22-26`） |
| `sameSite` / `hostOnly` / `partitionKey` / `storeId` | 原样透传，无规范化 | VM 有 `SAME_SITE_MAP`、`storeId` 注入 | 
| 授权模型 | `@connect` | VM 用脚本 `@match` 校验（`testScript(targetUrl, script)`） |

### 3.10 `GM_info`

| 字段 | 本仓 | TM/VM | 级别 |
| --- | --- | --- | --- |
| `sandboxMode` | `'raw'` / `'content'`（`gm-api.ts:217`） | TM 只有 `'js'` / `'raw'`；脚本用 `=== 'js'` 分支会走错 | P1 |
| `scriptWillUpdate` | 恒 `true` | 有 `@updateURL`/`@downloadURL` 时才 true | P3 |
| `script.lastModified` | `Date.now()` 每次启动 | 安装/更新时间 | P3 |
| `script.resources` | `{ name, url }` | TM 含 `mimetype` | P3 |
| `script.runAt` | 原始 meta 值 | 规范化值 | P3 |
| `userAgentData` | 直接暴露页面 `navigator.userAgentData` | — | P3 |

### 3.11 元数据与运行时

| 问题 | 本仓 | 对照 | 级别 |
| --- | --- | --- | --- |
| `@grant unsafeWindow` 强制 `MAIN` world | `registry.ts:109-116`：`if (grant.includes('unsafeWindow')) return page/MAIN` | TM 在 sandbox 内提供页面 window 代理，脚本仍在隔离世界 | P2（设计差异：隔离语义不同，详见 §3.12） |
| `@run-at context-menu` | `compile.ts:31-32` 只注册菜单命令，不自动运行 | TM 语义一致 | 已验证正确 |
| `@run-at early-start` | 映射 `document_start` | TM 已废弃，行为近似 | P3 |
| `@grant` 未在后台校验 | `host:gm` 只验 token + 站点匹配（`host-service.ts:127-132`） | VM/SC 按 grant 注册 API，后台按能力校验 | P2（纵深防御） |
| 同一 API 双名暴露 | `@grant GM.xmlHttpRequest` 时 `GM_xmlhttpRequest` 也可用（`gm-api.ts:900-916`） | TM 只暴露 grant 的写法 | P2 |
| `@match`/`@include`/`@exclude` | 已实现 + 二次校验 | — | 一致（需补边界用例） |
| `@noframes` | `window.top !== window` | — | 一致 |
| `@require` 相对 URL / 缓存 | 已实现（`resources.ts`） | — | 一致 |
| `@resource` 二进制 | base64 存储 | — | 一致 |

### 3.12 世界与沙箱（P2 设计差异）

`resolveInjectInto()` 把 `@grant unsafeWindow` 与 `@inject-into page` 都导向 `MAIN`，并用 `sandboxMode: 'raw'`：

- 脚本与页面共享全局，页面可观测/篡改脚本变量；
- 与 TM 的「sandbox + unsafeWindow 代理」语义不同，依赖隔离的脚本行为变化；
- `engine.ts` 的 `unsafeWindow: window` 在 `USER_SCRIPT` 下指向隔离世界的 window，若未来允许该组合会返回错误对象。

---

### 3.13 实测复现记录

用 `.output/chrome-mv3` 构建产物在真实 Chrome 中跑临时 e2e（验证后已删除，不影响仓库），结果：

| # | 用例 | 预期（TM/VM） | 本仓实测 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `data: new FormData()` | multipart body 正常发送 | `DataCloneError: FormData object could not be cloned`，请求未发出 | P1 坐实 |
| 2 | `data: new Uint8Array([104,105]).buffer`（`"hi"`） | 2 字节二进制 | 服务器收到 `{}`，HTTP 200 | P1 坐实（静默损坏） |
| 3 | `responseType:'json'` + HTML 响应 | `onload`，`response === null` | `onerror: BridgeError: Unexpected token '<' ...` | P1 坐实 |
| 4 | `GM_setValue('cfg',{a:1})` → `GM_getValue('cfg').a = 99` → 再读 | `{a:1}` | `{a:99}`（内部缓存被改写） | P1 坐实 |
| 5 | `const id = GM_registerMenuCommand(...)` | `id` 为字符串 | `typeof id === 'object'`，`String(id) === '[object Promise]'` | P1 坐实 |

复现方法：`npm run build && LUMO_E2E=1 npm test -- tests/integration`，或按表中用例写一个新 e2e。

## 4. 测试体系缺口

现有测试（`tests/xhr-header-rules.test.ts`、`tests/integration/xhr-headers.e2e.test.ts`）只覆盖「请求成功 / 头正确」。缺失：

1. **兼容矩阵**：每个 API × 每种重载（callback / Promise / GM4 命名）× 每种响应类型。
2. **事件序列断言**：`loadstart → readystatechange(2|3) → progress → load → loadend` 顺序与 payload 字段。
3. **失败路径**：网络错误、超时、abort、非 JSON 的 `responseType: json`、重定向到未授权域。
4. **隔离性**：页面 JS 无法拿到脚本的 GM 对象；`@grant` 之外 API 不可达。
5. **真实浏览器语义对照**：同一脚本分别在 TM/VM 与本扩展跑同一断言集（可用 Playwright + 三家扩展，或录制成 fixture）。

---

## 5. 根因

| # | 根因 | 表现 |
| --- | --- | --- |
| R1 | **以 `fetch` 复刻 XHR** | readyState/responseXML/upload/document/stream/overrideMimeType 全部无法对齐；每次补一个选项就是一次 412 级别的线上问题 |
| R2 | **白名单式序列化** | `redirect`、`FormData`、`binary`、`user/password` 等靠人工枚举，漏一个就静默失效 |
| R3 | **验收靠业务脚本冒烟** | 没有「API × 重载 × 响应类型」矩阵，缺陷只能等用户撞到 |
| R4 | **授权边界按初始 URL** | 重定向可绕过 `@connect`；后台不校验 grant |
| R5 | **世界模型自创** | `unsafeWindow` → MAIN，与 TM sandbox 语义相反（设计已固化，改动成本高） |

---

## 6. 优化与修复方案

### 阶段 0：把「可验证」补齐（0.5–1 天，无行为变更）

- 新增 `tests/gm-api-matrix.test.ts`：对 `gm-api.ts` 逐 API 断言参数/返回值/回调形态。
- 新增 e2e fixture：`/echo`（已有）+ `/headers`（响应头）+ `/redirect-chain`（跨域跳转）+ `/form-echo`（body 字节）。
- 在 `tests/integration/xhr-headers.e2e.test.ts` 增加：`FormData` body、`responseType: json` 非 JSON、`abort`、`timeout`。

**验收**：新增用例先红后绿；不改动产物行为。

### 阶段 1：P1 快速修复（1–2 天，保持架构）

| 项 | 改动 | 验收 |
| --- | --- | --- |
| `data` 类型 | 在 content 侧编码：`FormData` → 序列化条目 + boundary；`Blob/ArrayBuffer` → base64；`URLSearchParams` → 字符串；其余 `JSON.stringify` 仅限普通对象 | `/form-echo` 收到正确字节 |
| `GM_registerMenuCommand` 同步返回 | 本地 id 同步生成并返回；注册 RPC 改用 `.then` 异步补偿（失败时 log + 卸载） | `const id = GM_registerMenuCommand(...)` 可直接传给 unregister |
| `GM_getValue` 隔离 | 返回深拷贝（`structuredClone`），或按 VM 存 raw 字符串 | 修改返回值不污染缓存 |
| `GM_cookie` 目标推导 | `domain` 去前导点；缺省回退当前页 URL；`list` 默认过滤 httpOnly | 新增 cookie 单测 + e2e |
| `GM_info.sandboxMode` | 输出 `'js'`（隔离世界）/`'raw'`（MAIN） | 单测 |
| `@run-at context-menu` | 注册但**不自动注入**，仅菜单触发 | e2e：页面加载后脚本未运行，点菜单后运行 |
| `GM_setClipboard` | 迁移到 offscreen document（见阶段 2 共用） | 后台标签页可复制 |
| `@grant` 双名暴露 | `@grant GM.xmlHttpRequest` 时同步暴露 `GM_xmlhttpRequest`（`gm-api.ts:900-916`） | 单测：只暴露 grant 的写法 |
| `GM_notification` 图标 | 远程 `image` 先 fetch 成 data URL；失败回退扩展图标 | 单测 |
| 错误对象 | `onerror`/`ontimeout` 补 `status: 0`、`readyState: 4`、`finalUrl`、`context` | 矩阵测试 |
| `responseType: json` | 解析失败返回 `response = null`，不触发 `onerror` | 矩阵测试 |

### 阶段 2：网络层重构（推荐，3–5 天）

**目标**：用 offscreen document + 原生 XHR 复刻 XHR 语义，per-request DNR 解决头与并发。

1. manifest 增加 `offscreen` 权限（用途：原生 XHR 事件、剪贴板、Blob URL；符合「新增权限必须说明用途」）。
2. 新增 `lib/background/offscreen.ts` + `lib/offscreen/xhr.ts`（参考 VM `src/offscreen/xhr.js`）：
   - `XHRStart` / `XHRStop` / `XHR` 事件转发（`loadstart`、`readystatechange`、`progress`、`load`、`loadend`、`abort`、`timeout`、`upload.*`）；
   - 响应分块传输（VM 的 `TEXT_CHUNK_SIZE` / `CHUNK_SIZE` 策略），避免大响应阻塞消息通道。
3. DNR 改为 per-request：
   - `condition: { tabIds: [TAB_ID_NONE], urlFilter: '|' + urlWithMarker + '|' }`
   - `action.requestHeaders` = 移除/设置 `origin`、`referer`、`user-agent`、`sec-ch-ua*`、`cookie`
   - `anonymous` 时额外 `responseHeaders: remove set-cookie`
   - 请求结束 `finally` 删除规则；SW 重启用 `getSessionRules()` 回收。
4. 保留 `redirect`、`data`、`overrideMimeType`、`user/password`（`Authorization: Basic`）。
5. 重定向逐跳校验：在 offscreen XHR 的每次 `readystatechange(2)` 检查 `responseURL`，不匹配 `@connect` 立即 `abort`。

**验收**：`tests/integration/xhr-headers.e2e.test.ts` 全绿 + 新事件序列断言；TM 对照脚本行为一致。

### 阶段 3：存储与生命周期（2 天）

- values 侧：`GM_setValues` 批量消息；`GM_getValues` 深拷贝；启动只拉取 `meta`，values 按需/缓存（参考 VM `gm-values.js`）。
- `GM_getTab/saveTab/getTabs` 迁移到 `chrome.storage.session`，tab 关闭清理。
- `GM_getResourceURL` 加 Blob 租约（引用计数 + 定时 revoke）。
- `GM_download`：支持 `headers`/`anonymous`（走 offscreen XHR + blob 下载），`ontimeout`，逐跳校验。

### 阶段 4：权限与沙箱（2–3 天）

- `host:gm` 增加 grant 校验（从 DB 读 `effective grant`），未知 API 返回 `NOT_GRANTED`。
- 单一授权名：`@grant GM.xmlHttpRequest` 只暴露 `GM.xmlHttpRequest`；`GM_xmlhttpRequest` 只在显式 grant 时暴露。
- 沙箱模型二选一：
  - **A（推荐）**：`unsafeWindow` 只在隔离世界提供页面 window 代理（经 `postMessage` 转发），不再强制 MAIN；
  - **B**：保留 MAIN 但把 `sandboxMode` 报为 `'raw'` 并在 UI 明示「无隔离」。
- `@inject-into`/`forceSandbox` 与 `unsafeWindow` 的优先级矩阵化并加测试。

### 阶段 5：兼容矩阵与 CI（持续）

- 建立 `docs/GM_API_COMPAT.md`：API × 重载 × 语义 × 状态（对齐/偏差/未实现）。
- e2e 增加「同一脚本在 TM/VM 与本扩展」三路对照（可选 nightly，标记 `LUMO_E2E_COMPAT=1`）。
- 每个 P1 修复必须附带一个矩阵用例，禁止无测试修复。

---

## 7. 风险与取舍

| 方案 | 风险 | 缓解 |
| --- | --- | --- |
| offscreen + 原生 XHR | 新增 `offscreen` 权限；offscreen 文档生命周期（`chrome.offscreen` 的 30s 空闲回收） | 请求期间 `keepAlive`；按 VM 的 `keepAlive()` 模式 |
| per-request DNR | 规则数量与创建/删除开销 | 上限 + 复用 + 失败回滚（SC 已踩过 ruleId 泄漏） |
| `tabIds: [TAB_ID_NONE]` | 仅匹配非标签页请求，需确认 offscreen/SW 请求都属于该集合 | VM/SC 已生产验证 |
| Firefox | `offscreen` 不适用；`initiatorDomains` 不支持扩展 ID | 分支：Firefox 用 background XHR + `webRequest`/`tabIds` |
| 保持 fetch + 补事件 | 成本高、易漏、永远追不上原生语义 | 不建议 |

---

## 8. 证据索引

| 主题 | 本仓 | 开源对照 |
| --- | --- | --- |
| XHR 实现 | `lib/background/gm.ts:handleXhr` | VM `src/background/utils/requests.js:178`；SC `gm_xhr.ts` |
| 请求体 | `lib/background/gm.ts:111-114` | VM `requests.js:264-300`（`decodeBody`） |
| 响应类型 | `lib/background/gm.ts:145-175`；`lib/runtime/gm-api.ts:94-120` | VM `requests.js:96-140`；SC `gm_xhr.ts:70-140` |
| 事件模型 | `lib/runtime/gm-api.ts:665-735` | VM `src/offscreen/xhr.js:24-120` |
| DNR 规则 | `lib/background/xhr-header-rules.ts` | VM `requests.js:232-252`；SC `gm_api.ts:810-845` |
| 受限头 | `lib/background/xhr-header-rules.ts:26` | VM `requests-core.js:14-32` |
| Cookie | `lib/background/gm.ts:handleCookie` | VM `cookies.js:65-89` |
| 菜单 | `lib/runtime/gm-api.ts:432-470` | VM `src/injected/web/gm-api.js:126-137` |
| values | `lib/runtime/gm-api.ts:334-370`；`lib/background/values.ts` | VM `gm-values.js`；SC `gm_api.ts:314-460` |
| run-at | `lib/background/registry.ts:79-96` | TM 文档；SC `src/app/service/content/gm_api` |
| world | `lib/background/registry.ts:109-116` | VM `src/injected/web/index.js` |
| grant 校验 | `lib/background/host-service.ts:127-132` | VM `src/background/utils/init.js`（`addPublicCommands` + 脚本能力） |
| 剪贴板 | `lib/runtime/engine.ts:copyToClipboard` | VM `offscreen.js`；SC `offscreen/gm_api.ts:25-27` |
