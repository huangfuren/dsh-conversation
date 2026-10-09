# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
每条修复写清**之前的行为 vs 现在的行为**，而不是只写结论。

## [Unreleased]

### Changed

- **文档：README 默认语言改为中文。** 语言约定统一为 `README.md`（中文，默认入口）+
  `README.en.md`（英文），两版顶部互链；`README.zh-CN.md` 已并入 `README.md`
  （内容不变，仅文件名与默认入口调整）。`CONTRIBUTING.md` 的同步要求随之更新，
  `files` 改为分发 `README.en.md`。

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
