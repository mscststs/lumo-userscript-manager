# Lumo Userscripts — 设计规范

> 适用范围：`popup`、`options`、`install` 全部扩展页面。
> 实现载体：`assets/globals.css`（令牌与基础层）、`lib/theme-registry.ts`（主题与主题色）、`components/ui/*`（基础组件）、`components/layout/*`（页面骨架）。
> 本文是可执行的规范，不是风格散文。每条规则都对应代码中的位置，改动前先读对应章节。

---

## 0. 设计立场

这个产品是**工具**，不是内容站点。用户带着明确任务打开它：确认某站点上有哪些脚本在跑、改一条匹配规则、把脚本从回收站捞回来。因此：

1. **信息密度优先于留白表演**。屏幕里每一像素都要么承载信息，要么承载可点击的余量。
2. **操作就近于对象**。行内动作贴行，页面动作贴标题，破坏性动作退到菜单。
3. **没有任何一屏需要解释才能使用**。文案只陈述结果与状态，不写操作指令。
4. **动效只解释因果**，不制造惊喜。元素的出现/消失必须能被物理直觉预测。

### 0.1 四条法则的学术依据

| 法则 | 本项目的落地 | 依据 |
| --- | --- | --- |
| 渐进式隐藏 | 批量栏无选中时不存在；popup 搜索框在脚本 ≤5 时不渲染；空态不出现伪 CTA | 认知负荷理论（Sweller, 1988）：与任务无关的元素产生 extraneous load；Hick–Hyman 定律（1952）：选项数与决策时间成正比 |
| 交互归一 | Select / Dropdown / Tooltip 共用同一 popover 表面与进出场；所有危险操作统一走 `ConfirmDialog` | Jakob 定律（Nielsen, 2000）：用户把对其它产品的预期带进来；一致性降低学习成本 |
| 渐进式披露 | 脚本行默认只有状态 + 名称；命令、元数据、版本历史按需展开 | Progressive Disclosure（Nielsen, 2006）；Miller 7±2 与 Cowan 4±1：分组后单屏决策数控制在 4–6 |
| 物理级动效 | 批量栏从底部推入并推动内容；导航指示器用共享 layout 滑动；退场快于入场 | 迪士尼动画原则的 slow-in/slow-out；iOS `UIView` 弹簧阻尼；Material motion 的「容器变换」原则 |

### 0.2 十条可执行原则

1. 一个视图只有**一个** primary 按钮。
2. 可点击区域 ≥ 24×24 CSS px（WCAG 2.2 SC 2.5.8）；行内动作靠整行可点补足。
3. 任何破坏性操作必须二次确认，且默认焦点落在**取消**。
4. 焦点环永不消失。删除 `outline` 视为缺陷。
5. 文本对比度：正文/元数据 ≥ 4.5:1，大字 ≥ 3:1，禁用态豁免但不得低于 3:1。
6. 标签允许换行/换行到下一行，**控件不允许把标签挤成省略号**。
7. 任何加载态必须有与最终内容**同高**的骨架，禁止布局跳动。
8. 长列表的页面标题吸顶；滚动容器独立，避免标题随内容消失。
9. 颜色只从语义令牌取；组件内不出现十六进制、`rgb()`、`hsl()` 字面量。
10. 动画时长 90–240ms；`prefers-reduced-motion` 下全部降为 1ms。

---

## 1. 排版

### 1.1 阶梯

`--text-*` 定义在 `@theme`，单位 rem，随 `<html>` 字号整体缩放（用户字号偏好）。

| Token | px @16 | 行高 | 用途 |
| --- | --- | --- | --- |
| `text-2xs` | 11 | 16px | 元数据、时间戳、徽标、键帽 |
| `text-xs` | 12 | 18px | 辅助说明、次级按钮、日志正文 |
| `text-sm` | 13 | 20px | **正文默认**、列表标题、控件文字 |
| `text-base` | 15 | 23px | 强调正文、对话框标题 |
| `text-lg` | 17 | 24px | 品牌名、卡片大标题 |
| `text-xl` | 20 | 26px | 页面标题（唯一） |
| `text-2xl` | 24 | 30px | 保留，仅空态插画标题可用 |

阶梯近似 1.125–1.2 的模数（Bringhurst 的 modular scale），并额外插入 11px 一档：脚本管理器里「大小 / 版本 / 时间」必须能读，但不能与名称竞争。

### 1.2 规则

- 行宽：说明文字上限 `68ch`（正文）与 `62ch`（设置项描述）。超过 75ch 后眼跳回扫成本显著上升。
- `text-balance` 只用于 ≤2 行的标题；`text-pretty` 用于段落，避免孤字。
- 数字一律 `tabular-nums`（时间、计数、版本、行号）。
- CJK 字体栈置于 sans 末尾：`PingFang SC → Hiragino Sans GB → Microsoft YaHei UI → Noto Sans CJK SC`。中文不做负字距（`tracking-tight` 只用于拉丁标题）。
- 等宽：`ui-monospace → SF Mono → JetBrains Mono → Menlo → Consolas`，用于 URL、`@match`、代码、键帽。
- 字重仅用 400 / 500 / 600；`font-synthesis-weight: none` 防止伪粗体。

---

## 2. 色彩系统

### 2.1 为什么是 OKLCH

所有颜色使用 **OKLCH**（CSS Color 4；Chrome 111+，本项目最低 Chrome 138）。理由：

- OKLCH 的 L 是感知亮度，`L=0.5` 在红/绿/蓝上看起来一样亮。HSL 的 `L=50%` 在黄色上刺眼、在蓝色上发闷，无法建立统一的明暗阶梯。
- 暗色主题可以按**亮度**分层（页面 → 卡片 → 浮层 → hover），而不是给一个灰底不断叠半透明黑，后者会糊成一片。
- 主题色只需换色相 `H`，明度与彩度由主题控制，因此 5 个主题色 × 3 套主题不会出现「某个色在暗色下看不清」。

### 2.2 三层令牌

```
primitive（不直接使用）
  └ semantic（--color-background / --color-primary / …）
      └ component（组件只消费 semantic，禁止自造颜色）
```

语义令牌清单见 `assets/globals.css` 的 `@theme` 块。新增颜色必须先回答：「它属于哪个语义？」不能回答就不要加。

### 2.3 主题骨相

| ID | 名称 | Scheme | 背景 | 卡片 | 定位 |
| --- | --- | --- | --- | --- | --- |
| `light` | 纸白 Paper | light | `oklch(0.985 0.002 95)` | `oklch(1 0 0)` | 暖中性白，长时间阅读 |
| `dark` | 石墨 Graphite | dark | `oklch(0.168 0.004 270)` | `oklch(0.205 0.004 270)` | 近黑中性，弱光最安静 |
| `midnight` | 午夜 Midnight | dark | `oklch(0.196 0.018 262)` | `oklch(0.232 0.02 262)` | 冷蓝暗色，层级更分明 |

暗色分层顺序（必须保持单调递增）：`background < sidebar < card < popover < muted/accent`。边框亮度高于所有表面，否则卡片边界消失。

### 2.4 主题色轴

`--accent-h`（色相）、`--accent-c`（彩度）、`--accent-l`（仅亮色主题的明度）是唯一变量：

```css
[data-accent="emerald"] { --accent-h: 162; --accent-c: 0.135; --accent-l: 0.535; }
--color-primary: oklch(var(--accent-l) var(--accent-c) var(--accent-h));
```

| 预设 | H | C | L（亮） | 白字对比 |
| --- | --- | --- | --- | --- |
| azure 蔚蓝 | 258 | 0.170 | 0.552 | 4.90 |
| violet 紫罗兰 | 296 | 0.175 | 0.552 | 5.19 |
| emerald 翡翠 | 162 | 0.135 | 0.535 | 4.73 |
| amber 琥珀 | 70 | 0.135 | 0.552 | 4.94 |
| rose 玫红 | 18 | 0.175 | 0.552 | 5.28 |

> 单个全局 L 无法服务所有色相：翡翠在 0.552 时白字只有 4.42:1，刚好低于 AA。因此 `--accent-l` 是逐色相可调项，而不是常量。`tests/design-tokens.test.ts` 会为每个主题色重算对比度。

暗色主题的 primary 固定 `L=0.78`、彩度 ×0.78、标签用 `L=0.185`，实测 8.7–9.7:1。

### 2.5 实测对比度

由 `tests/design-tokens.test.ts` 在 OKLCH → linear sRGB 上计算（WCAG 相对亮度）。

| 组合 | 纸白 | 石墨 | 午夜 |
| --- | --- | --- | --- |
| foreground / background | 17.17 | 17.18 | 16.16 |
| muted-foreground / background | 5.76 | 7.56 | 7.77 |
| card-foreground / card | 17.93 | 16.04 | 14.88 |
| destructive（实心按钮） | 5.55 | 7.38 | 7.38 |
| success | 4.98 | 8.62 | 8.62 |
| warning | 5.12 | 9.57 | 9.57 |

规则：任何新增语义色必须同时提供 `-foreground`，并把这一对加进对比度测试。

### 2.6 语义色使用规则

- `primary`：页面唯一主操作、选中态强调、focus ring。
- `destructive`：删除/清空。仅在实心按钮上使用 `-foreground`；作为文字时用 `text-destructive`（亮色 5.5:1，暗色 7:1）。
- `success` / `warning`：状态徽标与 toast，不用于大面积背景。
- Tint 规则：`bg-<color>/10` + `border-<color>/25` + `text-<color>`。禁止 `bg-primary/50` 这类会破坏对比的中间值。
- 遮罩 `--color-overlay` 永远是暗色半透明，亮度 < 0.25；亮色 α≈0.42，暗色 α≈0.66（暗底上同样的 α 几乎看不出压暗）。

---

## 3. 主题工程

### 3.1 偏好与调色板分离

用户回答的是三个独立问题，存储也必须是三个字段：

| 字段 | 取值 | 回答 |
| --- | --- | --- |
| `theme` | `light` / `dark` / `system` | 亮暗偏好 |
| `darkTheme` | `dark`（石墨） / `midnight`（午夜） | 解析为暗色时用哪套 |
| `accent` | azure / violet / emerald / amber / rose | 强调色相 |

旧模型把 `system` 塞进调色板联合里，导致「跟随系统，但系统变暗时用午夜」无法表达。
迁移时 `theme: 'midnight'` 会被规范化成 `{ theme: 'dark', darkTheme: 'midnight' }`，
用户的选择不会丢。

解析结果落在一个具体调色板上：

```
<html class="dark" data-theme="midnight" data-accent="violet">
```

- `.dark`：驱动 Tailwind `dark:` 变体与 Shiki/CodeMirror 暗色分支。
- `data-theme`：选择具体调色板块（`.dark[data-theme="midnight"]`）。
- `data-accent`：只切色相变量。

`theme` / `darkTheme` **不出现在 DOM 上**：DOM 只描述“现在画的是哪套”，
偏好由 `resolveTheme(mode, darkTheme)` 在应用层解析。

### 3.2 单一真相

`lib/theme-registry.ts` 是唯一注册表：

```ts
THEMES[palette] = { scheme, labelKey, descriptionKey, background, swatch }
ACCENTS[name]   = { labelKey, hue, chroma, lightness }
THEME_MODE_OPTIONS  = light | dark | system
DARK_THEME_OPTIONS  = dark | midnight
```

- `background` 必须与 CSS `--color-background` **逐字相同**，测试会比对字符串。
- `labelKey` 由类型系统强制存在，新增主题不改 i18n 无法编译通过。
- `tests/theme.test.ts` 断言每个暗色调色板重新声明了全部 `--color-*`，防止「漏一个 token → 暗色下白字白底」。

### 3.3 首帧防闪烁

`chrome.storage` 是异步的，赶不上首帧。链路：

1. `public/theme-preload.js`（classic script，`head-prepend`，由 `themePreloadPlugin` 注入）同步读 `localStorage` 镜像；
2. 镜像内容是 `{ name, dark, background }` —— **携带背景色本身**，因此 preload 不需要内置调色板表，不会与 CSS 漂移；
3. `applyTheme` 在 React 之后接管：清掉内联背景、把控制权交回样式表、写入新镜像；
4. CSS 兜底：`@media (prefers-color-scheme: dark) { html:not([data-theme]) { … } }`。

字号同理：`lumo-us:font-size` 镜像 → preload 写入 `root.style.fontSize`。

### 3.4 新增主题 / 主题色

新增**亮色**调色板（目前只有 Paper）：

1. `types/index.ts` 扩展 `ResolvedTheme`；
2. `theme-registry.ts` 增加定义（TypeScript 强制补 label/description/swatch）；
3. `globals.css` 增加 `[data-theme="…"]` 块，必须重声明全部 `--color-*`；
4. 在 `resolveTheme` 的 light 分支里可选；
5. `public/theme-preload.js` **不需要改**（只认镜像我）；
6. 跑 `theme.test.ts` + `design-tokens.test.ts`。

新增**深色**调色板：

1. 以上 1–3 步；
2. `types/index.ts` 的 `DarkTheme` 联合加入该 id；
3. 加入 `DARK_THEME_OPTIONS`（`theme-registry.ts` 里按数组列出）；
4. 不需要改 `theme-preload.js`；外观页会自动多出一张卡。

主题色：

1. `types/index.ts` 扩展 `AccentColor`；
2. `theme-registry.ts` 增加 `{ hue, chroma }`；
3. `globals.css` 增加 `[data-accent="…"]` 三个变量；
4. 对比度测试会自动覆盖新色。

---

## 4. 形状与层级

### 4.1 圆角

| Token | 值 | 用途 |
| --- | --- | --- |
| `rounded-md` | 6px | 徽标、菜单项、键帽 |
| `rounded-control` | 8px | 按钮、输入框、Select、开关容器 |
| `rounded-card` | 12px | 卡片、对话框、Aside 面板 |
| `rounded-popover` | 12px | Select / Dropdown / Tooltip 面板 |
| `rounded-full` | ∞ | Switch 轨道、头像、计数点 |

圆角表达**归属**：控件之间可以共用 8px；卡片必须比内部控件更圆，否则卡片与控件会读成同一层（Gestalt: common fate / similarity）。

### 4.2 边框

- 统一 1px，颜色取 `--color-border`；输入框用 `--color-input`（更深一档）以表达可编辑。
- hover 时输入框边框过渡到 `muted-foreground/50`，不改变宽度（避免 1px 抖动）。
- 分隔线只用 `divide-y` / `Separator`，不使用 margin 假装分隔。
- HiDPI：2dppx 下浏览器会把 1px 渲染为 2 物理像素，视觉偏粗。本项目的做法是**保持 1px 但降低对比**（`border` 与背景的 L 差约 0.08），而不是用 0.5px（在某些缩放下会消失）。阴影在暗色下改为更紧、更不透明的落影。

### 4.3 阴影与 z-index

| Token | 用途 |
| --- | --- |
| `shadow-elev1` | 卡片悬浮、Switch 拇指 |
| `shadow-elev2` | Popover / Dropdown / Tooltip / Toast |
| `shadow-elev3` | Dialog、批量操作条 |

阴影通过 `@utility` 读取运行时变量，因此暗色可以替换为更硬的落影（软灰色阴影在近黑表面上不可见）。

层级约定：

| z | 层 |
| --- | --- |
| 10 | 行内浮层（下拉菜单触发） |
| 20 | 吸顶页头 |
| 30 | 批量操作条 |
| 50 | Dialog / Popover portal |
| 70 | Toast |

---

## 5. 动效

### 5.1 曲线与时长

| Token | 值 | 场景 |
| --- | --- | --- |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 常态过渡：hover、颜色、宽度 |
| `--ease-emphasis` | `cubic-bezier(0.16, 1, 0.3, 1)` | 入场：Dialog、Popover、Toast、批量条 |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | 退场：比入场短 25–40% |

时长：hover 100–150ms；展开 180–200ms；对话框 160–180ms；退场 90–120ms。Doherty 阈值（400ms）是上限，不是目标。

### 5.2 场景表

| 场景 | 实现 | 说明 |
| --- | --- | --- |
| Dialog | 遮罩淡入 160ms；面板 `scale .97 → 1` 180ms | 居中由 flex 布局完成，keyframe 只碰 opacity/transform |
| Popover | 按 `data-side` 从触发方向位移 4px + 缩放 .985 | 空间关系可读 |
| Toast | 底部上移 8px + 淡入；列表用 `layout` 推动 | 出现不遮挡主内容 |
| 折叠 | 高度 + 透明度；`ease-standard` | 关闭时高度归零，后续元素上移 |
| 导航指示器 | motion `layoutId` + spring(520, 40) | 一个物体滑动，而非两个按钮闪烁 |
| 页面切换 | View Transitions（`page-content`） | 旧页淡出 90ms，新页淡入 160ms；React 用 `flushSync` 保证 DOM 在回调内提交 |
| 批量条 | 从底部 16px 推入 | 与「从底部出现」的方向一致 |

### 5.3 降级

- `prefers-reduced-motion: reduce`：CSS 动画全部 1ms；`MotionConfig reducedMotion="user"` 关闭布局动画；View Transitions 直接跳过。
- 动画**永不阻塞导航**：`startViewTransition` 缺失时同步提交。

---

## 6. 组件规范

### 6.1 Button

| variant | 用途 | 背景 | 文字 |
| --- | --- | --- | --- |
| `default` | 每视图唯一主操作 | `primary` | `primary-foreground` |
| `outline` | 与内容并列的次级操作 | `card` + border | `foreground` |
| `ghost` | 行内 / 工具栏 / 图标 | 透明，hover `accent` | `muted-foreground → foreground` |
| `secondary` | 已激活的切换态 | `secondary` | `secondary-foreground` |
| `destructive` | 确认删除 | `destructive` | `destructive-foreground` |
| `link` | 正文内跳转 | 透明 | `primary` |

尺寸：`xs` 24 / `sm` 28 / `default` 32 / `lg` 40 / `icon` 32×32 / `iconSm` 28×28。
状态：`hover` 背景过渡 150ms；`active` `scale(0.98)`；`disabled` opacity 45% 且 `pointer-events: none`；`focus-visible` 全局 2px ring + 2px offset。

### 6.2 表单控件

- 高度统一 32px（`h-8`），字号 13px，内边距 10px。
- `Input` / `Textarea` / `Select` 表面用 `background`（在 `card` 上是「挖洞」），hover 边框加深，focus 由全局 ring 表达。
- `Switch`：默认 36×20，`sm` 28×16；拇指恒为近白（物理反光件），轨道 off 用 `input`（暗色下必须可见）。
- `Checkbox`：16px 视觉框 + 28px 命中区，ARIA checkbox，支持 `mixed`。
- 标签关联：`SettingRow` 的 `htmlFor` 指向控件；无 `htmlFor` 时用 `aria-label`。

### 6.3 分段与标签

| 形态 | 语义 | 用法 |
| --- | --- | --- |
| `Segmented`（滑块） | **原地**的互斥选择（2–5 项） | 脚本筛选、日志等级、外观模式 |
| `SectionNav`（下划线 tab） | 切换到**另一份文档** | 设置页分区、编辑器（代码 / 元数据 / 值 / 资源 / 信息） |

两者形状必须不同：同形不同义会让用户必须先读文字才能预判点击后果。筛选与偏好
都可以是“原地选择”，但**页面级分区永远是 tab**，且绝不放进页头 `actions` 槽
（那里只放动作）。

### 6.4 容器

- `Card`（flat）：边框 + `card` 表面。设置分组、列表容器默认用它。
- `Card`（elevated）：+ `elev1`。仅用于悬浮在页面之上的独立内容。
- `SettingsGroup`：小号大写标题 + 一列用 `divide-y` 分隔的 `SettingRow`。分组宽度受限（≤74rem 内容区）。
- `SettingRow`：标签 + 说明在左（`basis-52`），控件在右；空间不足时整行换行，**控件换行而不是标签截断**。

### 6.5 反馈

- `Toast`：设置保存、批量结果、导出完成。成功 3s 自动消失，错误 6s；`aria-live="polite"`，错误 `role="alert"`。
- `ConfirmDialog`：删除脚本、清空日志、彻底删除。`role="alertdialog"`，默认焦点在取消。
- `EmptyState`：一个图标 + 一句状态 + 可选真实动作。禁止「点击这里开始」。
- `Skeleton`：与真实行同高；`motion-reduce` 停止脉冲。
- 内联错误：`role="alert"` + destructive tint + 可关闭；不占用 toast 队列。

### 6.6 列表行

脚本行是产品的核心单元：

```
[switch] [名称 · 版本 · 徽标]        [版本] [更新时间] [switch][菜单]
         [命名空间 · 大小 · @match]
         [错误行（如有）]
```

- 整行 hover `muted/40`；选中行 `primary/6`。
- 行内动作只保留 `⋯` 一个入口。脚本的启用状态只影响**下一次页面加载**；本产品不
  提供“手动补注入”，避免同一脚本在同一页执行两次（对非幂等脚本有破坏性）。
- 行内动作默认 60% 不透明度，hover 100%（降低视觉噪音，但保持可发现）。
- 列宽由**同一个 grid 模板**驱动表头与行，禁止两套 flex 布局。

### 6.7 代码

- CodeMirror 主题按 `.dark` 切换（github light/dark）；容器背景 `--color-code-bg`。
- Shiki 输出同时带 `--shiki-dark`，由 `.dark` 覆盖。
- 代码字号继承 `--font-mono` 与 rem 缩放。

---

## 7. 响应式

### 7.1 断点策略

优先 **container query / flex wrap**，其次才是媒体查询。

| 场景 | 行为 |
| --- | --- |
| Options 导航 | `<768px` 固定 56px 图标栏；`≥768px` 224px，可折叠到 56px |
| Options 内容 | `max-w-[74rem]` 居中；内边距 20px → 28px |
| 设置项 | 标签 `basis-52`，控件 `shrink-0`；不足则换行 |
| 脚本行 | 移动端 3 列（勾选/主体/动作），`sm` 起 5 列 |
| Popup | 固定 360px 宽；高度 `max-h-600px`，列表在内部滚动 |
| 编辑器 | `lg` 起双栏（1fr + 21rem）；以下单栏堆叠 |

### 7.2 视口单位

- 用 `dvh` 而非 `vh`（移动端地址栏收缩不再造成裁切）。
- Options 根容器 `h-dvh`；弹窗 `max-h-[calc(100dvh-3rem)]`。

### 7.3 HiDPI

- 图标使用矢量（lucide），不依赖位图。
- 1px 边框保持逻辑 1px，通过颜色差而非宽度表达边界。
- 阴影在 2x 下不会变模糊到消失（暗色使用更紧的落影）。

---

## 8. 可访问性

| 要求 | 实现 |
| --- | --- |
| 焦点可见（2.4.7 / 2.4.13） | 全局 `:focus-visible` 2px ring + 2px offset；仅 `role=listbox/menu` 豁免 |
| 目标尺寸（2.5.8） | 最小 24px；默认控件 32px；图标按钮 28px |
| 对比度（1.4.3 / 1.4.11） | 见 §2.5；测试强制 |
| 键盘 | Dialog 焦点陷阱（Radix）；Segmented 支持 ←/→；Switch/Checkbox 空格 |
| 语义 | `role="list/listitem"`、`aria-current="page"`、`aria-checked`、`aria-live` |
| 动效 | 尊重 `prefers-reduced-motion` |
| 强制颜色 | `forced-colors: active` 下改用系统 `Highlight` |
| 高对比 | `prefers-contrast: more` 加强边框与次要文字 |

---

## 9. 国际化与文案

- 所有可见文案来自 `i18n/{en,zh}.ts`；`tests/i18n-keys.test.ts` 保证两套 key 完全一致。
- 文案只描述**状态与结果**：`已启用`、`脚本已安装`、`没有符合筛选条件的日志`。
- 不写操作指令（「请点击这里」「在此输入」）。
- 溢出：所有可能变长的文本节点带 `min-w-0` + `truncate` 或 `line-clamp`；按钮文字 `whitespace-nowrap`，由 `flex-wrap` 承担换行。
- 枚举值必须本地化（`document-idle` → 文档空闲 / Document idle），技术标识（`@grant`、URL、权限名）保持原文。

---

## 10. 页面蓝图

### 10.1 Popup（360px）

Popup 只有一个屏幕，却同时包含三种作用域。把它们放在**同一条 header** 里，
用户会合理地以为总开关只影响当前站点——这是已经发生过的一次返工。

| 作用域 | 例子 | 位置 |
| --- | --- | --- |
| 扩展全局 | 脚本注入总开关、主题、备份与恢复 | 顶部身份栏 / 设置页（数据） |
| 当前页面 | 域名、本页脚本数 | 独立的只读页面条 |
| 单个脚本 | 启停、运行、命令、编辑 | 脚本行内 |

```
┌ [logo] 脚本注入 · 已启用            [switch] ┐  ← 全局：只控制注入
├ 🌐 github.com                    本页 4 个脚本 ┤  ← 页面：只读上下文
├ 可选：运行时警告 / 错误条                     ┤
├ 可选：搜索（脚本 >5 时出现）                  ┤
│ 脚本行 ×N（switch · 名称 · 授予 · ⋯）         │
│   ⋯ = 编辑 / 配置                              │
├ 新建脚本（sm）          管理 · 设置（带文字）┘
```

规则：**一个控件的作用域必须能从它所在的分区读出来**。全局开关不放在页面
信息条里；页面信息条不承载任何可点击控件（域名不可点，避免「点一下会怎样」）。

### 10.2 Options

```
[导航 56/224px] [──────── 内容 ────────]
                 吸顶页头：标题 + 描述 + 页面动作
                 内容（≤74rem）
```

| 路由 | 内容 |
| --- | --- |
| `#/scripts` | 搜索 + 筛选分段 + 回收站开关 + 列宽一致的表 + 批量条。动作只覆盖**脚本生命周期**（新建 / 从 URL / 导入文件 / 检查更新）；备份属于全局数据，放在设置 → 数据 |
| `#/script/:uuid[/panel]` | 固定工具栏 + 代码面 + 21rem 检查器（元数据/值/资源/信息） |
| `#/logs` | 搜索 + 等级分段（带计数）+ 时间轴列表 |
| `#/script/:uuid[/panel]` | **代码 / 元数据 / 值 / 资源 / 信息** 用 tab 切换，每个面板独占整列（不再左右分栏） |
| `#/settings/:section` | 通用 / 更新 / 数据；分区用**下划线标签**放在标题下方，不塞进页头动作槽 |
| `#/appearance` | 独立页面：外观模式、深色主题、主题色、语言与字号。表单列宽限制在 48rem |
| `#/about` | 品牌卡 + 元数据 + 权限透明清单 |

所有页面内容**左对齐**于导航栏，`max-w-[74rem]`；不再水平居中。表单页进一步收到
`max-w-3xl`，避免标签与控件相隔近千像素。

### 10.3 Install

与 options 同一套 Card / Badge / Button / Dialog 规范；逐步展示：加载 → 摘要（权限/网络/运行范围/预览）→ 安装 → 成功。

---

## 11. 审查清单（提交前）

- [ ] 新增颜色来自语义令牌，且补了 `-foreground`
- [ ] 新增/修改主题跑过 `theme.test.ts` 与 `design-tokens.test.ts`
- [ ] 两套语言 key 一致，无硬编码可见文案
- [ ] 所有按钮/输入有可访问名称，键盘可达
- [ ] 加载态骨架与最终内容同高
- [ ] 长文本在 360px / 56px 导航宽度下不破坏布局
- [ ] 破坏性操作走 `ConfirmDialog`，默认焦点在取消
- [ ] `prefers-reduced-motion` 下仍可用
- [ ] `npm run compile && npm test && npm run build` 全绿

---

## 12. 实现对照

| 规范 | 文件 |
| --- | --- |
| 令牌、主题块、动效 keyframes、焦点、滚动条 | `assets/globals.css` |
| 主题与主题色注册表 | `lib/theme-registry.ts` |
| 应用/镜像/preload 契约 | `lib/theme.ts`、`public/theme-preload.js` |
| 首帧流水线 | `lib/page-bootstrap.ts`、`lib/build/theme-preload-plugin.ts` |
| 基础组件 | `components/ui/*` |
| 页面骨架 | `components/layout/PageLayout.tsx`、`PageHeader.tsx`、`EmptyState.tsx` |
| Popup | `entrypoints/popup/App.tsx` |
| Options 外壳与路由 | `entrypoints/options/App.tsx` |
| Options 页面 | `entrypoints/options/{Scripts,Editor,Logs,Settings,AppearancePage,About}.tsx` |
| 对比度与主题守卫 | `tests/theme.test.ts`、`tests/design-tokens.test.ts` |
