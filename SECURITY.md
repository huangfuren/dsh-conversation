# Security Policy

## 这个插件的威胁模型

`dsh-conversation` 是一个**纯客户端 UI 插件**：它只把当前会话组织成一棵可导航的大纲，
不参与任何模型交互。理解它"能碰到什么"比读通用安全条款有用。

**它读取什么**

- 当前会话的 session snapshot（**只读**），用于构建大纲。数据来源（按优先级）：
  - 宿主注入的 `sessions` 服务：`ctx.reflect.get('sessions')` → `sessions.list` / `sessions.binding(id).getSnapshot()`；
  - 宿主注入的 `uiSession` 服务：`uiSession.current` → `hooks.chat` / `hooks.session` 读取同一份快照；
  - 若宿主通过槽位 props 传入同名 hook（`useChat` / `useSession` / `useSessions`），则优先使用；
  - 所有路径都**只读**、结果做 `Array.isArray` 归一、异常全部吞掉并降级为空态；不写回、不发送；
- 页面上会话区域的 DOM（只读），用于把大纲行定位到正文并滚动高亮。

**它写入什么**

- 仅浏览器 `localStorage`，键前缀 `dsh-conversation:`，内容是：面板开关与位置、视图档位、
  刻度条开关、默认展开层级、**每会话的收藏条目与阅读位置**。
- 导出功能走内存 `Blob` + `URL.createObjectURL`，不请求宿主、不写入工作区。

**它不做的事**

- 不发任何网络请求，不接触 provider 凭证，不读写 `.credentials.yaml`；
- 不注册宿主路由或工具，不修改会话内容、提示词或工具结果；
- 不把任何数据送出浏览器。

## 需要注意的边界

1. **收藏与阅读位置会把大纲条目的文本存进 `localStorage`**。若浏览器配置在同一台机器上被他人使用，
   或启用了云同步扩展，这些片段可能被读到。它只包含大纲条目（提问首行 / Markdown 标题），
   不含工具结果与完整消息体。
2. **点击定位依赖宿主 DOM 契约**（`data-chat-anchor-key` / `data-message-key` / `data-node-key`，
   回落到 `data-chat-flow-kind` + 文本前缀校验）。文本校验是**前缀匹配**，理论上在内容高度重复的
   会话里可能命中相邻的同文本节点；定位失败时会提示「当前节点暂不可定位」，不会静默错位滚动。
3. **宿主 API 改名只降级自身**：`slots` / `sessions` 形状逐层探测，缺失或改名时面板自行禁用并打印
   警告，不会影响同槽位的其它插件——这是 fail-closed 的取舍：宁可没有面板，不拖垮宿主。

## 上报

发现安全问题请**不要**开公开 issue，直接邮件联系仓库作者（见 `package.json` 的 `author` /
`bugs`），或使用 GitHub 的私有漏洞上报（Security → Report a vulnerability）。请附上复现步骤、
影响面判断，以及你使用的 dsh 版本与浏览器版本。

- **首次运行会打印一次性诊断日志**：快照的**形状/键名/行数**、以及宿主 DOM 契约的**缺项清单**；
   日志**不含任何会话文本、标题或消息内容**，每个进程每类只打一次。
