# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
每条修复写清**之前的行为 vs 现在的行为**，而不是只写结论。

## [Unreleased]

### Added

- **标题栏「大纲」按钮自适应（icon-only）—— 复用宿主原生容器查询机制。** 之前的行为：按钮恒为
  「svg + 文字」整块 —— 右侧边栏展开时宿主把自己的标题栏按钮收成图标（原生 label 在
  `@container (width<=540px)` 下 `display:none`），而本按钮仍占整块宽，与相邻功能**重叠**。
  现在的行为：给按钮的文字 span 注入**同一条件**的容器查询（容器同为宿主声明
  `container-type: inline-size` 的 `.wSkVaW_titleRow`，阈值同为 540px）⇒ 右栏展开（titleRow ≤ 540px）
  时文字隐藏、按钮**真实收窄**为图标宽（glyph + padding），与原生按钮同帧收起/还原；span 保持
  挂载（与原生 label 同款处理），`aria-label` / `title` / `type=button` 不受影响，可点击、可键盘聚焦。
  判定来源与原生逐字符一致（非自造测量、无 JS 状态）；宿主无该容器的旧版本 ⇒ 查询不命中 ⇒
  保持宽态（降级安全，与原生行为一致）。新增判据 `test/icon-only.test.js`：来源一致性（条件与
  原生逐字符相等）、选择器对位、两态布局模拟（宽度由解析产物 CSS 驱动，窄态 < 全宽 60%）、
  降级断言，及 2 组变异自证。

### Added

- **一次性兼容性诊断日志（快照形状 + 宿主 DOM 契约）。**
  - 之前的行为：插件对宿主 DOM 属性（`data-chat-anchor-key` / `data-message-key` / `data-node-key` /
    `data-chat-flow-kind` / `data-conversation-scroll`）和会话快照结构（`legacy.nodes` / `nodes` /
    `chat.{order,nodes}` …）都做多候选兼容，但降级是**静默**的：宿主改名后用户只看到「点了不跳」或
    「面板空着」，控制台没有任何可排查的线索，也无从判断当前用的是哪一代契约。
  - 现在的行为：首次拿到有内容的快照时打印一条 `console.info`，记录实际结构与本轮行数
    （例如 `session snapshot shape: legacy.nodes (12 rows)`）；结构陌生但明显像 ChatSnapshot 时打印一条
    `console.warn` 并列出实际键名。首次渲染出大纲时探测 DOM 契约：齐全打一条 info；缺失/改名打一条
    warn，明确写出缺哪些属性、以及已降级为「按文本顺序匹配」而不是「按 key 精确定位」。
    两类日志每次页面加载最多各一条（`resetDiagnostics()` 仅供测试），不刷屏、不改变任何容错行为。
  - 回归判据：新增 `test/diagnostics.test.js` —— DOM 契约齐全 / 缺项 / 只有等价锚点的探测矩阵；健康与
    降级两种日志都只输出一次；快照形状矩阵（含 `nodes.values` 与陌生形状）；陌生形状告警；数据尚未
    到达（`undefined` / `{}`）时不消耗那次机会。

### Fixed

- **修复「面板展开状态下刷新页面 → 整个槽位入口（含常驻『大纲』按钮）消失」的崩溃。**
  - 之前的行为：`HistoryOutlinePanelInner` 在 `currentSessionNodes` 的 `useMemo` 回调里**条件**调用宿主注入的
    `useSessions`（一个真正的 React hook）。挂载轮（`hookNodes` 为空、回退分支执行）它连同
    `use-sync-external-store` shim 内部的 hook 一起被追加进 hook 链；下一轮渲染（面板自身 effect 的
    `bump()` 必然触发一次）该 memo 因 deps 未变跳过回调，链上后续 hook 与上一轮错位配对，React 在
    比较 memo deps 时对 `undefined` 读 `.length` 抛 `TypeError`，宿主槽位边界捕获后把**整个槽位入口**
    替换为空节点。触发条件恰是「面板展开（`pinned` 在存储键缺失时默认 `true`）+ 刷新时会话数据尚未
    就绪」，因此「收起时刷新正常」「无痕窗口（空存储 ⇒ 默认展开）无面板」与「清掉全部
    `dsh-conversation:*` 键后仍崩」是同一机制的三种表现。
  - 现在的行为：`useSessions` 与其它宿主 hook 一样只在组件**顶层**调用（每轮渲染无条件执行，选择结果
    交给 `useMemo` 的 deps），回退数据经 `conversationNodesOf` 归一后进 memo。数据缺失时面板渲染空态，
    槽位入口与常驻按钮在任何时序下都不再崩溃，兑现 README「宿主 API 降级不拖垮同槽位」的承诺。
  - 回归判据：新增 `test/hooks-order.test.js` —— 用"按 deps 跳过 memo"的最小 React 桩驱动组件渲染两轮，
    断言两轮 hook 调用序列完全一致（旧代码必红）；并断言 `useChat` 缺席时回退路径仍能渲染大纲、
    数据缺失时渲染空态。`internals` 相应导出 `HistoryOutlinePanelInner` 供测试驱动。

- **槽位 props 为空时不再「永远空态」：面板改从宿主服务（`sessions` / `uiSession`）取当前会话快照。**
  - 之前的行为：面板只从 slot props 的 `useChat` / `useSession` / `useSessions` 取数据。宿主在
    `conversation.session.header.actions` 上以 `renderSlot(..., {})` 渲染（dsh 0.2.0-rc.2 的
    `dsh-client-ui-conversation/lib/client.js:16502`），owner props 为空；第三方 header（如
    `dsh-better-sidebar`）接管 header 区时 props 形状也可能不同 ⇒ 三条 hook 全缺席时面板永远停在
    「暂无大纲内容」，而顶部「大纲」按钮看起来一切正常，用户没有任何可排查的线索。
  - 现在的行为：`apply()` 把 cordis 的 `sessions` / `uiSession` 服务捕获进插件私有的 host bridge
    （经 `ctx.reflect.get(name, false)` 只读探测，缺失/抛错都降级为 `undefined`），槽位包装器把
    `store` / `host` **最后**合并进 props。面板优先用 slot props 的 hook（旧宿主行为不变），缺失时读
    `uiSession.current` 的 `hooks.chat`（ChatSnapshot）与 `hooks.session`（`hasMore` / `loadOlder`）；
    两条路的结果都经 `conversationNodesOf` 归一 + `Array.isArray` 兜底。服务缺失或抛错时只渲染空态，
    槽位按钮在任何情况下都保留。空 props 下的收藏 / 阅读位置也从 `default-session` 改为真实会话 id。
  - 回归判据：新增 `test/host-service.test.js` —— 在 `renderSlot(..., {})` 形状的完全空 props 下渲染出
    服务端快照里的提问与标题；同一 props 两轮渲染的 hook 序列一致；垃圾 props（`useChat: 'not-a-hook'`、
    `useSession: 42`、`sessions.binding` 非函数）、缺失服务、读取即抛错的服务都只渲染空态不抛错；
    并锁定「props hook 存在时仍以 props 为准」的优先级。

- **首屏数据未就绪时先渲染占位，就绪后再挂载面板组件。**
  - 之前的行为：只要 `pinned` 为真（存储键缺失时默认 `true`），`HistoryOutlineSlot` 立即挂载
    `HistoryOutlinePanelInner`。页面刷新时会话 / chat 数据尚未水合，面板先以空数据走完第一轮 hook 与
    `useSyncExternalStore` 订阅，再由自身 effect 的 `bump()` 触发第二轮渲染 —— 这既是 1.3.1 崩溃的触发
    窗口，也表现为「刷新时面板先空一下再出内容」的闪动。
  - 现在的行为：槽位组件先用服务路径判断会话绑定是否就绪（`panelMountStateOf`）。未就绪时只渲染同位置
    的占位外壳（「正在读取会话…」，`role="status"` + `aria-busy="true"`），就绪后才挂载面板组件；最长
    等 2 秒（`PANEL_READY_TIMEOUT_MS`），超时仍照常挂载并展示空态，避免宿主某版本不再 retain 会话时
    永远停在占位。宿主没有提供服务（旧宿主 / 独立渲染）时保持 1.3.1 的直接挂载。
  - 回归判据：`test/host-service.test.js` 新增 3 条 —— `panelMountStateOf` 的状态矩阵（无服务 / 未就绪 /
    超时 / 就绪）；未就绪时只出现占位、不出现面板空态；从未就绪切到就绪时槽位组件**自身**的 hook 序列
    不变（断言里按 depth 把子组件 hook 排除）。

### Changed

- **文档：README 默认语言改为中文。** 语言约定统一为 `README.md`（中文，默认入口）+
  `README.en.md`（英文），两版顶部互链；`README.zh-CN.md` 已并入 `README.md`
  （内容不变，仅文件名与默认入口调整）。`CONTRIBUTING.md` 的同步要求随之更新，
  `files` 改为分发 `README.en.md`。
- **文档：安装命令的版本引用改为 `#v1.3.1`。** 此前写的是 `#v1.3.0`，而该标签从未发布 ——
  照 README 的「优先用不可变 tag」安装会因引用解析失败而直接报错。同时把「跟踪开发分支」的
  括注由「尚未发布 tag 时用这个」改为「需要尚未发布的最新提交时用这个」，避免与已发布的 tag 自相矛盾。

## [1.3.1] - 2026-09-21

### Added

- **长会话历史分页按需与一键全量加载**（`loadOlder` / `loadAll`）：
  - 面板顶部自动感知会话未完全加载（`hasMore`），提供「加载更早」与「加载全部」按钮，主动循环分页拉取完整会话，彻底消除长会话早期提问被截断的问题。
- **左右双侧停靠切换**（`dockSide: left | right`）：
  - 标题栏增加停靠侧切换按钮，支持面板在右侧与左侧快速切换，避免遮挡右侧的原生轨道或其他 Sidebar 插件；偏好自动持久化。
- **定位与气泡体验优化**：
  - 精确匹配 `[data-chat-anchor-key]` 属性，并结合 `[data-conversation-scroll]` 原生滚动视口平滑跳转与闪烁高亮。
  - 提问全文 Tooltip 气泡根据面板左右停靠位置自动翻转，防止超出屏幕。

### Changed

- **简化入口交互**：
  - 停用界面最右侧边缘的滑轨刻度条与底栏开关，界面顶栏「思维导图」旁的操作按钮作为唯一、常驻的大纲开关，避免多重入口冲突。

## [1.3.0] - 2026-09-21

### Fixed

- **同一段正文被收取两次**（旧结构 `node.data.content` 形状）：`rowContent()` 取的正是
  `node.content` / `node.data.content`，而 `textBlocks` 里还有一条专门遍历 `node.data.content` 的分支，
  两者指向同一个数组时该数组被收两遍。**之前**：这类 assistant 节点的每个 Markdown 标题都会在大纲里
  **重复出现一次**，该轮「N 字」统计**翻倍**；**现在**：`textBlocks` 记录已收取的数组，同一数组只收一次，
  标题与字数都正确。同时补上 `node.data.content` 内 `null` 块的判空（此前会读到 `null.type` 抛错）。
  回归测试见 `test/client.test.js`。

### Changed

- **仓库工程化**（对齐 `PLUGIN-STYLE-GUIDE`）：入口从 `lib/` 移到仓库根目录
  （`lib/index.js` → `index.js`，`lib/client.js` → `client.js`），与 `dsh-localsend` / `dsh-grafana` 一致。
  之前入口藏在 `lib/` 下、缺少测试与工程文件；现在补上 `test/`、CI、双语 README、`SECURITY.md`、
  `CONTRIBUTING.md`、`CHANGELOG.md`、`LICENSE`、`cordis.patch.yml` 与 `.gitignore`。
  `package.json` 的 `main` / `exports` 同步指向新路径——**已安装的 profile（`link:` 或按版本安装）
  无需改动**，包名与模块 id 都没变。
- `package.json` 补齐元数据：`files` / `scripts`（`check` `test` `verify` `prepack`）/ `dsh.bundle.patch` /
  `engines` / `keywords` / `author` / `repository` / `homepage` / `bugs` / `publishConfig`。

## [1.2.0] - 2026-09-20

### Added

- **三档宽度**：紧凑 320px → 加宽 480px → 全屏 720px 整高，标题栏按钮循环切换。
- **右侧刻度条**（收起态的默认形态）：一 tick 对应一轮提问，长度按该轮正文量归一化，
  hover 显示该轮摘要，点击跳到该轮；顶部图标按钮展开面板。关掉刻度条则回落到原来的右上角胶囊。
- **搜索范围**：搜索框左侧按钮循环切换「全部 / 问题 / 标题」。
- **导出为 .md 文件**：内容与「复制大纲」同源（`outlineToMarkdown`），走内存 Blob +
  `URL.createObjectURL`，不请求宿主、不落盘到工作区。
- **双击跳「本节末尾」**：在先序扁平顺序里找下一个同级或更高级节点，已是最后一节则滚到底部。
- **键盘导航**：面板聚焦时 `Alt+↓ / Alt+↑` 跳下一个 / 上一个节点；只在面板内监听，不抢宿主按键。
- **阅读位置记忆**：每个会话记录上次看到的大纲节点，切回会话时面板直接落回该位置。

### Changed

- 列表行新增该轮统计：**「N 工具」「N 字」**。此前 tool-call / context 节点被完全忽略，
  用户看不出某一轮到底有多重；现在它们只计数、仍不进大纲（保持大纲是"人话"）。
- `partial`（流式）标题此前只在正文里出现，现在同样计入所属轮次的字数并标记 `streaming`。
- 状态持久化扩展：视图档位、刻度条开关、阅读位置加入 `dsh-conversation:` 前缀的 localStorage。
  此前只持久化 `pinned` / 拖拽位置 / 默认展开层级 / 每会话收藏。

## [1.1.0] - 2026-09-20

### Added

- 合并原 `dsh-outline` 插件的全部能力：Markdown 标题树（用户提问为 level 0，助手回复里的
  ATX 标题为 level 1~6）、层级滑块、搜索、收藏、复制大纲、阅读位置跟随、DOM 顺序锚定。
  之前这两个插件并存、各自占一个右上角位置；现在合成一个面板。

### Changed

- **包名与仓库名** `dsh-client-hqst` → `dsh-conversation`。profile 里的依赖需要改写成新包名；
  功能取向上有意保留原 hqst 的性格：用户提问行额外显示提问时间、面板默认常驻。

## [1.0.0] - 2026-09-10

### Added

- 首版（原名 `dsh-client-hqst`）：右上浮动面板，按序列出本会话的用户提问，点击跳到正文并短暂高亮。
