# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
每条修复写清**之前的行为 vs 现在的行为**，而不是只写结论。

## [Unreleased]

## [1.4.0] - 2026-11-02

### Added

- **面板背景透明度可调。** 之前面板底色恒为主题令牌的纯色，挡住正文时只能靠拖走或收起面板绕开；
  现在面板底部多一条滑杆，可把背景不透明度调到 40%~100%（默认 100%，观感与之前完全一致）。
  只降低底色、不降低文字，避免半透明后正文反而看不清；调暗时自动按比例加背景模糊。
  点右侧百分比或双击滑杆恢复完全不透明。该值与 `pinned` / 位置一起写进 `dsh-conversation:panel`，
  重载后保持；老用户的快照里没有这个字段，升级后仍是完全不透明。
- **旧宿主上不显示透明度滑杆。** `color-mix` 需要 Chromium 111+，更老的宿主会整行丢弃该声明、
  底色恒为纯色。之前那种情况下滑杆会「拖了没反应」；现在改为先探测能力，不支持就整行不渲染，
  面板维持完全不透明，不留下无效控件。

### Changed

- **槽位注册改为三通道兜底。** 之前把 `ctx.slots.inject` 当成硬依赖：宿主一旦移除或改名该 API，
  面板整块消失，只留一条 `console.warn`。现在按宿主实际能力选通道——有 `inject` 走 `inject`，
  没有但有 `slots.subscribeDeclaration` 就订阅声明事件后注册，两者都没有才退回「立即尝试 + 700ms
  退避重试」。同时只有 `slots.register` 缺失才禁用面板。附带修好一处旧实现在重挂载下的失效：
  槽位塌缩重建后宿主会丢弃原有条目，之前 `registered` 标记粘住不再重试，现在由 `declarationEpoch`
  判断是否真的换了声明周期，变了就重新注册，同一声明周期内不重复注册（否则宿主抛 `already has an entry`）。
- **文档：安装命令的版本引用同步到 `#v1.4.0`。** `README.md` 与 `README.en.md` 两版同步；
  README 兼容段同时修掉两处与代码不符的描述（槽位名写成 `shell.overlay`、条目名写成
  `question-history`、重试次数写 ≤7 而代码实际是 12）。

## [1.3.2] - 2026-11-02

### Fixed

- **面板首次打开时抛 `TypeError: Cannot read properties of undefined (reading 'length')`，要等重新挂载才出目录。**
  之前：槽位下发的 hook 工厂形态会随渲染变化（`sessionId` 由空变非空时少调一次 `useSessions`），
  面板内 hook 槽位整体错位，`useMemo` 比较上一轮 deps 时读到 `undefined` 即抛错；异常被错误边界兜住后，
  面板要等 key 变化重挂载才恢复，表现为「首次打开闪一下才有内容」。
  现在：hook 调用次数钉死（固定 3 次会话 selector + 1 次节点 selector，缺哪一路用占位钩子顶替），
  `state.tree` / `state.visible` 统一按数组兜底，错误边界改为静默降级 + 退避重试（≤5 次）；
  面板首帧即可稳定出目录，不再依赖重挂载自愈。

### Changed

- **文档：README 默认语言改为中文。** 语言约定统一为 `README.md`（中文，默认入口）+
  `README.en.md`（英文），两版顶部互链；`README.zh-CN.md` 已并入 `README.md`
  （内容不变，仅文件名与默认入口调整）。`CONTRIBUTING.md` 的同步要求随之更新，
  `files` 改为分发 `README.en.md`。
- **文档：安装命令的版本引用改为 `#v1.3.1`。** 此前写的是 `#v1.3.0`，而该标签从未发布 ——
  照 README 的「优先用不可变 tag」安装会因引用解析失败而直接报错。同时把「跟踪开发分支」的
  括注由「尚未发布 tag 时用这个」改为「需要尚未发布的最新提交时用这个」，避免与已发布的 tag 自相矛盾。
- **文档：安装命令的版本引用同步到 `#v1.3.2`。** `README.md` 与 `README.en.md` 两版同步。

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
