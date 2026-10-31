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
8. 页头固定在内容面板顶部，滚动只发生在页头下方的页体里；标题永远不随内容滚走。
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
| `text-base` | 15 | 23px | **页面标题**（单行页头）、强调正文、对话框标题 |
| `text-lg` | 17 | 24px | 卡片大标题（安装页脚本名、关于页品牌名） |
| `text-xl` | 20 | 26px | 保留，当前不使用 |
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
2. `theme-registry.ts` 增加定义（TypeScript 强制补 label/description/swatch；swatch 的
   `frame` / `background` / `surface` / `foreground` 由测试钉死到对应的 CSS 令牌）；
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

`elev*` 之下还有四档**静置材质**（不是层级，没有东西在“浮起”，只是光从上方来）：

| Token | 用途 | 亮色 | 暗色 |
| --- | --- | --- | --- |
| `shadow-surface` | 静置在面板上的卡片、分组列表 | 极轻接触阴影 | 1px 顶部高光 |
| `shadow-panel` | Options 内容面板（静置在窗口框上） | 接触阴影 + 柔和环境阴影 | 顶部高光 + 紧落影 |
| `shadow-control` | outline 按钮 | 极轻接触阴影 | 顶部高光 |
| `shadow-button` | 实心按钮（primary / destructive） | 顶部受光边 + 接触阴影 | 更亮的受光边 + 深落影 |

阴影通过 `@utility` 读取运行时变量，因此暗色可以替换为更硬的落影或顶部高光（软灰色阴影在近黑表面上不可见）。
注意：这些 utility 会整体覆盖 `box-shadow`，与 `ring-*` 互斥；需要描边时用 `border`。

层级约定：

| z | 层 |
| --- | --- |
| 10 | 行内浮层、吸顶的日志日期标题 |
| 20 | 安装页顶栏 |
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
| 导航指示器 | motion `layoutId` + spring(560, 44) | 侧栏选中是一枚凸起芯片（同分段滑块），在行间滑动而非两个按钮闪烁 |
| 分节下划线 | `SectionNav` 的 `layoutId` 下划线 + spring(520, 40) | 下划线滑动，内容区即时切换 |
| 列表增删 | 行高度 + 透明度 200ms（`ease-emphasis`），`AnimatePresence initial={false}` | 消失的行收起高度，下方行被平滑推上来；>80 行时降为 0ms，避免一次几百个高度动画 |
| 行内显隐 | 透明度 100ms | 勾选框替换图标、行菜单浮现：高频微交互只用最短最轻的过渡 |
| 安装页状态 | 透明度 + 6px 位移 180ms，`mode="wait"` | 加载 → 审阅 → 结果是整页级切换，只做一次短暂的落定 |
| 页面切换 | 无动效（同步提交路由） | 切换必须是即时硬切：旧页不得以快照形式盖在新页上 |
| 批量条 | 从底部 16px 推入 | 与「从底部出现」的方向一致 |

### 5.3 降级

- `prefers-reduced-motion: reduce`：CSS 动画全部 1ms；`MotionConfig reducedMotion="user"` 关闭布局动画。
- 路由切换一律即时生效，不启用 View Transitions，也永不阻塞导航。

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
材质：实心按钮带 `shadow-button`（顶部受光边 + 接触阴影），读作一枚实体按键而不是一块色块；
outline 带更安静的 `shadow-control`；ghost 无阴影。
状态：`hover` 背景过渡 150ms；`active` `scale(0.98)`；`disabled` opacity 45% 且 `pointer-events: none`；`focus-visible` 全局 2px ring + 2px offset。

### 6.2 表单控件

- 高度统一 32px（`h-8`），字号 13px，内边距 10px。
- `Input` / `Textarea` / `Select` 表面用 `background`（在 `card` 上是「挖洞」），hover 边框加深，focus 由全局 ring 表达。
- `Switch`：默认 36×20，`sm` 28×16；拇指恒为近白（物理反光件），轨道 off 用 `input`（暗色下必须可见）。
- `Checkbox`：16px 视觉框 + 28px 命中区，ARIA checkbox，支持 `mixed`。
- 标签关联：`SettingRow` 的 `htmlFor` 指向控件；无 `htmlFor` 时用 `aria-label`。
- **枚举值必须成对呈现**：`EnumValue` 把翻译标签与 `rawValue` 并排（标签常规字重，raw
  等宽 `text-2xs muted-foreground`），Select 触发器、选项列表与只读信息行共用同一个
  组件。用户最终要把 `document-idle` 写进元数据块，只给中文等于让他自己猜映射。
- 枚举词表集中在 `lib/script/metadata-options.ts`（`RUN_AT_OPTIONS` /
  `INJECT_INTO_OPTIONS`），设置页默认值、编辑器覆盖项与信息面板共用，绝不各写一份。
- **表单项的说明走 tooltip，不走正文**：`MetaField` 在标签后挂一枚 `@tag` 原始标签芯片
  （`MetaTag`，可聚焦），tooltip 里写语法与可选值。芯片是「不复述就猜不到的符号」，
  符合 §4.1 的「消灭提示文本」，同时满足元数据字段需要解释的现实。

### 6.3 分段与标签

| 形态 | 语义 | 用法 |
| --- | --- | --- |
| `Segmented`（滑块） | **原地**的互斥选择（2–5 项） | 脚本筛选、日志等级、外观模式 |
| `SectionNav`（下划线 tab） | 切换到**另一份文档** | 设置页分区、编辑器（代码 / 元数据 / 值 / 资源 / 信息） |

两者形状必须不同：同形不同义会让用户必须先读文字才能预判点击后果。筛选与偏好
都可以是“原地选择”，但**页面级分区永远是 tab**，且绝不放进页头 `actions` 槽
（那里只放动作）。tab 条作为页头的第二行直接放进 `PageLayout` 的 `header`，组件自带
`-mb-px`，选中下划线正好压在页头分隔线上；下划线是一个 `layoutId` 物体，在 tab 间滑动。
所有 tab 恒为 `font-medium`，选中只改颜色，不改字重（否则标签变宽、挤动邻居）。

### 6.4 容器

- **Options 外壳（内嵌面板）**：窗口本身是框（`bg-sidebar`），侧栏与之同色、无右边框；
  页面放在一块凸起的内容面板里（`my-2 mr-2 rounded-card border-border/70 bg-background
  shadow-panel`）。导航因此读作窗口的一部分，而不是与内容争夺注意力的第二个窗格。
  面板本身不滚动，圆角与页头始终不动。
- `PageLayout`：页头是面板顶部的**固定栏**，页体是其下方独立的滚动容器。滚动条只出现
  在页头下方，所以页头分隔线贯穿整块面板，不会在滚动条槽处断开。
  - `width="full"`：代码编辑器，独占整幅。
  - `width="content"`（默认）：列表 / 表格，74rem。
  - `width="form"`：设置与元数据表单，48rem（标签与控件保持一次眼动之内）。
  - 页头内容与内容列共用同一档位（同左内边距），左边缘永远对齐。
  - `scroll={false}`：页体变成填满面板的 flex 列，由页面自己管理滚动区域（编辑器）。
- `PageHeader`：**单行** —— `leading`（返回 / 身份图标）+ 标题（`text-base` 600）+ `meta`
  （版本、状态徽标）+ 右侧 `actions`。没有描述槽：导航已经说明位置，内容已经说明用途，
  复述它们的一句话正是 §0 要消灭的提示文本。窄宽度下动作换到第二行，标题不被挤压。
- `Card`（flat）：边框 + `card` 表面 + `shadow-surface`。设置分组、列表容器默认用它。
- `Card`（elevated）：+ `elev1`。仅用于悬浮在页面之上的独立内容。
- `SettingsGroup`：`text-sm` 600 标题（不再是 11px 大写眉标——对 CJK 无意义，还会让中文标题
  成为页面最小的字）+ 一列 `divide-border/70` 分隔的 `SettingRow`，表面带 `shadow-surface`。
  运行时状态等非表单内容也用分组承载（状态徽标放在分组的 `action` 槽），不另起一套卡片结构。
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
[图标|勾选] [名称 · 徽标]                         [相对时间] [switch][⋯]
            [版本 · 命名空间 · 大小 · @match]
            [错误行（如有）]
```

- **没有表头**：每个单元格自解释（身份、名称、时间、开关），表头只是第二行装饰。
- 列表容器 `rounded-card border bg-card p-1 shadow-surface`；行是内缩的 `rounded-control`
  块，hover `accent/60`，选中 `primary/7`。行之间不画分隔线。
- 首列是 28px 的**身份图标**（`ScriptIcon md`）。指针悬停、键盘聚焦勾选框、或已存在
  任何选择时，图标位让位给勾选框（Gmail / Linear 模式）；一旦进入多选，所有行都显示勾选框。
- 「全选」在批量条里（主勾选框，支持 `mixed`），批量条只在有选择时存在；`Esc` 退出多选。
- 时间列显示相对时间（「3 天前」），完整时间放在 `title`；`<sm` 时隐藏。
- 行内动作只保留 `⋯` 一个入口：随行浮现（hover / focus / 菜单打开期间常显），无悬停能力的
  设备（`hover: none`）上常显。脚本的启用状态只影响**下一次页面加载**；本产品不提供
  “手动补注入”，避免同一脚本在同一页执行两次（对非幂等脚本有破坏性）。
- 禁用状态由三处共同表达：图标斜线、名称变灰、开关；不再额外挂「已禁用」徽标。
- 骨架与行使用**同一个 grid 模板**，禁止两套布局。

### 6.7 代码

- CodeMirror 主题按 `.dark` 切换（github light/dark）；容器背景 `--color-code-bg`。
- 只读代码统一用 `components/code/CodeView.tsx`（Shiki）：细粒度动态导入（`shiki/core` +
  JavaScript 正则引擎，无 WASM，仅 javascript / json 两种语法与 github 两套主题），从不显示
  代码的页面不付出成本。输出同时带 `--shiki-dark`，由 `.dark` 覆盖，切主题无需重新分词。
  语法加载前以同样的行结构画无高亮文本，切换为彩色时高度不变；行号由 CSS 计数器绘制
  （`data-line-numbers`），复制时只得到代码本身。超过 2000 字符的行停止分词。
- 代码字号继承 `--font-mono` 与 rem 缩放。
- `Mod+S`（macOS ⌘S / 其它 Ctrl+S）保存当前主操作：代码 tab 保存脚本，元数据 tab
  在有未保存覆盖时保存覆盖。快捷键用 `Kbd` 显示在对应按钮的 tooltip 里——按键是
  唯一不需要解释的文案。

### 6.8 脚本身份图标（`ScriptIcon`）

脚本可用 `@icon` 声明身份图标（favicon）。它回答的是「这是哪个脚本」，因此替代
了旧版本用于表达开关状态的电源符号。

| 项 | 值 | 理由 |
| --- | --- | --- |
| 尺寸 | `sm` 20px（popup 行）/ `md` 28px（脚本列表、编辑器页头）/ `lg` 48px（安装页） | 三档同一几何：圆角 ≈ 25%，位图内核 ≈ 70% |
| 图块 | `sm` 20px `rounded-[5px]`，底 `muted` | 与 40px 行高同节奏，命中区不变 |
| 位图内核 | `sm` `inset-[3px]`（14px）/ `md` `inset-[4px]` / `lg` `inset-[7px]`，`object-contain` | 实心色块的视觉重量高于线性 glyph，必须比兜底图标的外接盒更大但比值更小 |
| 兜底 | `FileCode2` 12px，常驻底层 | 缺失、解码中、加载失败三种状态都不会出现空白块 |
| 入场 | 位图 `onLoad` 后 150ms 淡入 | 用状态而非占位骨架表达「图已经到位」 |
| 禁用态 | 图块画斜线（tile 色 4.5px 底衬 + `foreground/70` 1.75px 线），图 `grayscale` + 55% 不透明 | 14px 的淡化几乎不可见；斜线是产品里既有的「关闭」词汇，且在彩色、浅色、透明图标上都可读 |
| 缓存 | IndexedDB `icons`，data URL，≤192KB，TTL 30 天，失败 6 小时退避 | 打开 popup 不付出网络往返；`chrome.storage.local` 只放有界小数据 |

管理页通过 `scripts:list` / `scripts:getDetail` 拿到 `iconUrl`（`ManagerScript`），
与 popup 走同一个解析函数；备份导出与更新检查走不读图标缓存的 `getAllScripts`。
后台在安装、保存元数据与 popup 首次请求时预热缓存（`lib/background/icons.ts`），
因此第一行渲染就能拿到已解码的 data URL；未命中时先画兜底并显示远程地址，
缓存落地后下一次打开即是本地图。

### 6.9 工具栏角标（Toolbar badge）

角标回答的是「这个标签页此刻真正跑了几个脚本」。它统计的是**上报**，不是预测：
引擎在脚本体执行前发一次 `host:run`，background 按 tab 记录（`lib/background/injected-state.ts`）。

| 项 | 规范 | 理由 |
| --- | --- | --- |
| 计数 | 该 tab 内「上报过启动」的脚本，与「已启用 + 不在回收站」交集，跨帧去重 | 预测值会把「匹配但没跑成」的脚本算进去；按帧累加则会把一个脚本算成 N 个 |
| 帧 | 同一脚本在 top 与 4 个 iframe 里都跑，只算 1 | 角标数的是脚本，不是注入次数（`runCount` 同样每次文档只记一次） |
| 全局开关 | `scriptsEnabled` 关闭时一律为空 | 主开关暂停所有脚本，没有注册就没有上报，数字必然归零 |
| 0 | 不画（`text: ''`） | 一个常驻的 `0` 会吃掉工具栏宽度，且没有信息量 |
| 上限 | `>99` → `99+` | Chrome 角标超过 4 个字符会被截断 |
| 颜色 | 跟随主题色：亮色主题 `L≈0.55` + 白字，暗色主题 `L≈0.78` + 近黑字（`lib/color.ts` 做 OKLCH→hex） | 角标是唯一不能用 CSS 的表面；转换函数比手维护色表更不容易和 `globals.css` 分叉 |
| `system` 主题 | 按亮色处理 | service worker 没有 `matchMedia`；亮色 accent 对白字仍有 ≥4.5:1，在暗色工具栏上也可读 |
| 刷新时机 | 注入上报 / 主文档 commit（清零）/ 子帧 commit / 激活 tab / 换窗口 / `uiSettings` 变化 / 注册变化 | 数字只在「谁在跑」变化时变；URL 变化本身不改变已注入的脚本 |
| 一致性 | 每次刷新带 tab 级序号，只有最新一次可以落笔 | 并发刷新（commit、上报、设置）不能互相覆盖 |
| 持久化 | 上报状态镜像到 `chrome.storage.session`（有界，随 tab 关闭清空） | MV3 worker 随时被回收，但页面与其中的脚本还在；重启后不能归零 |
| 开关 | 外观 → 界面 → 工具栏角标（`showBadge`，默认开；关闭时清空所有 tab 的角标） | 高频可见元素需要一条退路，但默认不应让用户先去配 |

Chrome 在每次新文档 commit 时清空该 tab 的角标，因此 commit 时同步丢弃角标缓存文本
（`forgetBadge`）并清零上报状态；否则「刷新后计数没变」会表现为角标一直空白。

与 popup 的关系：popup 列出的是 top 文档 URL 命中的脚本（`lib/background/matching.ts`），
角标可能多出一个「只在 iframe 里命中」的脚本 —— 它确实在跑，只是不在那张列表里。

特权页面（`chrome://`、扩展页、Web Store）一律无角标，与 `lib/page-access.ts` 同一判定。

---

## 7. 响应式

### 7.1 断点策略

优先 **container query / flex wrap**，其次才是媒体查询。

| 场景 | 行为 |
| --- | --- |
| Options 导航 | `<768px` 固定 56px 图标栏（底栏隐藏，日志角标退化为红点）；`≥768px` 224px，可折叠到 56px |
| Options 内容 | 内容面板四周留 8px 露出窗口框；内容列按 `PageLayout.width` 取 `full` / 74rem / 48rem；内边距 20px → 28px |
| 设置项 | 标签 `basis-52`，控件 `shrink-0`；不足则换行 |
| 脚本行 | `<sm` 3 列（图标/主体/动作），`sm` 起 4 列（+ 相对时间） |
| Popup | 固定 360px 宽；高度 `max-h-600px`，列表在内部滚动；行高 40px、全宽 hover 底色 |
| 编辑器 | 单列 tab；代码面满幅无内边距，表单面在面板内收窄到 48rem |

### 7.2 视口单位

- 用 `dvh` 而非 `vh`（移动端地址栏收缩不再造成裁切）。
- Options 根容器 `h-dvh`；弹窗 `max-h-[calc(100dvh-3rem)]`。

### 7.3 HiDPI

- 图标使用矢量（lucide），不依赖位图。品牌标记是 `assets/logo.svg`（`BrandMark`）。唯一的
  位图是脚本身份图标（用户 `@icon` 提供的 favicon）：它限制在图块的 ≈70% 内核里渲染，矢量兜底常驻其下，
  因此任何缩放/缺失都不会留下空白方块。
- 1px 边框保持逻辑 1px，通过颜色差而非宽度表达边界。
- 阴影在 2x 下不会变模糊到消失（暗色使用更紧的落影）。

---

## 8. 可访问性

| 要求 | 实现 |
| --- | --- |
| 焦点可见（2.4.7 / 2.4.13） | 全局 `:focus-visible` 2px ring + 2px offset；仅 `role=listbox/menu` 豁免 |
| 目标尺寸（2.5.8） | 最小 24px；默认控件 32px；图标按钮 28px |
| 对比度（1.4.3 / 1.4.11） | 见 §2.5；测试强制 |
| 键盘 | Dialog 焦点陷阱（Radix）；Segmented 支持 ←/→；Switch/Checkbox 空格；`Mod+S`（⌘S / Ctrl+S）在编辑器保存 |
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

Popup 与浏览器自带的扩展面板同构：**一张 40px 行高的平铺列表**，单行文本、
尾部图标、hover 即全部装饰。它不是压缩版的 options，因此**不承载任何解释性
副文本**（没有版本号徽章、命名空间、`@grant` 摘要、说明句），这些信息留在行
的 `title` 与编辑器里。

| 作用域 | 例子 | 表达方式 |
| --- | --- | --- |
| 扩展全局 | 脚本注入开关、备份与恢复 | 列表底部的偏好行（分隔线以下） |
| 当前页面 | 域名、本页脚本数 | 列表顶部的只读作用域标签 |
| 单个脚本 | 启停、GM 命令、编辑 | 脚本行本身 |

```
┌ github.com · 4 个脚本                       [+] ┐ ← 只读作用域标签 + 新建
│  ▣ GitHub 增强                            [✎]   │ ← 行 = 开关（▣ = 脚本 @icon）
│  ▣ Dark Reader Lite                       [✎]   │
│  ▨ Bilibili 去广告（本轮已停用，整行降级）  [✎]   │ ← 图块画斜线并去饱和
│    └ GM 命令（仅启用时出现，缩进二级行）          │
├────────────────────────────────────────────────┤
│  ⏻ 已启用                                       │ ← 全局注入总开关（文案即状态）
│  ▦ 管理脚本                                     │ ← 目的地行
└────────────────────────────────────────────────┘
```

脚本行首是**脚本自己的身份图标**（`@icon`，由后台预热并缓存为 data URL），不是
电源符号：用户扫视列表时找的是「哪个脚本」，而开关状态由整行的墨色与图块的
饱和度表达。身份图标规范见 §6.8。

交互契约（三选一必须唯一，不得出现第二个同类入口）：

| 交互 | 语义 | 反馈 |
| --- | --- | --- |
| 点击脚本行 | 启用 / 停用该脚本（`aria-pressed`） | 身份图块画斜线并去饱和、名称降级为 muted、整行 hover 底色 |
| 点击行尾 `✎` | 打开编辑器 / 元数据 | 28px 圆形热区 + `foreground/10` 悬停 |
| 点击 `管理脚本` 行 | 打开 options `#/scripts` | 整行 hover 底色 |

间距（与 Material 3 列表规范一致：外层 8 + 行内 8 = 文本起点 16）：

| 层级 | 值 | 说明 |
| --- | --- | --- |
| popup 外框 | `p-2`（四边 8px） | 内容不再贴窗口边缘 |
| 行 hover 矩形 | 左右各内缩 8px，`rounded-control`（8px） | 底色是「矩形」，不是通栏色带 |
| 行内边距 | 左 8 / 右 4，行高 40px | 文本起点 16px、图块 20px、行尾按钮距边 12px |
| 作用域标签、分隔线、底部行 | 与行矩形左右对齐（8px） | 所有竖线只有 16 / 8 两个位置 |
| 列表 ↔ 底部分隔线 | 上下各 4px | 分隔线不与行矩形相切 |

规则：

1. **状态用行的形态表达，不用控件表达。** 行内不出现 `Switch`——开关控件属于
   「设置项」，而列表行是「对某个对象执行的动作」。状态由图块饱和度（身份图标
   画斜线 + 去饱和）与文字墨色共同承载，无需额外文案。
2. **一个符号只有一个含义。** 行尾永远只有 `✎`；行首的图块只是身份与状态，
   不单独作为按钮，避免"点行"和"点图标"产生两种结果。
3. **hover 是唯一的装饰。** 行背景 `accent`，无边框、无分隔线、无卡片阴影。
4. **不需要的控件直接不存在**：列表 ≤5 条时没有筛选框；没有命令时不渲染命令层。
5. **不可注入的页面不伪造列表**：`chrome://`、`chrome-extension://`、Web Store 等
   特权页面没有可注入的脚本，popup 的列表区显示权限空态（`ShieldOff` + 一句
   「没有访问此页的权限」），作用域标签显示协议（`chrome://`）而不是伪域名，
   本页脚本计数一并隐藏。判定统一来自 `lib/page-access.ts`。

### 10.2 Options

```
┌ 窗口框（bg-sidebar）──────────────────────────────────────────────┐
│ [logo] Lumo Userscripts  ┌ 内容面板（bg-background · shadow-panel）┐ │
│ ▣ 脚本    ← 凸起芯片      │ 标题 · meta               [页面动作]    │ │
│ ⚙ 设置                    │ [分节 tab（如有）]                      │ │
│ ◐ 外观                    ├────────────────────────────────────────┤ │
│ ≡ 日志        [2]         │ 页体（独立滚动，≤74rem / 48rem）        │ │
│ ⓘ 关于                    │                                        │ │
│ v0.1.0             [⇤]    └────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

- 侧栏：品牌行用真实 logo（`BrandMark`）+ 英文字标；选中项是 `layoutId` 凸起芯片；
  底栏是版本号（链接到源码仓库）+ 折叠按钮，折叠后只留按钮。
- 日志角标：自上次看过日志页以来新增的 **error** 条数（`logs:unread`）。「看过」是
  `chrome.storage.local` 里的一个时间戳 `logsSeenAt`（有界、不导出），日志页每次加载
  后推进到最新一条的时间；后台写日志后以 1 秒合并窗口广播 `logs-changed`。为 0 时不渲染，
  正在日志页时不显示；图标栏形态下退化为红点。

| 路由 | 内容 |
| --- | --- |
| `#/scripts` | 页头动作槽只放**新建脚本 / 检查更新**；从 URL 与导入文件收进工具栏 `导入 ▾`。工具栏为搜索 + 筛选分段 + 导入 + 回收站开关；列表无表头（§6.6），行首是脚本身份图标，批量条贴底并承载全选。动作只覆盖**脚本生命周期**，备份属于全局数据，放在设置 → 数据 |
| `#/logs` | 搜索 + 等级分段（带计数）+ **按天分组**：日期标题吸顶（今天 / 昨天 / 10月28日 周三）并带条数；每条左侧等级图标，error / warn 另有前缘色条；今天的条目显示相对时间，更早的显示时钟时间，完整时间在 `title` |
| `#/script/:uuid[/panel]` | 单行页头（返回 / 身份图标 / 名称 / 版本 / 未保存徽标 / 保存 · 保存覆盖）+ 页签条；**代码 / 元数据 / 值 / 资源 / 信息** 各占整列。代码面满幅；表单面按功能分组（运行范围 / 执行 / 标识与存储 / 权限；值 / 资源 / 信息各成组），空输入即「继承源码声明」，占位符显示声明值，有覆盖时出现「恢复继承」；值以 Shiki JSON 呈现 |
| `#/settings/:section` | 通用 / 更新 / 数据 / 智能体；分区用**下划线标签**放在标题下方，不塞进页头动作槽；运行时状态是一个设置分组。数据页分「概览 / 导出 / 恢复」三组：概览先给出脚本、回收站、值、资源与代码体积；导出显式区分 ZIP / JSON；恢复是拖放区 + 预览对话框（同名策略、是否恢复设置） + 结构化结果，不静默覆盖 |
| `#/appearance` | 外观模式与深色主题都用**同一种预览卡**（窗口缩略图：框 / 侧栏芯片 / 面板 / 主题色按钮，颜色取自主题注册表；「跟随系统」为浅深对角拼接），同一网格；主题色芯片选中态与侧栏芯片同形；语言与字号。表单列宽 48rem |
| `#/about` | 品牌卡（真实 logo）+ 元数据 + 许可 |

所有页面内容**左对齐**于面板，`max-w-[74rem]`；不再水平居中。表单页进一步收到
`max-w-3xl`，避免标签与控件相隔近千像素。

### 10.3 Install

与 options 同一套 Card / Badge / Button / Checkbox 规范。页面只回答一个问题——「这个脚本将被允许做什么」，自上而下：

1. 顶栏：logo + 字标 / 安装脚本 + 关闭。
2. 身份卡：`ScriptIcon lg`（远程 `@icon`，失败即兜底）、名称、版本或「更新 vA → vB」、作者 · 命名空间、描述、来源。
3. 能力清单：权限 / 网络 / 外部代码 / 运行范围，每行图标 + 固定标签列 + 值（芯片或「无」）。
4. 警告：`warning` 色调提示块。
5. 代码预览：折叠卡，标题行显示行数与大小；**展开时才挂载** Shiki（`CodeView`，带行号）。
6. 决策条：浮动卡片（与列表批量条同一种「对眼前内容执行动作」的形态），粘在底边；
   「安装后启用」用设计系统 Checkbox。

状态：加载 → 与审阅同形的骨架；安装中 → 审阅保持在屏，按钮自身变为进度；成功 / 失败 → 结果卡（成功带脚本身份）。状态间切换见 §5.2。

---

## 11. 审查清单（提交前）

- [ ] 新增颜色来自语义令牌，且补了 `-foreground`
- [ ] 新增/修改主题跑过 `theme.test.ts` 与 `design-tokens.test.ts`
- [ ] 两套语言 key 一致，无硬编码可见文案
- [ ] 所有按钮/输入有可访问名称，键盘可达
- [ ] 加载态骨架与最终内容同高
- [ ] 长文本在 360px / 56px 导航宽度下不破坏布局
- [ ] 页框填满内容面板；内容列只用 `PageLayout.width` 收窄，不在页面里写 `max-w-*`
- [ ] 页头单行，不写描述句；分节 tab 作为页头第二行
- [ ] 静置表面用材质令牌（`shadow-surface` / `shadow-control` / `shadow-button`），浮层才用 `elev*`
- [ ] 枚举值同时展示翻译标签与 `rawValue`
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
| 页面骨架 | `components/layout/PageLayout.tsx`、`PageHeader.tsx`、`SectionNav.tsx`、`EmptyState.tsx` |
| 品牌标记 / 脚本身份图标 | `components/brand/BrandMark.tsx`、`components/script/ScriptIcon.tsx` |
| 只读代码高亮 | `components/code/CodeView.tsx` |
| 相对时间 / 日分组 | `lib/format.ts`、`lib/use-now.ts` |
| 后台事件（含 `logs-changed` 合并） | `lib/background/events.ts` |
| Popup | `entrypoints/popup/App.tsx` |
| Options 外壳与路由 | `entrypoints/options/App.tsx` |
| Options 页面 | `entrypoints/options/{Scripts,Editor,Logs,Settings,AppearancePage,About}.tsx` |
| 安装页 | `entrypoints/install/App.tsx` |
| 对比度与主题守卫 | `tests/theme.test.ts`、`tests/design-tokens.test.ts` |
