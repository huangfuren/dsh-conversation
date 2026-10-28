# dsh-conversation

中文 | [English](./README.en.md)

Web 端「会话大纲」插件：在页面右上角贡献一个浮动面板，把当前会话组织成一棵大纲树 —— **用户提问**是根节点（带序号、提问时间、该轮工具数与正文量），**助手回复里的 Markdown 标题**按其层级挂到最近的提问下。点击任意一行跳到正文并短暂高亮。纯 UI 插件，不接触任何提示词、消息、工具结果，也不向提供方发起请求。

> Project status: 1.x。**已在 dsh 0.1.5-rc.2 + `web` profile 上验证，并适配 dsh 0.2.x**（`>=0.2.0-rc.1 <1.0.0`）；更早的 dsh 版本与其它 profile **未认证** —— 插件遇到不认识的宿主 API 会降级为"面板不出现"而不是抛错，但那条路径不在测试矩阵内。

版本脉络：1.1.0 合并了原 `dsh-outline` 插件的全部能力并把包名从 `dsh-client-hqst` 改为 `dsh-conversation`；1.2.0 起补齐了大量导航能力（三档宽度 / 侧边刻度条 / 搜索范围 / 导出 / 节级跳转 / 快捷键 / 阅读位置记忆）。

## 效果

- **常驻态（默认）**：浮动面板（`dsh-conv-panel`），标题「历史提问 · 大纲」。
  - **三档宽度**：紧凑 320px → 加宽 480px → 全屏 720px 整高，标题栏按钮循环切换（快捷键 `Alt+↑/↓` 见下）；
  - 标题栏是拖拽把手（4px 阈值，拖动后位置持久化）；
  - 工具行：展开/收起全部、只看收藏、**复制大纲**（Markdown 进剪贴板）、**导出为 .md 文件**、搜索框（命中片段高亮）；
  - **搜索范围**：点击搜索框左侧的「全部 / 问题 / 标题」按钮循环切换，只匹配提问或只匹配标题；
  - 层级滑块：0 = 仅显示提问，1~6 = 展开到对应标题层级，圆点 tooltip 显示各层级数量；
  - 列表行：折叠箭头 / `Q1` 序号徽标 / 文本 / 提问时间 / **该轮「N 工具」「N 字」统计** / 收藏星；当前阅读位置的行自动浅底高亮并滚入可视区；
  - 底部：回到顶部 / 回到底部 / **侧边刻度条开关**。
- **收起态**：默认显示**右侧刻度条**（`dsh-conv-rail`）—— 一 tick = 一轮提问，长度按该轮正文量归一化（顺带成了"对话密度图"），hover 有该轮摘要，点击跳到该轮，顶部的图标按钮展开面板；关掉刻度条则回落到右上角胶囊（`dsh-conv-fab`）「历史提问 · 大纲 (N)」。
- **跳转粒度**：单击任意行 → 跳到该节点；**双击任意行 → 跳到"本节末尾"**（下一个同级或更高级节点，已是最后一节则滚到底部）。
- **键盘**：面板聚焦时 `Alt+↓ / Alt+↑` 跳到下一个 / 上一个节点（只在面板内监听，不抢宿主按键）。
- **阅读位置记忆**：每个会话记录上次看到的大纲节点，切回来时面板直接落在那里。
- **空态**：会话里还没有提问/标题时显示「暂无大纲内容」。
- **首屏占位**：刷新后宿主会话/chat 数据尚未就绪时，先在面板位置显示占位「正在读取会话…」，就绪后才挂载面板（不再先闪一下空态）；宿主超过 2 秒仍未给出会话绑定就照常挂载并展示空态。
- **标题栏按钮自适应（icon-only）**：右栏展开、标题栏变窄时，标题栏里的「大纲」按钮自动收成纯图标（与宿主原生按钮同机制：同一容器查询 `@container (width<=540px)`、同一容器 `.wSkVaW_titleRow`），按钮真实收窄且 `aria-label` / `title` 保留、可点击、可键盘聚焦；右栏收起后自动还原。旧版宿主无该容器 ⇒ 保持宽态（降级安全）。
- 状态持久化：`pinned` / 拖拽位置 / 视图档位 / 刻度条开关 / 默认展开层级 / 每会话收藏 / 每会话阅读位置，全部走 `localStorage`（键前缀 `dsh-conversation:`）。

## 实现方式

| 半 | 文件 | 职责 |
| --- | --- | --- |
| Node 半 | `index.js` | 空 `apply()`，仅为让插件在宿主 `cordis.yml` / Loader 中可见；无任何宿主侧行为 |
| 客户端半 | `client.js` | 实际 UI，经 `exports["./client"]` + `package.json` 的 `dsh.client` 声明被 Web 宿主发现 |

客户端半行为：

1. 通过 `inject: ["slots", "sessions"]` 取两个必需服务，缺失则打警告并禁用面板；`apply()` 同时把 `sessions` / `uiSession` 服务抓进插件私有的 host bridge。
2. 在 `conversation.session.header.actions` 槽位注册 `dsh-conversation`（`order: 100`），把 `store` / `host` 合并在槽位 props 的最后 —— 宿主传空 props、或第三方 header 传另一套形状，都覆盖不掉它们。`pinned` 且会话绑定未就绪时先渲染占位，就绪后再挂载面板组件（`panelMountStateOf`，2 秒超时兜底）。
3. 数据有两条路：slot props 的 `useChat` / `useSession` / `useSessions`（旧宿主 / 第三方 header 注入）优先；它们缺失时读 `uiSession.current` 的 `hooks.chat`（ChatSnapshot）与 `hooks.session`（`hasMore` / `loadOlder`）。两条路的结果都经 `conversationNodesOf` 归一，再用 `Array.isArray` 兜底；都拿不到就是空态。
4. `buildOutlineItems` 把快照摊平成大纲项：user/steering → level 0（同时统计该轮工具数与正文字数）；assistant 的 text block 按 ATX 标题（`^#{1,6}\s+`，跳过围栏代码块内的 `#`）→ level 1~6；流式中的 `partial` 标题实时出现并带呼吸动画；tool-call / context 等非正文节点只计数、不进大纲。
5. `OutlineManager` 持有层级、搜索（含范围）、收藏状态并与 localStorage 同步；折树 / 折叠恢复 / 可见行压平 / 定位揭示都是纯函数。
6. 点击定位：先用宿主内部锚点属性 `[data-chat-anchor-key]` → `[data-message-key]` → `[data-node-key]`，命不中再按 `data-chat-flow-kind` 顺序匹配 + 文本校验；始终找不到就提示「当前节点暂不可定位」，绝不静默错位滚动。
7. 「本节末尾」跳转由 `nextSectionItem` 在先序扁平顺序里找下一个同级或更高级节点，没有则回退到滚到底部。
8. 导出走内存里的 Blob + `URL.createObjectURL`（不请求宿主、不落盘到工作区），内容与「复制大纲」同源（`outlineToMarkdown`）。
9. 样式全部使用 `dsw-alias-*` / `dsw-shadow-*` 主题令牌，无硬编码色值。

## 兼容性

- **快照契约双支持**：新结构 `snapshot.nodes[]` + `snapshot.partial`；旧结构 `snapshot.chat.{order, nodes(Map)}` + `node.data.content`。结构不符时返回空列表而不是抛错。
- **槽位数据源加固**：`conversation.session.header.actions` 的 owner props 可能为空（dsh 0.2.0-rc.2 即以 `renderSlot(..., {})` 渲染），第三方 header（如 `dsh-better-sidebar`）接管 header 区时 props 形状也可能不同。面板优先用 slot props 注入的 hook，缺失时改读 `uiSession.current` 的 `hooks.chat` / `hooks.session`；两条路都拿不到就渲染空态，不会让槽位崩溃。
- **宿主 API 降级**：`slots` / `sessions` / `uiSession` 的形状、store 的 `getSnapshot` / `subscribe` 都逐层探测并吞掉异常；任一改名或缺失只让本面板降级为空态，不会拖垮同槽位的其它插件。
- **一次性兼容性诊断**：首次拿到有内容的快照时用一条 `console.info` 记录实际结构（`legacy.nodes` / `nodes` / `chat.order` …）与行数；结构无法识别时 `console.warn` 列出实际键名。首次渲染出大纲时探测 DOM 契约（`data-conversation-scroll` / `data-chat-flow-kind` / 锚点属性），缺失或改名时 `console.warn` 说明已降级为「按文本顺序匹配」。两类日志每次页面加载最多各一条，不改变任何容错行为。
- **文案双语**：自带 zh/en 字典，按 `navigator.language` 回落；宿主若注入了可用的 `t` 则优先使用。

## 设计说明与来源

本插件的**功能取舍**参考了 DSH 生态内同类插件（会话大纲 / 提问导航 / minimap 类）公开的功能描述与交互形态 —— 同类能力（大纲树、右缘导航条、搜索、导出、阅读位置跟随等）属于通用交互设计，不受版权保护。**代码为本仓库独立实现，未复制、未改编任何第三方源码**，也不依赖任何第三方运行时包（唯一 peer 依赖是宿主提供的 react）。

## 依赖与许可

- peerDependencies：`react ^18.2.0`（由宿主提供，无第三方运行时依赖）
- license：MIT

## 兼容矩阵

| 组件 | 支持基线 |
| --- | --- |
| Node.js | >= 22.19 |
| DSH | >= 0.1.5-rc.2 < 1.0.0 \|\| >= 0.2.0-rc.1 < 1.0.0（已在 0.1.5-rc.2 验证；0.2.x 已适配） |
| react | ^18.2.0（宿主提供） |
| 界面 | `web`（`dsh.client.platform`） |

超出上表的组合未认证。

## 安装

优先用不可变 tag：

```sh
dsh plugin --profile web add github:huangfuren/dsh-conversation#v1.3.1
```

跟踪开发分支（需要尚未发布的最新提交时用这个）：

```sh
dsh plugin --profile web add github:huangfuren/dsh-conversation
```

或指向本地 checkout：

```sh
dsh plugin --profile web add file:/absolute/path/to/dsh-conversation
```

`package.json` 已声明 `dsh.bundle.patch`（`./cordis.patch.yml`），由 `dsh plugin add` 自行维护组合。
若想手工插到 profile 的 `cordis.patch.yml`，等价写法是：

```yaml
- insert:
    - id: conversation
      name: dsh-conversation
```

## 开发与测试

```sh
npm run check    # node --check 两个入口
npm test         # node --test
npm run verify   # check + test（已绑定 prepack，测试不过打不出包）
```

`client.js` 不是 ES 模块：dsh 客户端模块加载器按 `window.__ModuleLoader__.load({ id, factory })` 加载它，
`factory` 里的 `require` **只能解析宿主提供的外部模块**（本插件只用到 `react`），相对路径依赖在真实加载器里
解析不了 —— 所以客户端保持自包含单文件（`dsh-grafana` 的 `client.js` 约 67 KB，同样如此）。
`test/client.test.js` 用最小加载器桩把它 load 进来，断言它导出的纯函数 `internals`；
`test/hooks-order.test.js` 则用「会按 deps 跳过 memo」的 React 桩驱动 `internals.HistoryOutlinePanelInner`
渲染两轮，锁定「宿主 hook 只在组件顶层调用」的 Rules of Hooks 契约；
`test/host-service.test.js` 驱动 `apply()` 注册出来的槽位组件，锁定「宿主 slot props 为空时从
`uiSession` / `sessions` 服务取快照」以及服务缺失 / 恶意 props 的降级路径。
`test/diagnostics.test.js` 锁定 DOM 契约探测矩阵、快照形状矩阵，以及两类一次性日志「每次页面加载最多一条」的约定。

## 已知限制

- 点击定位依赖宿主的 DOM 契约（`data-chat-anchor-key` / `data-message-key` / `data-node-key` 或 `data-chat-flow-kind`）；若未来整体改属性，需在 `locateByKey` / `collectUserRows` 里追加新候选——插件会在首次渲染出大纲时探测一次，缺失时打一条 `console.warn`（见「兼容性 / 一次性兼容性诊断」）。
- 服务路径跟随宿主「主视图」绑定的会话（`uiSession.current`）：该槽位的 owner props 不带 `sessionId`，所以同页子会话（subagent）的 header 上，面板展示的仍是主会话大纲。若宿主将来在 props 里给 `sessionId`，会优先使用它。
- 面板为 fixed 定位，与其它右上角悬浮插件共存时可能重叠，需各自错开 `top`；刻度条固定贴右缘居中，与自带的同类导航插件同时开启时会视觉重叠。
- 「N 工具 / N 字」统计口径是快照里该轮之后的 tool 节点数与 assistant 正文字符数，宿主若改变节点 kind 命名会退化为不显示（不会报错）。
- 导出文件名固定为 `dsh-conversation-outline.md`，不做命名配置。
