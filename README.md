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
- 状态持久化：`pinned` / 拖拽位置 / 视图档位 / 刻度条开关 / 默认展开层级 / 每会话收藏 / 每会话阅读位置，全部走 `localStorage`（键前缀 `dsh-conversation:`）。

## 实现方式

| 半 | 文件 | 职责 |
| --- | --- | --- |
| Node 半 | `index.js` | 空 `apply()`，仅为让插件在宿主 `cordis.yml` / Loader 中可见；无任何宿主侧行为 |
| 客户端半 | `client.js` | 实际 UI，经 `exports["./client"]` + `package.json` 的 `dsh.client` 声明被 Web 宿主发现 |

客户端半行为：

1. 通过 `inject: ["slots", "sessions"]` 取两个必需服务，缺失则打警告并禁用面板。
2. 在 `shell.overlay` 槽位注册 `question-history`（`order: 100`），并把 `store` / `sessions` 透传给面板，不依赖 face 注入。
3. `sessions.binding(id)` 取当前会话 face，用 `useSyncExternalStore` 订阅 `getSnapshot()`。
4. `buildOutlineItems` 把快照摊平成大纲项：user/steering → level 0（同时统计该轮工具数与正文字数）；assistant 的 text block 按 ATX 标题（`^#{1,6}\s+`，跳过围栏代码块内的 `#`）→ level 1~6；流式中的 `partial` 标题实时出现并带呼吸动画；tool-call / context 等非正文节点只计数、不进大纲。
5. `OutlineManager` 持有层级、搜索（含范围）、收藏状态并与 localStorage 同步；折树 / 折叠恢复 / 可见行压平 / 定位揭示都是纯函数。
6. 点击定位：先用宿主内部锚点属性 `[data-chat-anchor-key]` → `[data-message-key]` → `[data-node-key]`，命不中再按 `data-chat-flow-kind` 顺序匹配 + 文本校验；始终找不到就提示「当前节点暂不可定位」，绝不静默错位滚动。
7. 「本节末尾」跳转由 `nextSectionItem` 在先序扁平顺序里找下一个同级或更高级节点，没有则回退到滚到底部。
8. 导出走内存里的 Blob + `URL.createObjectURL`（不请求宿主、不落盘到工作区），内容与「复制大纲」同源（`outlineToMarkdown`）。
9. 样式全部使用 `dsw-alias-*` / `dsw-shadow-*` 主题令牌，无硬编码色值。

## 兼容性

- **快照契约双支持**：新结构 `snapshot.nodes[]` + `snapshot.partial`；旧结构 `snapshot.chat.{order, nodes(Map)}` + `node.data.content`。结构不符时返回空列表而不是抛错。
- **宿主 API 降级**：`slots` / `sessions` 的形状、face 的 `getSnapshot` / `subscribe` 都逐层探测；任一改名或缺失只让本面板消失，不会拖垮同槽位的其它插件。
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
dsh plugin --profile web add github:huangfuren/dsh-conversation#v1.3.0
```

跟踪开发分支（尚未发布 tag 时用这个）：

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
`test/client.test.js` 用最小加载器桩把它 load 进来，断言它导出的纯函数 `internals`。

## 已知限制

- 点击定位依赖宿主的 DOM 契约（`data-chat-anchor-key` 或 `data-chat-flow-kind`）；若未来整体改属性，需在 `locateByKey` / `collectUserRows` 里追加新候选。
- 面板为 fixed 定位，与其它右上角悬浮插件共存时可能重叠，需各自错开 `top`；刻度条固定贴右缘居中，与自带的同类导航插件同时开启时会视觉重叠。
- 「N 工具 / N 字」统计口径是快照里该轮之后的 tool 节点数与 assistant 正文字符数，宿主若改变节点 kind 命名会退化为不显示（不会报错）。
- 导出文件名固定为 `dsh-conversation-outline.md`，不做命名配置。
