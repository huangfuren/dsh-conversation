# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
每条修复写清**之前的行为 vs 现在的行为**，而不是只写结论。

## [Unreleased]

## [1.5.6] - 2026-11-04

### Fixed

- **hover 预览闪现约 45ms 就消失（v1.5.4 起的回归，issue #4 重开）。**
  之前的行为：v1.5.4 为「正文滚动后预览留在旧位置」加了滚动清预览，并把它放进
  「阅读位置跟随」effect 挂载时的立即调用里；而 `getState()` 每次调用都新造对象，
  依赖 `state` 的 effect 于是每轮渲染都重跑 —— 任何本地重渲染（hover 自己、搜索
  输入、透明度拖动）都会在下一帧把刚出现的预览清掉。实测预览插入后 ~45ms 即被
  移出 DOM，指针停在行内也不再复活。现在的行为分三层：
  ① `OutlineManager.getState()` 改为快照缓存 —— 同一次变更周期内返回同一引用，
  只有 `notify()`（以及不走 notify 的 `revealNode` 落空分支、`performSearch`）
  才失效，依赖 `state` 的 effect 只在真实数据/会话变化时重跑，顺带消掉了每轮
  渲染的 O(全树) `flattenVisible` 现算与滚动监听器拆除重挂；
  ② effect 挂载时的立即调用拆出 `syncActive()`，只同步阅读位置，绝不碰预览；
  ③ 滚动回调里的清预览加 scrollTop 真实变化守卫（`lastScrollTopRef` 跨重跑保留
  基准）——「收到 scroll 事件」不等于「真滚动了」，位置没动就不清。
  真实滚动、mouseleave、Enter 跳转、Escape 四条清预览路径全部保持。
  新增 `test/preview-flash.test.js` 9 例：快照引用稳定性 5 例 + effect 结构断言 4 例。

### Docs

- README（中英）：安装示例的不可变 tag 从 `v1.5.0` 升到 `v1.5.5`；「收起态」与「状态持久化」两处按 1.5.5 的
  实际行为改写 —— 刻度条 / 胶囊代码已就地注释保留（搜「停用保留」），`rail` 开关字段不再读取而是被忽略。
  顺带补齐英文版两处长期缺失的内容（dsh 0.2.x 适配说明、三档宽度的生长方向规则），并删掉首屏占位一段里
  自相矛盾的括注「no more empty-state flash」（同一句前半段说的正是"可能先渲染一次空态"）。
  随 1.5.6 发布，安装示例的 tag 再次升到 `v1.5.6`。

## [1.5.5] - 2026-11-03

### Changed

- **把已停用的刻度条 / 胶囊按钮代码就地注释保留，并逐段写明原因。** 这不是功能改动，
  运行时行为与 v1.5.4 完全一致：右侧刻度条（`.dsh-conv-rail` 全部样式、`SessionRail`、
  `HistoryOutlineRailWrapper`）与右上角胶囊（`.dsh-conv-fab`）自 `7a525af`「remove duplicate
  rail」起不再被挂载，代码却一直留在原处，读代码的人会误以为该功能只是被关掉了。本次给每段
  加上「停用保留」说明块，写清三件事：**失效原因**（渲染点在哪个 commit 移除、当前没有可达路径）、
  **保留原因**（留待功能重启时复用，不删以便原地恢复）、**恢复方式**（去掉注释标记并恢复组件与槽位注册）。
  涉及：CSS 两段（`.dsh-conv-fab` 约 20 行、`.dsh-conv-rail` 约 80 行）、`SessionRail` 与
  `HistoryOutlineRailWrapper` 两个组件、六条刻度条文案（含两条错放在中文词典里的英文残留）、
  store 的 `rail` 字段、`prefers-reduced-motion` 中指向这两个不存在 class 的两个选择器，
  以及槽位文档里描述刻度条的第 3 条。老 localStorage 中的 `rail` 键不会被清除，只是不再读取。

## [1.5.4] - 2026-11-03

### Fixed

- **触屏 / 触控笔上拖不动面板，且会把 `pointermove` 永久留在 `window` 上。**
  之前的行为：`.dsh-conv-header` 没有 `touch-action`，浏览器把「按住标题栏拖动」当成滚动手势，
  中途发 `pointercancel`；代码只监听 `pointerup`，于是监听器既不解除、也不写库，之后鼠标随便
  移动一下面板就跟着跑，每次取消再叠一份。现在的行为：标题栏声明 `touch-action: none`；同时监听
  `pointercancel`，取消时收掉三个监听并把内联 `left/top/right` 还原成拖拽前那份（不写 localStorage
  —— 半途的位置是意外，不该被持久化）；组件卸载时也会主动回收未结束的拖拽。
- **停靠态在窄窗口下整块从左边溢出。** 之前的行为：`clampPlacementToViewport()` 只处理拖拽态
  （有 `left`），停靠态用的是 `right: 16`，窗口比「面板宽 + 边距」还窄时左缘算成负值
  （全屏档 720 落在 700 宽的窗口里 ⇒ `left = -36`），面板左边一截被裁掉。现在的行为：右锚点
  折算成 `left: 0` 并去掉 `right`，贴住左缘、右侧被裁；窗口够宽时仍然走右锚点，不会把面板
  钉死在左边。
- **hover 预览翻到左侧时压住行首 10px。** 之前的行为：行内先把「让出 340px + 8px」算进坐标，
  `previewPlacement()` 又加一次 20px 间距，净结果是右侧弹出间距 28px、左侧弹出反倒压进行里 10px。
  现在的行为：行内只给「行的哪一条边」，间距统一由 `previewPlacement()` 加；翻侧判据也从事先的
  「行在不在窗口右半边」换成 `previewSideFor()` 的「右缘 + 间距 + 浮层宽还放不放得下」——
  窄窗口里行还靠左、浮层其实已经放不下时也能正确翻侧。
- **正文滚动后预览浮层留在旧位置。** 之前的行为：浮层只由 `mouseleave` 收起，而用滚轮滚动时
  鼠标没动、行自己滑走了，浏览器不会补发 `mouseleave`，于是浮层悬在旧坐标上盖住别的行。
  现在的行为：正文滚动（rAF 节流那一拍）里顺手清掉预览。

### Changed

- README（中英）：删掉 1.3.1 起已停用、但文档仍在宣称的三个东西 —— 右侧刻度条、右上角胶囊
  兜底、底栏刻度条开关；改为说明「收起态唯一入口是标题栏按钮」。同时删掉三档宽度行尾误挂的
  `Alt+↑/↓`（那是节点跳转快捷键，不是换档）。

## [1.5.3] - 2026-11-03

### Fixed

- **hover 大纲行看不到预览浮层（1.4.0 起的回归，issue #4 A）。**
  之前的行为：1.4.0 把背景模糊写在 `.dsh-conv-panel` 本体上（`backdrop-filter`），
  按 CSS 规范该属性会让面板成为 `position: fixed` 后代的**包含块**，于是面板内的
  `.dsh-conv-preview` 不再相对视口定位，而是按面板原点偏移；面板自身又是 `overflow: hidden`，
  跑偏的浮层被直接裁掉 —— 元素在 DOM 里、内容也对，用户就是看不见。实测（Chromium 138）：
  行 `[43,267,308,30]`、面板 `[36,82,322,609]`、浮层 `[416,369,39,202]`，
  `elementFromPoint` 命中的是正文而不是浮层。
  现在的行为：模糊与底色一起挪到 `.dsh-conv-panel::before`（`inset: 0` / `z-index: -1` /
  `pointer-events: none`），面板本体只留 `background: transparent`。伪元素不参与包含块判定，
  面板内的 fixed 浮层重新以视口为包含块，也不再被 `overflow: hidden` 裁剪；
  玻璃观感（半透明色 + 背景模糊）保持不变，已用无头 Chromium 截图确认背后的斜条纹与色带
  仍然是糊的。
- **预览浮层在窄窗口下算出负坐标。**
  之前的行为：落点是 `left: min(x + 20, innerWidth - 380)`，窗口宽度不足 380px 时 `left`
  为负，浮层跑到视口左侧外面；`top` 则完全没有约束，靠底部悬停时浮层越出视口下沿。
  现在的行为：抽成 `previewPlacement()`，右侧放不下就往左夹、底部放不下就上移，
  最小边距 8px；视口未知（单测 / 非浏览器）时保持原始偏移，不瞎猜。

### Changed

- **透明度滑杆的文案与真实语义对齐（issue #4 B）。** 之前标签写「面板透明度」、tooltip 写
  「面板背景透明度」，两处口径不一致，也没说模糊是跟着反向变化的，用户容易以为自己在调模糊、
  或者以为 90% 以上「模糊坏了」。现在中英文都统一为**背景不透明度**，tooltip 明确写出
  取值范围（40–100%）、只影响背景不动文字、越低越透且背后模糊越强。**行为没有变**，只改文案。
  说明写进了 README（中英）：模糊由不透明度反向派生，是设计使然。

## [1.5.2] - 2026-11-03

### Fixed

- **窗口被拉窄后整块面板落在视口外，表现为「点『历史提问 · 大纲』什么都没出来」，窗口最大化后又正常。**
  之前的行为：拖拽坐标（`left` / `top`）按当时的窗口写进 `localStorage` 之后从不校验视口，
  换成更窄的窗口（或更小的显示器）时 `left` 可能大于 `innerWidth`（实测现场是
  `left: 1386` / 视口 1080，320px 的面板右缘落在 1706），`position: fixed` 的元素被整块甩到
  可视区之外；`top` 同理会把面板推到窗口底边以下。**这个问题在 1.5.1 之前就存在**，与换档方向
  无关 —— 只要拖过一次面板、之后窗口变窄就会触发。
  现在的行为：渲染时统一走 `clampPlacementToViewport()` —— `left` 夹进 `[0, innerWidth - width]`，
  `top` 保证至少露出 80px 标题栏（够把它拖回来）；**不回写**持久化值，窗口拉回去时位置仍在原处。
  另加 `useViewportTick()`，在窗口尺寸变化时重渲染一次（rAF 节流），拖动窗口过程中不会停留在旧坐标。
  新增 5 例测试：真实事故坐标（1386 @ 1080 视口）、`top` 越界、停靠态不受影响、渲染链路、
  全屏档窗口窄于面板时贴住左缘。

## [1.5.1] - 2026-11-03

### Fixed

- **三档宽度换档时的生长方向 —— 贴左向右、贴右向左、居中两侧对称。** 之前的行为：拖拽过的面板
  （`left` 已写入 `localStorage`）固定左缘，宽度只向右长；连续加宽到全屏时右缘一路顶出窗口，
  被 `position: fixed` 裁掉，且右侧栏被压住。停靠态则相反（固定右缘向左长），同一个按钮在两个
  状态下方向相反，与标题栏的双向箭头图标也不一致。现在的行为：按**面板离窗口边缘的距离**判断
  贴边（阈值 `EDGE_SNAP = 32px`，覆盖默认停靠的 16px 边距与拖拽松手的抖动）—— 贴右锚原右缘向左长、
  贴左锚原左缘向右长；居中则中心不动、两侧各长一半，**某一侧空间不够时差额全部转给另一侧**
  （左只剩 100、需要长 400 ⇒ 左扩 100、右扩 300，而不是只长一半再把面板推回窗口内）。
  任何情况下新坐标都夹在窗口内，所以不存在「加宽后越界」。缩窄时同一规则反向生效：贴右面板缩回
  紧凑档会退回原来的左缘（右缘恒为 1184），不再漂移。
  新增 `test/placement.test.js`（14 例）：三种锚定、居中单向不足时的补位、连续换档、已越界坐标、
  窗口窄于面板、脏 `left`，以及点按钮 → `localStorage` → 重新渲染的完整链路（防止 `store.set`
  漏带 `left` 这类接线错误）。

## [1.5.0] - 2026-11-02

### Added

- **标题栏「大纲」按钮自适应（icon-only）—— 复用宿主原生容器查询机制。** 之前的行为：按钮恒为
  「svg + 文字」整块 —— 右侧边栏展开时宿主把自己的标题栏按钮收成图标（原生 label 在
  `@container (width<=540px)` 下 `display:none`），而本按钮仍占整块宽，与相邻功能**重叠**。
  现在的行为：给按钮的文字 span 注入**同一条件**的容器查询（容器同为宿主声明
  `container-type: inline-size` 的 `.wSkVaW_titleRow`，阈值同为 540px）⇒ 右栏展开（titleRow ≤ 540px）
  时文字隐藏、按钮**真实收窄**为图标宽（glyph + padding），与原生按钮同帧收起/还原；span 保持
  挂载（与原生 label 同款处理），`aria-label` / `title` / `type=button` 不受影响，可点击、可键盘聚焦。
  判定条件与原生阈值（540px）相同（比较时归一空白；阈值取自宿主源码并由测试锁定该常量；宿主改阈值时测试不会自动发现）；宿主无该容器的旧版本 ⇒ 查询不命中 ⇒
  保持宽态（降级安全，与原生行为一致）。新增判据 `test/icon-only.test.js`：来源一致性（条件归一空白后与原生相等）、选择器对位、两态布局模拟（宽度由解析产物 CSS 驱动，窄态 < 全宽 60%）、
  降级断言，及 2 组变异自证。

- **一次性兼容性诊断日志（快照形状 + 宿主 DOM 契约）。**
  - 之前的行为：插件对宿主 DOM 属性（`data-chat-anchor-key` / `data-message-key` / `data-node-key` /
    `data-chat-flow-kind` / `data-conversation-scroll`）和会话快照结构（`legacy.nodes` / `nodes` /
    `chat.{order,nodes}` …）都做多候选兼容，但降级是**静默**的：宿主改名后用户只看到「点了不跳」或
    「面板空着」，控制台没有任何可排查的线索，也无从判断当前用的是哪一代契约。
  - 现在的行为：首次拿到可识别的快照（0 行也记录）时打印一条 `console.info`，记录实际结构与本轮行数
    （例如 `session snapshot shape: legacy.nodes (12 rows)`）；结构陌生但明显像 ChatSnapshot 时打印一条
    `console.warn` 并列出实际键名。首次渲染出大纲时探测 DOM 契约：齐全打一条 info；缺失/改名打一条
    warn，明确写出缺哪些属性、以及已降级为「按文本顺序匹配」而不是「按 key 精确定位」。
    两类日志每次页面加载最多各一条（`resetDiagnostics()` 仅供测试），不刷屏、不改变任何容错行为。
  - 回归判据：新增 `test/diagnostics.test.js` —— DOM 契约齐全 / 缺项 / 只有等价锚点的探测矩阵；健康与
    降级两种日志都只输出一次；快照形状矩阵（含 `nodes.values` 与陌生形状）；陌生形状告警；数据尚未
    到达（`undefined` / `{}`）时不消耗那次机会。

### Fixed

- **修 props hook 路径的无限重渲染（legacy `chat.{order,nodes}` 快照）。** 新增服务路径后，
  节点 hook 先取原始快照、再在 hook 外做 `safeNodesOf` 归一；对 `chat.{order,nodes(Map)}` 这类旧
  契约每次归一都会分配新数组，`activeNodes` / `items` 身份每轮变化，面板既有的 `bump()` effect
  因此无限重渲染（真实 React：`Maximum update depth exceeded`）。现在用 identity 选择器 + `useMemo`
  按原始快照身份缓存归一结果；同时把槽位组件新增 hook 移到提前 return 之前（store 由缺席变存在时
  hook 数量恒定）。回归：`harness2` 新增 legacy 形状用例，修复前无限循环、修复后 9/9 无崩溃。

- **槽位 props 为空时不再「永远空态」：面板改从宿主服务（`sessions` / `uiSession`）取当前会话快照。**
  - 之前的行为：面板只从 slot props 的 `useChat` / `useSession` / `useSessions` 取数据。宿主在
    `conversation.session.header.actions` 上以 `renderSlot(..., {})` 渲染（dsh 0.2.0-rc.2 的
    `dsh-client-ui-conversation/lib/client.js:16502`），owner props 为空；第三方 header（如
    `dsh-better-sidebar`）接管 header 区时 props 形状也可能不同 ⇒ 三条 hook 全缺席时面板永远停在
    「暂无大纲内容」，而顶部「大纲」按钮看起来一切正常，用户没有任何可排查的线索。
  - 现在的行为：`apply()` 把 cordis 的 `sessions` / `uiSession` 服务捕获进插件私有的 host bridge
    （经 `ctx.reflect.get(name, false)` 只读探测，缺失/抛错都降级为 `undefined`），槽位包装器把
    `store` / `host` **最后**合并进 props。面板优先用 slot props 的 hook（props 存在时仍以 props 为准），缺失时读
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
    的占位外壳（「正在读取会话…」，`role="status"` + `aria-busy="true"`），会话绑定就绪后才挂载面板组件（若绑定先到、chat 快照稍后写入，面板可能先以空态渲染一次，下一次快照更新即补上）；最长
    等 2 秒（`PANEL_READY_TIMEOUT_MS`），超时仍照常挂载并展示空态，避免宿主某版本不再 retain 会话时
    永远停在占位。没有可读服务源（旧宿主 / 独立渲染）时保持 1.3.1 的直接挂载；仅有 sessions.binding 而无 list/current 的宿主会按未就绪处理（最多 2 秒占位）。
  - 回归判据：`test/host-service.test.js` 新增 3 条 —— `panelMountStateOf` 的状态矩阵（无服务 / 未就绪 /
    超时 / 就绪）；未就绪时只出现占位、不出现面板空态；从未就绪切到就绪时槽位组件**自身**的 hook 序列
    不变（断言里按 depth 把子组件 hook 排除）。

- **首屏占位沿用面板的背景透明度。** 之前占位外壳只复用面板的定位（`outlinePanelPlacement`），没写
  `--dsh-conv-bg-alpha` / `--dsh-conv-bg-blur`，CSS 里这两个变量缺省回落 100% ⇒ 把透明度拉到 40%
  再刷新时，占位窗口（最长 2 秒）恒为完全不透明，会话就绪的瞬间会「跳」到设定值。现在定位与透明度
  收进同一个 `panelSurfaceStyle()`，占位与真面板共用，外观从第一帧起一致。回归：
  `test/host-service.test.js` 新增「占位携带设定透明度」；`test/client.test.js` 覆盖
  `panelSurfaceStyle` 的三条分支（支持 / 不支持 color-mix 时只留定位 / 脏 chrome 回落 100% + 默认停靠位）。


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
