/**
 * dsh-conversation client half — 会话大纲面板（历史提问 + Markdown 标题树）。
 *
 * 由两个插件合并而来（2026-09-20）：
 * - 原 dsh-client-hqst：右上浮动面板，列出本会话的用户提问，点击跳转并高亮；
 * - 原 dsh-outline：大纲树（用户提问为 level 0，Assistant 回复里的 ATX 标题为
 *   level 1~6），含层级滑块、搜索、收藏、复制、阅读位置跟随、DOM 顺序锚定。
 *
 * 融合后的可见性只有两态（localStorage 持久化）：
 * - pinned = true（默认）：右上常驻面板，标题栏可拖动；
 * - pinned = false：右上角胶囊「历史提问 · 大纲 (N)」，点一下回来。
 *
 * 与 dsh-outline 的差异（有意保留原 hqst 的性格）：
 * - 用户提问行额外显示提问时间；
 * - 面板默认常驻（原 outline 默认是右缘触发条 + hover 预览）；
 * - 不依赖宿主 i18n 命名空间（原 hqst 也没有）：宿主若注入了可用的 `t`
 *   就优先用它，否则按 navigator.language 在自带 zh/en 字典间回落。
 */
/* 排查期结束：不再往页面里插调试红框，线索一律走 console。 */

window.__ModuleLoader__.load({
	id: "dsh-conversation",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const Fragment = React.Fragment;
		const {
			useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore,
		} = React;

		/* 诊断兜底：宿主 React 若没有 useSyncExternalStore，用 useState/useEffect 等价实现 */
		const useSyncExternalStoreSafe = typeof useSyncExternalStore === "function"
			? useSyncExternalStore
			: function (subscribe, getSnapshot) {
				const [value, setValue] = useState(getSnapshot);
				useEffect(() => {
					const unsub = subscribe(() => setValue(getSnapshot()));
					setValue(getSnapshot());
					return typeof unsub === "function" ? unsub : undefined;
				}, [subscribe, getSnapshot]);
				return value;
			};
		/* 诊断开关：先只渲染按钮、暂不渲染展开面板，用来判断异常是否来自面板 */
		const DIAG_NO_PANEL = false;

		/* 诊断：渲染阶段标记。边界捕获异常时读取最后一次到达的位置，直接定位崩点 */
		function stg(name) { try { window.__dshStage = name; } catch (e) {} }

		/* 稳定钩子：宿主 props 在不同渲染间可能新增/移除 hook 工厂，
		   若直接条件调用会导致 hook 顺序漂移（表现为 useMemo 读取上一轮槽位拿到
		   非数组，抛 "reading 'length'"）。这里用等价的占位钩子把数量钉死。 */
		const EMPTY_NODES = [];
		/* 稳定 identity selector：传进宿主 hook 的选择器身份必须跨渲染不变（否则 selector 本身也会触发重算）。 */
		const IDENTITY_SNAPSHOT = (snapshot) => snapshot;
		function useNoSession(selector) { return useState(undefined)[0]; }
		function useNoNodes(selector) { useState(0); return EMPTY_NODES; }
		/* selector 必须是模块级稳定引用：每轮 new 一个会让 useSyncExternalStore 反复比对 */
		const SEL_HAS_MORE = (s) => (s !== null && s !== undefined && s.hasMore === true);
		const SEL_LOADING_OLDER = (s) => (s !== null && s !== undefined && s.loadingOlder === true);
		const SEL_CURRENT_ID = (s) => (s !== null && s !== undefined && typeof s.current === "string" ? s.current : null);
		/* store 迟到时的占位（只为把 hook 数量钉死，不会被真正渲染） */
		const EMPTY_CHROME = { pinned: false, view: "panel" };
		const EMPTY_STORE = {
			subscribe: () => () => {},
			getSnapshot: () => EMPTY_CHROME,
			set: () => {},
		};

		/* 错误边界：面板子树异常时安静降级（不拖垮按钮、不弹红框），只留一行 console 线索 */
		class PanelBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { err: null };
				this.retried = 0;
			}
			static getDerivedStateFromError(err) {
				return { err };
			}
			componentDidCatch(err) {
				try {
					console.warn("[conversation] outline panel crashed; degraded to blank",
						err && err.message ? err.message : err, "· stage:", window.__dshStage || "(未标记)");
				} catch (e) {}
				/* 面板常在"会话数据还没铺好"时就先渲染一次，此时抛错属可恢复：
				   放一个小退避后清掉错误状态重试，最多 5 次，避免死循环。 */
				if (this.retried < 5) {
					this.retried += 1;
					window.setTimeout(() => {
						try { this.setState({ err: null }); } catch (e) {}
					}, 250 * this.retried);
				}
			}
			render() {
				if (this.state.err) return null;
				return this.props.children;
			}
		}

		// 包自带样式：materialize 时注入一次，交给模块系统用 data-plugin 认领
		// （随插件一起卸载）。全部走 dsw-alias-* / dsw-shadow-* 主题令牌。
		const CSS_TEXT = `
      .dsh-conv-header-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 0 8px;
        height: 24px;
        background: var(--dsw-alias-fill-tsp-secondary, rgba(0, 0, 0, 0.05));
        color: var(--dsw-alias-label-secondary, #3c3d43);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        white-space: nowrap;
        transition: background-color 0.15s ease, color 0.15s ease;
      }
      .dsh-conv-header-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.08));
        color: var(--dsw-alias-label-primary, #0f1115);
      }
      .dsh-conv-header-btn-active {
        background: var(--dsw-alias-state-business-tertiary, #e4edfd);
        color: var(--dsw-alias-state-business-primary, #4176e6);
        font-weight: 500;
      }
      /* ①(2026-11-01 PR#2 适配点 2·第3版) 右栏展开 ⇒ 标题栏变窄 ⇒ 按钮收成 icon-only。
         机制与宿主原生按钮**完全一致**（照抄，非自造测量）：
         · 容器 = .wSkVaW_titleRow（宿主 dsh-client-ui-conversation 对它声明
           container-type: inline-size —— 本按钮是该容器的后代）；
         · 条件 = @container (width <= 540px)，与原生「智能体团队」按钮的 label 同一阈值
           （宿主 dsh-client-ui-agent-preset：@container (width<=540px){.SVAs4q_label{display:none}}）；
         · 效果：titleRow ≤ 540px（右栏展开）⇒ 文本 span display:none ⇒ 按钮真实收窄为
           glyph 固有宽 + padding；span 仍挂载（与原生 label 同款处理），aria-label/title
           在按钮上不受影响，可点击/可键盘聚焦不变。
         · 降级：宿主无该容器（旧版）⇒ 容器查询不命中 ⇒ 保持宽态（不误收、不报错）。 */
      @container (width <= 540px) {
        .dsh-conv-header-btn .dsh-conv-header-btn-text {
          display: none;
        }
      }
      .dsh-conv-panel {
        position: fixed;
        display: flex;
        flex-direction: column;
        height: min(75vh, calc(100vh - 100px));
        pointer-events: auto;
        /* 底色与模糊都交给 ::before（见下）：backdrop-filter 一旦落在面板本体上，
           面板就会成为 fixed 后代的包含块，行内预览浮层（.dsh-conv-preview 是
           position: fixed）会改按面板原点定位，再被这里的 overflow: hidden 裁掉
           —— 1.4.0 引入模糊后的回归，hover 预览整个看不见。 */
        background: transparent;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        border-radius: 12px;
        box-shadow: 0 1px 2px rgba(15, 17, 21, 0.04), 0 8px 28px rgba(15, 17, 21, 0.1);
        color: var(--dsw-alias-label-primary, #0f1115);
        font-family: var(--dsw-font-family, sans-serif);
        font-size: 14px;
        line-height: 1.5;
        overflow: hidden;
        z-index: 1000;
      }
      /* 面板的「玻璃」层：背景色 + 背景模糊都画在这里。
         伪元素不参与面板的包含块判定，所以面板内 position: fixed 的预览浮层
         仍然相对视口定位（也不会被 overflow: hidden 裁剪）。
         透明度用 color-mix 掺在底色上，而不是给整块加 opacity——后者会把正文一起淡掉；
         color-mix 不被支持时这一行在解析阶段就被丢弃，自动回落到上面那行纯色。 */
      .dsh-conv-panel::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: var(--dsw-alias-bg-layer-1, #fff);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) var(--dsh-conv-bg-alpha, 100%), transparent);
        -webkit-backdrop-filter: blur(var(--dsh-conv-bg-blur, 0px));
        backdrop-filter: blur(var(--dsh-conv-bg-blur, 0px));
        pointer-events: none;
        z-index: -1;
      }
      .dsh-conv-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 8px 10px 12px;
        cursor: grab;
        user-select: none;
        /* 触屏 / 触控笔上必须声明：否则浏览器会把「按住标题栏拖动」当成滚动手势，
           拖到一半发 pointercancel，面板完全拖不动（安卓 WebView、触屏 Windows 都会）。 */
        touch-action: none;
        flex-shrink: 0;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.05));
      }
      .dsh-conv-header:active { cursor: grabbing; }
      .dsh-conv-headerglyph {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--dsw-alias-state-business-primary, #4176e6);
      }
      .dsh-conv-history-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 10px;
        background: var(--dsw-alias-fill-tsp-quaternary, rgba(0, 0, 0, 0.02));
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.05));
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary, #65666b);
      }
      .dsh-conv-history-btns {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .dsh-conv-histbtn {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 6px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        border-radius: 4px;
        background: var(--dsw-alias-bg-layer-1, #fff);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) var(--dsh-conv-bg-alpha, 100%), transparent);
        color: var(--dsw-alias-label-secondary, #3c3d43);
        font-size: 11px;
        cursor: pointer;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      .dsh-conv-histbtn:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
        border-color: var(--dsw-alias-state-business-primary, #4176e6);
        color: var(--dsw-alias-state-business-primary, #4176e6);
      }
      .dsh-conv-histbtn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .dsh-conv-title {
        flex: 1;
        min-width: 0;
        font-weight: 600;
        font-size: 14px;
        letter-spacing: 0.01em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsh-conv-iconbtn {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: none;
        color: var(--dsw-alias-label-tertiary, #65666b);
        cursor: pointer;
        text-decoration: none;
        transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
      }
      .dsh-conv-iconbtn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
        color: var(--dsw-alias-label-primary, #0f1115);
      }
      .dsh-conv-iconbtn:active { transform: scale(0.9); }
      .dsh-conv-iconbtn:focus-visible {
        outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
        outline-offset: 1px;
      }
      .dsh-conv-iconbtn-active {
        color: var(--dsw-alias-state-business-primary, #4176e6);
        background: var(--dsw-alias-state-business-tertiary, #e4edfd);
      }
      .dsh-conv-iconbtn-copied { color: var(--dsw-alias-state-success-primary, #18a058); }
      .dsh-conv-toolbar {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 8px 10px 4px;
        flex-shrink: 0;
      }
      .dsh-conv-searchbox {
        position: relative;
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        margin-left: 4px;
      }
      .dsh-conv-searchicon {
        position: absolute;
        left: 9px;
        display: inline-flex;
        color: var(--dsw-alias-label-caption, #adb2b8);
        pointer-events: none;
      }
      .dsh-conv-search {
        width: 100%;
        height: 30px;
        padding: 0 26px 0 28px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        border-radius: 8px;
        background: var(--dsw-alias-bg-base, #fff);
        background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) var(--dsh-conv-bg-alpha, 100%), transparent);
        color: var(--dsw-alias-label-primary, #0f1115);
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .dsh-conv-search::-webkit-search-cancel-button,
      .dsh-conv-search::-webkit-search-decoration {
        -webkit-appearance: none;
        appearance: none;
        display: none;
      }
      .dsh-conv-search::placeholder { color: var(--dsw-alias-label-caption, #adb2b8); }
      .dsh-conv-search:hover { border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.14)); }
      .dsh-conv-search:focus {
        border-color: var(--dsw-alias-state-business-primary, #4176e6);
        box-shadow: 0 0 0 3px var(--dsw-alias-state-business-tertiary, #e4edfd);
      }
      .dsh-conv-searchclear {
        position: absolute;
        right: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border: none;
        border-radius: 5px;
        background: none;
        color: var(--dsw-alias-label-tertiary, #65666b);
        cursor: pointer;
        transition: background-color 0.15s ease, color 0.15s ease;
      }
      .dsh-conv-searchclear:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
        color: var(--dsw-alias-label-primary, #0f1115);
      }
      .dsh-conv-slider {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 16px 10px;
        flex-shrink: 0;
      }
      .dsh-conv-sliderdots {
        position: relative;
        flex: 1;
        display: flex;
        justify-content: space-between;
        align-items: center;
        height: 20px;
      }
      .dsh-conv-slidertrack {
        position: absolute;
        left: 6px;
        right: 6px;
        top: 50%;
        height: 3px;
        transform: translateY(-50%);
        background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.1));
        border-radius: 2px;
      }
      .dsh-conv-sliderprogress {
        height: 100%;
        background: var(--dsw-alias-state-business-primary, #4176e6);
        border-radius: 2px;
        transition: width 0.18s ease;
      }
      .dsh-conv-dot {
        position: relative;
        width: 12px;
        height: 12px;
        padding: 0;
        border: 2px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.16));
        border-radius: 50%;
        background: var(--dsw-alias-bg-layer-1, #fff);
        cursor: pointer;
        transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .dsh-conv-dot:hover {
        transform: scale(1.3);
        border-color: var(--dsw-alias-state-business-primary, #4176e6);
      }
      .dsh-conv-dot-active {
        border-color: var(--dsw-alias-state-business-primary, #4176e6);
        background: var(--dsw-alias-state-business-primary, #4176e6);
      }
      .dsh-conv-dot-current { box-shadow: 0 0 0 3px var(--dsw-alias-state-business-tertiary, #e4edfd); }
      .dsh-conv-sliderlabel {
        flex: none;
        min-width: 34px;
        text-align: right;
        font-size: 12px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-tertiary, #65666b);
      }
      .dsh-conv-appearance {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 14px 8px;
        flex-shrink: 0;
        color: var(--dsw-alias-label-tertiary, #65666b);
      }
      .dsh-conv-appearance-glyph {
        flex: none;
        display: inline-flex;
        align-items: center;
        color: var(--dsw-alias-label-caption, #adb2b8);
      }
      .dsh-conv-appearance-glyph > svg { width: 13px; height: 13px; }
      .dsh-conv-opacity {
        flex: 1;
        min-width: 0;
        height: 16px;
        margin: 0;
        padding: 0;
        background: transparent;
        accent-color: var(--dsw-alias-state-business-primary, #4176e6);
        cursor: pointer;
      }
      .dsh-conv-opacitylabel {
        flex: none;
        min-width: 40px;
        height: 20px;
        padding: 0 4px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-label-tertiary, #65666b);
        font-family: inherit;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        text-align: right;
        cursor: pointer;
        transition: background-color 0.15s ease, color 0.15s ease;
      }
      .dsh-conv-opacitylabel:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
        color: var(--dsw-alias-label-primary, #0f1115);
      }
      .dsh-conv-opacitylabel-max { color: var(--dsw-alias-label-caption, #adb2b8); }
      .dsh-conv-list {
        flex: 1;
        min-height: 80px;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 2px 6px 8px;
        scrollbar-width: thin;
        scrollbar-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18)) transparent;
      }
      .dsh-conv-empty-tip {
        margin-top: 8px;
        font-size: 11px;
        color: var(--dsw-alias-state-business-primary, #4176e6);
        cursor: pointer;
        text-decoration: underline;
      }
      .dsh-conv-list::-webkit-scrollbar { width: 8px; }
      .dsh-conv-list::-webkit-scrollbar-thumb {
        background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
        border: 2px solid transparent;
        border-radius: 4px;
        background-clip: content-box;
      }
      .dsh-conv-item {
        display: flex;
        align-items: center;
        gap: 5px;
        min-height: 30px;
        padding-right: 6px;
        border-radius: 6px;
        cursor: pointer;
        color: var(--dsw-alias-label-secondary, #3c3d43);
        transition: background-color 0.12s ease;
      }
      .dsh-conv-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
      .dsh-conv-item:focus-visible {
        outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
        outline-offset: -2px;
      }
      .dsh-conv-item-active {
        background: var(--dsw-alias-state-business-tertiary, #e4edfd);
        color: var(--dsw-alias-label-primary, #0f1115);
      }
      .dsh-conv-item-user { color: var(--dsw-alias-label-primary, #0f1115); font-weight: 500; }
      .dsh-conv-chevron {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--dsw-alias-label-caption, #adb2b8);
        transition: transform 0.15s ease, color 0.15s ease;
      }
      .dsh-conv-item:hover .dsh-conv-chevron { color: var(--dsw-alias-label-tertiary, #65666b); }
      .dsh-conv-chevron-open { transform: rotate(90deg); }
      .dsh-conv-chevron-hidden { visibility: hidden; }
      .dsh-conv-badge {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 20px;
        padding: 0 5px;
        border-radius: 5px;
        background: var(--dsw-alias-state-business-tertiary, #e4edfd);
        color: var(--dsw-alias-state-business-primary, #4176e6);
        font-size: 12px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .dsh-conv-item-active .dsh-conv-badge {
        background: var(--dsw-alias-state-business-primary, #4176e6);
        color: var(--dsw-alias-label-on-accent, #fff);
      }
      .dsh-conv-itemtext {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }
      .dsh-conv-itemstreaming { animation: dsh-conv-streaming 1.4s ease-in-out infinite alternate; }
      @keyframes dsh-conv-streaming {
        from { opacity: 0.45; }
        to { opacity: 0.7; }
      }
      .dsh-conv-time {
        flex: none;
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary, #65666b);
        font-variant-numeric: tabular-nums;
      }
      .dsh-conv-bookmark {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 5px;
        color: var(--dsw-alias-label-tertiary, #65666b);
        opacity: 0;
        transition: opacity 0.15s ease, color 0.15s ease, transform 0.1s ease;
      }
      .dsh-conv-item:hover .dsh-conv-bookmark,
      .dsh-conv-item:focus-within .dsh-conv-bookmark { opacity: 1; }
      .dsh-conv-bookmark:active { transform: scale(0.85); }
      .dsh-conv-bookmark-active { opacity: 1; color: var(--dsw-alias-state-warn-primary, #f59e0b); }
      .dsh-conv-mark {
        background: var(--dsw-alias-state-warn-tertiary, #fef5e7);
        color: inherit;
        padding: 0 1px;
        border-radius: 3px;
      }
      .dsh-conv-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 40px 16px;
        text-align: center;
        color: var(--dsw-alias-label-tertiary, #65666b);
      }
      .dsh-conv-emptyglyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        border-radius: 10px;
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.05));
        color: var(--dsw-alias-label-caption, #adb2b8);
        margin-bottom: 6px;
      }
      .dsh-conv-emptyglyph > svg { width: 20px; height: 20px; }
      .dsh-conv-emptyhint {
        font-size: 13px;
        line-height: 1.6;
        color: var(--dsw-alias-label-caption, #adb2b8);
      }
      /* ---- 首屏占位：会话数据就绪前只渲染外壳，不挂载面板组件 ---- */
      .dsh-conv-panel-pending {
        height: auto;
        min-height: 96px;
      }
      .dsh-conv-pending-body {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 18px 16px;
        color: var(--dsw-alias-label-tertiary, #65666b);
        font-size: 13px;
      }
      .dsh-conv-pending-dot {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--dsw-alias-state-business-primary, #4176e6);
        animation: dsh-conv-pending-pulse 1.1s ease-in-out infinite alternate;
      }
      @keyframes dsh-conv-pending-pulse {
        from { opacity: 0.3; }
        to { opacity: 1; }
      }
      .dsh-conv-footer {
        display: flex;
        gap: 8px;
        padding: 8px 10px;
        flex-shrink: 0;
        border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.05));
      }
      .dsh-conv-footbtn {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 32px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1, #fff);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) var(--dsh-conv-bg-alpha, 100%), transparent);
        color: var(--dsw-alias-label-secondary, #3c3d43);
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
        transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
      }
      .dsh-conv-footbtn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
        color: var(--dsw-alias-label-primary, #0f1115);
      }
      .dsh-conv-footbtn:active { transform: translateY(1px); }
      .dsh-conv-toast {
        position: absolute;
        left: 50%;
        bottom: 46px;
        transform: translateX(-50%);
        padding: 6px 12px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1, #fff);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) var(--dsh-conv-bg-alpha, 100%), transparent);
        box-shadow: 0 4px 16px rgba(15, 17, 21, 0.12);
        color: var(--dsw-alias-label-secondary, #3c3d43);
        font-size: 13px;
        z-index: 1;
        pointer-events: none;
      }
      .dsh-conv-preview {
        position: fixed;
        max-width: 340px;
        max-height: 240px;
        overflow-y: auto;
        background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.98));
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(15, 17, 21, 0.12);
        padding: 10px 12px;
        font-size: 13px;
        line-height: 1.4;
        color: var(--dsw-alias-label-primary, #0f1115);
        pointer-events: none;
        z-index: 1100;
        word-break: break-word;
        white-space: pre-wrap;
        backface-visibility: hidden; /* prefers-reduced-motion fallback */
      }
      .dsh-conv-preview-label {
        display: block;
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary, #65666b);
        font-weight: 600;
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      /* ==== 停用保留：右上角胶囊按钮样式（.dsh-conv-fab） ====
         失效原因：没有任何组件产出该 class 的元素，1.3.1 起面板收起态的唯一入口是标题栏按钮。
         保留原因：维护者决定留待刻度条功能重启时配套复用，只注释不删除。
         恢复方式：删掉下面代码块首尾的 CSS 注释标记，并重新引入产出该 class 的组件。
         停用日期：2026-11-03（v1.5.4 之后）。 */
      /*
      .dsh-conv-fab {
        position: fixed;
        top: 72px;
        right: 16px;
        padding: 8px 14px;
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-1, #fff);
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        box-shadow: 0 2px 8px rgba(15, 17, 21, 0.08);
        color: var(--dsw-alias-label-primary, #0f1115);
        font-family: var(--dsw-font-family, sans-serif);
        font-size: 13px;
        cursor: pointer;
        pointer-events: auto;
        z-index: 1000;
      }
      .dsh-conv-fab:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
        color: var(--dsw-alias-state-business-primary, #4176e6);
      }
      */
      .dsh-conv-flash { animation: dsh-conv-flash 1.6s ease-out; border-radius: 4px; }
      @keyframes dsh-conv-flash {
        0% { background-color: var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.18)); }
        100% { background-color: transparent; }
      }
      /* ---- 行内统计（工具数 / 字数） ---- */
      .dsh-conv-meta {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: 2px;
      }
      .dsh-conv-metachip {
        font-size: 10px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 4px;
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
        color: var(--dsw-alias-label-tertiary, #65666b);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      /* ---- 搜索范围切换按钮 ---- */
      .dsh-conv-scopebtn {
        flex: none;
        height: 28px;
        padding: 0 7px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        border-radius: 6px;
        background: none;
        color: var(--dsw-alias-label-tertiary, #65666b);
        font-size: 11px;
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 0.15s ease, color 0.15s ease;
      }
      .dsh-conv-scopebtn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
        color: var(--dsw-alias-label-primary, #0f1115);
      }
      .dsh-conv-scopebtn-active {
        color: var(--dsw-alias-state-business-primary, #4176e6);
        border-color: var(--dsw-alias-state-business-primary, #4176e6);
        background: var(--dsw-alias-state-business-tertiary, #e4edfd);
      }
      /* ==== 停用保留：右侧刻度条样式（.dsh-conv-rail 及子类，约 80 行） ====
         失效原因：产出这些 class 的组件 SessionRail / HistoryOutlineRailWrapper 均已停用，
                   页面上不会出现对应元素，样式不生效。
         保留原因：维护者决定留待刻度条功能重启时复用，只注释不删除。
         恢复方式：删掉下面代码块首尾的 CSS 注释标记，并恢复组件与槽位注册。
         停用日期：2026-11-03（v1.5.4 之后）。 */
      /*
      .dsh-conv-rail {
        position: fixed;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 8px 5px;
        max-height: 68vh;
        background: var(--dsw-alias-bg-layer-1, #fff);
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        border-right: none;
        border-radius: 10px 0 0 10px;
        box-shadow: 0 2px 10px rgba(15, 17, 21, 0.08);
        font-family: var(--dsw-font-family, sans-serif);
        pointer-events: auto;
        z-index: 1000;
      }
      .dsh-conv-railbtn {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: none;
        border-radius: 5px;
        background: none;
        color: var(--dsw-alias-state-business-primary, #4176e6);
        cursor: pointer;
        transition: background-color 0.15s ease;
      }
      .dsh-conv-railbtn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
      }
      .dsh-conv-railticks {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: none;
        padding: 2px 0;
      }
      .dsh-conv-railticks::-webkit-scrollbar { display: none; }
      .dsh-conv-railtick {
        position: relative;
        flex: none;
        width: 18px;
        height: 4px;
        padding: 0;
        border: none;
        border-radius: 2px;
        background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.14));
        cursor: pointer;
        overflow: hidden;
        transition: background-color 0.15s ease, transform 0.15s ease;
      }
      .dsh-conv-railtick:hover {
        transform: scaleX(1.25);
        background: var(--dsw-alias-state-business-tertiary, #e4edfd);
      }
      .dsh-conv-railtick-active {
        background: var(--dsw-alias-state-business-tertiary, #e4edfd);
      }
      .dsh-conv-railfill {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        background: var(--dsw-alias-state-business-primary, #4176e6);
        opacity: 0.7;
      }
      .dsh-conv-railtick-active .dsh-conv-railfill { opacity: 1; }
      */
      /* ---- 全屏档位：更方的角、贴边留白更小 ---- */
      .dsh-conv-panel-full { border-radius: 14px; }
      @media (prefers-reduced-motion: reduce) {
        /* 停用保留：这里原本还并列 .dsh-conv-fab 与 .dsh-conv-rail *，两者元素已不渲染
           （见上方两段停用说明），为避免选择器指向不存在的 class，只保留面板自身。 */
        /* .dsh-conv-fab, */
        /* .dsh-conv-rail * */
        .dsh-conv-panel * {
          transition-duration: 0.01ms !important;
          animation: none !important;
        }
      }
    `;
		const STYLE_ID = "dsh-conversation/styles";
		// 样式注入是 best-effort：失败只影响外观，绝不能让模块求值抛异常。
		try {
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-conversation";
				tag.dataset.pluginCss = STYLE_ID;
				tag.textContent = CSS_TEXT;
				document.head.appendChild(tag);
			}
		} catch (e) {
			console.warn("[conversation] stylesheet injection failed; panel renders unstyled", e);
		}

		/** 面板侧停靠位置：right (默认靠右) | left (靠左，不挡右侧栏)。 */
		function loadDockSide() {
			try {
				const val = window.localStorage.getItem("dsh-conversation.dock-side");
				return val === "left" ? "left" : "right";
			} catch (_) {
				return "right";
			}
		}
		function saveDockSide(side) {
			try {
				window.localStorage.setItem("dsh-conversation.dock-side", side === "left" ? "left" : "right");
			} catch (_) {}
		}

		/** 面板三档尺寸：紧凑面板 / 加宽 / 全屏（贴边缘的整高面板）。 */
		const VIEW_SIZES = {
			panel: { width: 320, height: "min(75vh, calc(100vh - 100px))" },
			wide: { width: 480, height: "min(82vh, calc(100vh - 90px))" },
			full: { width: 720, height: "calc(100vh - 56px)" },
		};

		/**
		 * 换档时的横向生长方向：贴左向右、贴右向左、居中两侧对称。
		 *
		 * 面板是 fixed 浮层（不占布局），换档时哪条边不动决定了观感。实现直接写成
		 * 「两侧各分多少」，而不是「先算对称再夹回窗口」—— 后者虽然等价，却看不出
		 * 一侧空间不足时差额去哪了：
		 *
		 * 1. 贴边（边距 ≤ EDGE_SNAP，默认停靠就是 16px）：靠墙那侧分 0，整份长度
		 *    全给另一侧 ⇒ 加宽是抽屉拉开、缩窄是抽屉推回，靠墙那条边始终不动；
		 * 2. 居中：两侧各分一半；某一侧空间不够时，差额转给另一侧（不是压回去
		 *    只长一边，也不是把面板推出窗口）；
		 * 3. 兜底：两侧加起来仍不够（窗口比目标宽度还窄）时，按各自空间夹一次。
		 *
		 * 停靠态（从未拖拽）不走这里：left/right 锚点本身就固定了靠墙边，
		 * 返回值 null 表示只需换档、不用动坐标。
		 */
		const EDGE_SNAP = 32;
		function resolveResizedLeft(prevLeft, prevWidth, nextWidth, viewportWidth) {
			if (typeof prevLeft !== "number" || Number.isFinite(prevLeft) === false) return null;
			const vw = typeof viewportWidth === "number" && viewportWidth > 0 ? viewportWidth : 0;
			if (vw === 0) return prevLeft;
			const delta = nextWidth - prevWidth;
			const leftSpace = Math.max(0, prevLeft);
			const rightSpace = Math.max(0, vw - prevLeft - prevWidth);
			let growLeft;
			let growRight;
			if (leftSpace <= EDGE_SNAP) {
				// 贴左：左缘不动，整份长度向右
				growLeft = 0;
				growRight = delta;
			} else if (rightSpace <= EDGE_SNAP) {
				// 贴右：右缘不动，整份长度向左
				growLeft = delta;
				growRight = 0;
			} else {
				growLeft = delta / 2;
				growRight = delta - growLeft;
			}
			// 一侧装不下就把差额让给另一侧（缩窄时 delta < 0，两侧都不受空间限制）
			if (growLeft > leftSpace) {
				growRight += growLeft - leftSpace;
				growLeft = leftSpace;
			}
			if (growRight > rightSpace) {
				growLeft += growRight - rightSpace;
				growRight = rightSpace;
			}
			// 二次夹：窗口比目标宽度还窄时哪边都放不下，只能贴住左缘
			growLeft = Math.min(growLeft, leftSpace);
			const left = prevLeft - growLeft;
			const maxLeft = Math.max(0, vw - nextWidth);
			return Math.round(Math.min(maxLeft, Math.max(0, left)));
		}

		/** 面板与首屏占位共用的定位计算：拖拽位置优先，其次按停靠边与视图档位。
		 *  刷新时占位与真正面板落在同一位置，不会先跳回默认位置 2 秒（PR review suggestion 2）。 */
		function outlinePanelPlacement(chrome, dockSide) {
			const snapshot = chrome !== null && typeof chrome === "object" ? chrome : EMPTY_CHROME;
			const size = VIEW_SIZES[snapshot.view] === undefined ? VIEW_SIZES.panel : VIEW_SIZES[snapshot.view];
			if (typeof snapshot.left === "number" && typeof snapshot.top === "number") {
				return { width: size.width, height: size.height, left: snapshot.left, top: snapshot.top };
			}
			const top = snapshot.view === "full" ? 28 : 72;
			return dockSide === "left"
				? { width: size.width, height: size.height, left: 16, top }
				: { width: size.width, height: size.height, right: 16, top };
		}
		/** 当前视口尺寸；非浏览器环境（单测）返回 0，调用方据此跳过钳制。 */
		function currentViewport() {
			try {
				if (typeof window === "undefined" || window === null) return { width: 0, height: 0 };
				return {
					width: typeof window.innerWidth === "number" ? window.innerWidth : 0,
					height: typeof window.innerHeight === "number" ? window.innerHeight : 0,
				};
			} catch (e) {
				return { width: 0, height: 0 };
			}
		}

		/* 预览浮层的几何常量，与 .dsh-conv-preview 的 max-width / max-height 保持一致。 */
		const PREVIEW_GAP = 20;
		const PREVIEW_MAX_WIDTH = 340;
		const PREVIEW_MAX_HEIGHT = 240;
		const PREVIEW_VIEWPORT_MARGIN = 8;

		/**
		 * 预览浮层该落在悬停行的哪一侧：右侧放得下就放右侧，放不下才翻到左边。
		 * 判据是「行的右缘 + 间距 + 浮层宽」是否还在视口内，而不是「行在不在窗口右半边」——
		 * 后者在窄窗口里会误判（行还靠左，浮层已经放不下）。
		 */
		function previewSideFor(rectLeft, rectRight, viewportWidth) {
			const vw = typeof viewportWidth === "number" && viewportWidth > 0 ? viewportWidth : 0;
			if (vw === 0) return "right";
			const l = typeof rectLeft === "number" && Number.isFinite(rectLeft) ? rectLeft : 0;
			const r = typeof rectRight === "number" && Number.isFinite(rectRight) ? rectRight : l;
			if (r + PREVIEW_GAP + PREVIEW_MAX_WIDTH <= vw) return "right";
			const fitsLeft = l - PREVIEW_GAP - PREVIEW_MAX_WIDTH >= PREVIEW_VIEWPORT_MARGIN;
			return fitsLeft ? "left" : "right";
		}

		/**
		 * 预览浮层的落点：hover 事件拿到的是**视口坐标**，所以这里也按视口算。
		 * 右边或下边放不下就往回夹，而不是直接算成负数 —— 窄窗口（手机 WebView、
		 * 半屏窗口）上原来的 `innerWidth - 380` 会给出负值，浮层跑到视口左侧外面。
		 *
		 * side = "left" 表示浮层在行的左侧（由 previewSideFor 决定）：此时 x 是行的**左缘**，
		 * 需要再往左让出浮层宽 + 间距。旧实现把「让出宽度」写在进行里、这里又加一次间距，
		 * 结果翻到左侧时浮层反压住行首 10px。
		 * 视口未知（单测 / 非浏览器）时保持原始偏移，不做猜测。
		 */
		function previewPlacement(x, y, viewportWidth, viewportHeight, side) {
			const anchorX = typeof x === "number" && Number.isFinite(x) ? x : 0;
			const anchorY = typeof y === "number" && Number.isFinite(y) ? y : 0;
			const vw = typeof viewportWidth === "number" && viewportWidth > 0 ? viewportWidth : 0;
			const vh = typeof viewportHeight === "number" && viewportHeight > 0 ? viewportHeight : 0;
			let left = side === "left"
				? anchorX - PREVIEW_MAX_WIDTH - PREVIEW_GAP
				: anchorX + PREVIEW_GAP;
			let top = anchorY + PREVIEW_GAP;
			if (vw > 0) {
				const maxLeft = vw - PREVIEW_MAX_WIDTH - PREVIEW_VIEWPORT_MARGIN;
				left = Math.min(left, Math.max(PREVIEW_VIEWPORT_MARGIN, maxLeft));
			}
			if (vh > 0) {
				const maxTop = vh - PREVIEW_MAX_HEIGHT - PREVIEW_VIEWPORT_MARGIN;
				top = Math.min(top, Math.max(PREVIEW_VIEWPORT_MARGIN, maxTop));
			}
			return { left: Math.round(left), top: Math.round(top) };
		}

		/**
		 * 视口兜底：拖拽坐标是按「当时那个窗口」存的，窗口被拉窄（或换了更小的显示器）之后，
		 * 面板会整块落在视口右侧之外 —— 表现为「点了大纲按钮，什么都不出来」，而窗口最大化后
		 * 又正常。这里只在渲染时钳制，不回写 localStorage：把窗口拉回去时位置还是原来的。
		 *
		 * 停靠态用 right 锚点（没有 left）：正常情况下天然贴边，不需要处理；但窗口比
		 * 「面板宽 + 边距」还窄时（全屏档 720 落在 700 宽的窗口里），右锚点会把左缘顶到
		 * 负坐标，面板整块从左边溢出去。此时折算成 left: 0 —— 贴住左缘、右侧被裁，
		 * 至少标题栏和列表首列还看得见。
		 * top 只要求露出标题栏（MIN_PANEL_VISIBLE_HEIGHT），够把它拖回来就行。
		 */
		const MIN_PANEL_VISIBLE_HEIGHT = 80;
		function clampPlacementToViewport(placement, viewportWidth, viewportHeight) {
			const vw = typeof viewportWidth === "number" && viewportWidth > 0 ? viewportWidth : 0;
			if (vw === 0) return placement;
			let out = placement;
			if (typeof out.left !== "number" && typeof out.right === "number" && typeof out.width === "number") {
				if (vw - out.right - out.width < 0) {
					out = Object.assign({}, out, { left: 0 });
					delete out.right;
				}
			}
			if (typeof out.left !== "number") return out;
			const maxLeft = Math.max(0, vw - out.width);
			const left = Math.min(maxLeft, Math.max(0, out.left));
			const vh = typeof viewportHeight === "number" && viewportHeight > 0 ? viewportHeight : 0;
			const top = typeof out.top !== "number"
				? out.top
				: (vh === 0 ? out.top : Math.min(Math.max(0, vh - MIN_PANEL_VISIBLE_HEIGHT), Math.max(0, out.top)));
			return Object.assign({}, out, { left, top });
		}

		/**
		 * 面板外壳样式 = 定位（含视口钳制） + （宿主支持 color-mix 时）背景透明度变量。
		 * 首屏占位与真面板必须走同一个函数：占位只写定位的话，变量回落 100%，
		 * 就绪瞬间面板会从完全不透明「跳」到用户设定值。
		 */
		function panelSurfaceStyle(chrome, dockSide, alphaSupported) {
			const viewport = currentViewport();
			const placement = clampPlacementToViewport(
				outlinePanelPlacement(chrome, dockSide),
				viewport.width,
				viewport.height,
			);
			if (alphaSupported !== true) return placement;
			const opacity = normalizeOpacity(chrome === null || chrome === undefined ? undefined : chrome.opacity);
			return Object.assign({
				"--dsh-conv-bg-alpha": opacity + "%",
				"--dsh-conv-bg-blur": ((OPACITY_MAX - opacity) / OPACITY_MAX * 6).toFixed(2) + "px",
			}, placement);
		}
		const VIEW_ORDER = ["panel", "wide", "full"];
		const REPO_URL = "https://github.com/huangfuren/dsh-conversation";
		const MAX_USER_TEXT = 80;
		const SEARCH_SCOPES = ["all", "query", "heading"];
		const EXPORT_FILE_NAME = "dsh-conversation-outline.md";
		// 首屏数据就绪的等待上限：超过它仍未拿到会话绑定就照常挂载（空态），
		// 避免宿主某版本不再 retain 会话时面板永远停在占位。
		const PANEL_READY_TIMEOUT_MS = 2000;

		const ZH = {
			"panel.title": "历史提问 · 大纲",
			"panel.collapse": "收起",
			"panel.github": "在 GitHub 上查看",
			"panel.empty": "暂无大纲内容",
			"panel.emptyHint": "发送一条消息，或等待助手回复中出现标题",
			"panel.pending": "正在读取会话…",
			"panel.viewPanel": "紧凑宽度",
			"panel.viewWide": "加宽面板",
			"panel.viewFull": "全屏展开",
			// 停用保留：刻度条显隐开关文案（刻度条组件已注释，见 SessionRail 段）。
			// "panel.railHide": "隐藏侧边刻度条",
			// "panel.railShow": "显示侧边刻度条",
			"search.placeholder": "搜索大纲…",
			"search.clear": "清除搜索",
			"search.scope.all": "全部",
			"search.scope.query": "问题",
			"search.scope.heading": "标题",
			"search.scopeTooltip": "搜索范围：{scope}（点击切换）",
			"level.tooltip": "H{level}：{count} 个",
			"level.zero": "仅问题",
			"action.expandAll": "展开全部",
			"action.collapseAll": "收起全部",
			"action.bookmarkMode": "只看收藏",
			"action.bookmarkAdd": "收藏",
			"action.bookmarkRemove": "取消收藏",
			"action.copy": "复制大纲",
			"action.copied": "已复制",
			"action.export": "导出为 Markdown 文件",
			"action.sectionEnd": "双击跳到本节末尾",
			"meta.tools": "{count} 工具",
			"meta.chars": "{count} 字",
			// 停用保留：刻度条中文文案（组件 SessionRail 已注释，见本文件同名段落）。
			// "rail.title": "会话刻度条：每根刻度是一轮提问，点击跳转",
			// "rail.open": "展开大纲面板",
			"action.scrollTop": "回到顶部",
			"action.scrollBottom": "回到底部",
			"action.unlocatable": "当前节点暂不可定位",
			"history.hasMore": "历史会话未全部加载",
			"history.loadOlder": "加载更早",
			"history.loadAll": "加载全部",
			"history.loading": "加载中…",
			"panel.dockLeft": "靠左停靠",
			"panel.dockRight": "靠右停靠",
			"appearance.opacity": "背景不透明度",
			"appearance.opacityTooltip": "调整面板背景的不透明度（40–100%）；只影响背景，文字始终不透明；数值越低背景越透、背后的模糊越强；点右侧百分比恢复 100%",
			"appearance.reset": "恢复完全不透明（100%）",
		};
		const EN = {
			"panel.title": "Questions · Outline",
			"panel.collapse": "Collapse",
			"panel.github": "View on GitHub",
			"panel.empty": "No outline yet",
			"panel.emptyHint": "Send a message, or wait for headings in the assistant reply",
			"panel.pending": "Reading conversation…",
			"panel.viewPanel": "Compact width",
			"panel.viewWide": "Wide panel",
			"panel.viewFull": "Full height",
			// 停用保留：刻度条显隐开关文案。注意这两条落在中文词典里、值却是英文，
			// 且英文词典中并没有同名键 —— 属于更早那次移除留下的残留，一并注释。
			// "panel.railHide": "Hide edge rail",
			// "panel.railShow": "Show edge rail",
			"search.placeholder": "Search outline…",
			"search.clear": "Clear search",
			"search.scope.all": "All",
			"search.scope.query": "Questions",
			"search.scope.heading": "Headings",
			"search.scopeTooltip": "Search scope: {scope} (click to switch)",
			"level.tooltip": "H{level}: {count}",
			"level.zero": "Questions only",
			"action.expandAll": "Expand all",
			"action.collapseAll": "Collapse all",
			"action.bookmarkMode": "Bookmarks only",
			"action.bookmarkAdd": "Bookmark",
			"action.bookmarkRemove": "Remove bookmark",
			"action.copy": "Copy outline",
			"action.copied": "Copied",
			"action.export": "Export as Markdown file",
			"action.sectionEnd": "Double-click to jump to the end of this section",
			"meta.tools": "{count} tools",
			"meta.chars": "{count} chars",
			// 停用保留：刻度条英文文案（组件 SessionRail 已注释，见本文件同名段落）。
			// "rail.title": "Session rail: one tick per question, click to jump",
			// "rail.open": "Open outline panel",
			"action.scrollTop": "Scroll to top",
			"action.scrollBottom": "Scroll to bottom",
			"action.unlocatable": "This item is not available yet",
			"history.hasMore": "History is partially loaded",
			"history.loadOlder": "Load earlier",
			"history.loadAll": "Load all",
			"history.loading": "Loading…",
			"panel.dockLeft": "Dock to left",
			"panel.dockRight": "Dock to right",
			"appearance.opacity": "Background opacity",
			"appearance.opacityTooltip": "Adjusts the panel background opacity (40–100%). Only the background is affected — text stays opaque. Lower values are more transparent and blur the backdrop more. Click the percentage to reset to 100%.",
			"appearance.reset": "Reset to fully opaque (100%)",
		};

		function preferredLang() {
			try {
				return /^en/i.test(navigator.language || "") ? "en" : "zh";
			} catch (e) {
				return "zh";
			}
		}

		function makeTranslate(injected) {
			const dict = preferredLang() === "en" ? EN : ZH;
			const fallback = (key, vars) => {
				let text = dict[key] === undefined ? (ZH[key] === undefined ? key : ZH[key]) : dict[key];
				if (vars !== undefined && vars !== null) {
					for (const name of Object.keys(vars)) {
						text = text.split("{" + name + "}").join(String(vars[name]));
					}
				}
				return text;
			};
			if (typeof injected !== "function") return fallback;
			return (key, vars) => {
				try {
					const value = injected(key, vars);
					if (typeof value === "string" && value !== "") return value;
				} catch (e) { /* 宿主字典缺失或改名：回落自带文案 */ }
				return fallback(key, vars);
			};
		}

		function djb2Hash(str) {
			let hash = 5381;
			for (let i = 0; i < str.length; i++) {
				hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
			}
			return hash.toString(16).padStart(8, "0");
		}

		function itemSignature(level, text, occurrence) {
			return djb2Hash(level + ":" + text) + ":" + occurrence;
		}

		const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
		const FENCE_RE = /^\s*(`{3,}|~{3,})/;

		function parseMarkdownHeadings(markdown) {
			const out = [];
			if (typeof markdown !== "string") return out;
			let inFence = false;
			for (const line of markdown.split("\n")) {
				if (FENCE_RE.test(line)) {
					inFence = !inFence;
					continue;
				}
				if (inFence) continue;
				const trimmed = line.trimStart();
				if (trimmed.startsWith("#") === false) continue;
				const matched = HEADING_RE.exec(trimmed);
				if (matched === null) continue;
				const hashes = /^#{1,6}/.exec(trimmed);
				if (hashes === null) continue;
				const text = (matched[1] === undefined ? "" : matched[1]).trim();
				if (text === "") continue;
				out.push({ level: hashes[0].length, text });
			}
			return out;
		}

		function findScrollableAncestor(element) {
			let current = element === null || element === undefined ? null : element.parentElement;
			while (current && current !== document.body) {
				const style = window.getComputedStyle(current);
				const overflowY = style.overflowY;
				const canScroll = current.scrollHeight > current.clientHeight
					&& (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay");
				if (canScroll) return current;
				current = current.parentElement;
			}
			return null;
		}

		function scrollElementInContainer(element, container, offset) {
			if (container === null || container === undefined || container === element) return false;
			const pad = typeof offset === "number" ? offset : 12;
			const containerRect = container.getBoundingClientRect();
			const targetRect = element.getBoundingClientRect();
			container.scrollTo({
				top: container.scrollTop + targetRect.top - containerRect.top - pad,
				behavior: "instant",
			});
			return true;
		}

		/** 仅当 element 不完全可见时滚动容器（不牵动祖先）。返回是否发生滚动。 */
		function ensureElementInView(element, container, padding) {
			if (container === element) return false;
			const pad = typeof padding === "number" ? padding : 8;
			const cRect = container.getBoundingClientRect();
			const eRect = element.getBoundingClientRect();
			const topLimit = cRect.top + pad;
			const bottomLimit = cRect.bottom - pad;
			if (eRect.top >= topLimit && eRect.bottom <= bottomLimit) return false;
			const delta = eRect.top < topLimit ? eRect.top - topLimit : eRect.bottom - bottomLimit;
			container.scrollTo({ top: container.scrollTop + delta, behavior: "instant" });
			return true;
		}

		function buildTree(items) {
			const roots = [];
			const stack = [];
			let index = 0;
			let queryIndex = 0;
			for (const item of items) {
				const node = {
					level: item.level,
					text: item.text,
					id: item.id,
					children: [],
					index: index++,
					collapsed: false,
				};
				if (item.isUserQuery === true) {
					node.isUserQuery = true;
					node.queryIndex = ++queryIndex;
				}
				if (item.userIndex !== undefined) node.userIndex = item.userIndex;
				if (item.headingIndex !== undefined) node.headingIndex = item.headingIndex;
				if (item.key !== undefined) node.key = item.key;
				if (item.ts !== undefined) node.ts = item.ts;
				if (typeof item.toolCount === "number") node.toolCount = item.toolCount;
				if (typeof item.charCount === "number") node.charCount = item.charCount;
				if (item.streaming === true) node.streaming = true;
				if (item.isTruncated === true) node.isTruncated = true;
				while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop();
				const parent = stack[stack.length - 1];
				if (parent === undefined) roots.push(node);
				else parent.children.push(node);
				stack.push(node);
			}
			return roots;
		}

		function computeLevelCounts(items) {
			const counts = {};
			for (const item of items) {
				if (item.level >= 1) counts[item.level] = (counts[item.level] === undefined ? 0 : counts[item.level]) + 1;
			}
			return counts;
		}

		function maxActualLevel(items) {
			let max = 0;
			for (const item of items) max = Math.max(max, item.level);
			return max;
		}

		function clearForceExpandedState(nodes, displayLevel) {
			for (const node of nodes) {
				node.forceExpanded = false;
				if (node.children.length > 0) {
					node.collapsed = node.children.every((child) => child.level > displayLevel);
					clearForceExpandedState(node.children, displayLevel);
				} else {
					node.collapsed = false;
				}
			}
		}

		function captureCollapseState(nodes, out) {
			const map = out === undefined ? new Map() : out;
			for (const node of nodes) {
				map.set(node.id, { collapsed: node.collapsed, forceExpanded: node.forceExpanded === true });
				captureCollapseState(node.children, map);
			}
			return map;
		}

		function restoreCollapseState(nodes, saved, displayLevel) {
			for (const node of nodes) {
				const rec = saved.get(node.id);
				if (rec !== undefined) {
					node.collapsed = rec.collapsed;
					node.forceExpanded = rec.forceExpanded;
				} else if (node.children.length > 0) {
					node.collapsed = node.children.every((child) => child.level > displayLevel);
				}
				restoreCollapseState(node.children, saved, displayLevel);
			}
		}

		function markBookmarkedPaths(nodes, bookmarks) {
			let any = false;
			for (const node of nodes) {
				const childHas = markBookmarkedPaths(node.children, bookmarks);
				node.isBookmarked = bookmarks.has(node.id);
				node.hasBookmarkedDescendant = childHas;
				if (node.isBookmarked || childHas) any = true;
			}
			return any;
		}

		function flattenVisible(nodes, opts) {
			const out = [];
			const walk = (list, forceChain) => {
				if (!Array.isArray(list)) return;
				for (const node of list) {
					const passFilter =
						(opts.searching !== true || node.isMatch === true || node.hasMatchedDescendant === true)
						&& (opts.bookmarkMode !== true || node.isBookmarked === true || node.hasBookmarkedDescendant === true);
					const passLevel = opts.searching === true || opts.bookmarkMode === true || forceChain
						|| node.level <= opts.expandLevel || node.forceVisible === true;
					if (passFilter && passLevel) out.push(node);
					if (node.collapsed !== true || node.forceVisible === true) {
						walk(node.children, forceChain || node.forceExpanded === true);
					}
				}
			};
			walk(nodes, false);
			return out;
		}

		function revealPath(nodes, targetIndex) {
			const mark = (list, parents) => {
				for (const node of list) {
					if (node.index === targetIndex) {
						for (const parent of parents) {
							parent.collapsed = false;
							parent.forceExpanded = true;
							parent.forceVisible = true;
						}
						node.forceVisible = true;
						return true;
					}
					if (mark(node.children, parents.concat([node]))) return true;
				}
				return false;
			};
			return mark(nodes, []);
		}

		function findPath(nodes, id) {
			for (const node of nodes) {
				if (node.id === id) return [node];
				const nested = findPath(node.children, id);
				if (nested !== null) return [node].concat(nested);
			}
			return null;
		}

		function resolveVisibleActiveId(activeId, tree, visible) {
			if (activeId === null || activeId === undefined) return null;
			const visibleIds = new Set();
			for (const node of visible) visibleIds.add(node.id);
			if (visibleIds.has(activeId)) return activeId;
			const path = findPath(tree, activeId);
			if (path === null) return null;
			for (let i = path.length - 1; i >= 0; i--) {
				const id = path[i] === undefined ? undefined : path[i].id;
				if (id !== undefined && visibleIds.has(id)) return id;
			}
			return null;
		}

		function clearForceVisible(nodes, displayLevel) {
			for (const node of nodes) {
				if (node.forceVisible === true) {
					node.forceVisible = false;
					node.forceExpanded = false;
					if (node.children.length > 0) {
						node.collapsed = node.children.every((child) => child.level > displayLevel);
					}
				}
				clearForceVisible(node.children, displayLevel);
			}
		}

		/** 面板侧唯一状态所有者：组合上面的纯函数，持有层级/搜索/收藏状态。 */
		class OutlineManager {
			constructor(options) {
				const opts = options === undefined || options === null ? {} : options;
				this.items = [];
				this.tree = [];
				this.expandLevel = opts.expandLevel === undefined ? 6 : opts.expandLevel;
				this.searchQuery = "";
				this.matchCount = 0;
				this.searchScope = "all";
				this.bookmarkMode = false;
				this.bookmarkIds = new Set(opts.bookmarks === undefined ? [] : opts.bookmarks);
				this.onExpandLevelChange = opts.onExpandLevelChange;
				this.onBookmarksChange = opts.onBookmarksChange;
				this.listeners = new Set();
				/* getState() 快照缓存：同一次变更周期内必须返回同一对象引用。
				   渲染期裸调 getState()（面板组件每轮渲染都取一次 state），若每次调用
				   都新造对象 + 现算 flattenVisible，依赖 state 的 effect 就会每轮渲染
				   拆了重挂 —— issue #4 重开的「预览闪 ~45ms」回归正是踩在这个结构上。 */
				this._snapshot = null;
			}

			subscribe(fn) {
				this.listeners.add(fn);
				return () => { this.listeners.delete(fn); };
			}

			notify() {
				this._snapshot = null;
				for (const fn of this.listeners) fn();
			}

			itemsEqual(items) {
				const prev = this.items;
				if (items.length !== prev.length) return false;
				for (let i = 0; i < items.length; i++) {
					const a = items[i];
					const b = prev[i];
					if (a === undefined || b === undefined) return false;
					if (a.level !== b.level || a.text !== b.text
						|| a.isUserQuery !== b.isUserQuery || a.userIndex !== b.userIndex
						|| a.headingIndex !== b.headingIndex || a.streaming !== b.streaming
						|| a.isTruncated !== b.isTruncated || a.key !== b.key || a.ts !== b.ts
						|| a.toolCount !== b.toolCount || a.charCount !== b.charCount) return false;
				}
				return true;
			}

			setItems(items) {
				if (this.itemsEqual(items)) return;
				const seen = new Map();
				const signed = items.map((item) => {
					const base = item.level + ":" + item.text;
					const occ = seen.get(base);
					const occurrence = occ === undefined ? 0 : occ;
					seen.set(base, occurrence + 1);
					const next = {
						level: item.level,
						text: item.text,
						id: itemSignature(item.level, item.text, occurrence),
					};
					if (item.isUserQuery === true) next.isUserQuery = true;
					if (item.userIndex !== undefined) next.userIndex = item.userIndex;
					if (item.headingIndex !== undefined) next.headingIndex = item.headingIndex;
					if (item.key !== undefined) next.key = item.key;
					if (item.ts !== undefined) next.ts = item.ts;
					if (typeof item.toolCount === "number") next.toolCount = item.toolCount;
					if (typeof item.charCount === "number") next.charCount = item.charCount;
					if (item.streaming === true) next.streaming = true;
					if (item.isTruncated === true) next.isTruncated = true;
					return next;
				});
				const saved = this.tree.length > 0 ? captureCollapseState(this.tree) : new Map();
				this.items = signed;
				this.tree = buildTree(signed);
				restoreCollapseState(this.tree, saved, this.expandLevel);
				markBookmarkedPaths(this.tree, this.bookmarkIds);
				if (this.searchQuery !== "") this.performSearch(this.searchQuery);
				this.notify();
			}

			getState() {
				if (this._snapshot !== null) return this._snapshot;
				this._snapshot = {
					tree: this.tree,
					visible: flattenVisible(this.tree, {
						expandLevel: this.expandLevel,
						searching: this.searchQuery !== "",
						bookmarkMode: this.bookmarkMode,
					}),
					expandLevel: this.expandLevel,
					isAllExpanded: this.expandLevel >= maxActualLevel(this.items),
					levelCounts: computeLevelCounts(this.items),
					searchQuery: this.searchQuery,
					matchCount: this.matchCount,
					searchScope: this.searchScope,
					bookmarkMode: this.bookmarkMode,
					bookmarkIds: this.bookmarkIds,
				};
				return this._snapshot;
			}

			setLevel(level) {
				this.expandLevel = Math.max(0, Math.min(6, level));
				clearForceExpandedState(this.tree, this.expandLevel);
				if (typeof this.onExpandLevelChange === "function") this.onExpandLevelChange(this.expandLevel);
				this.notify();
			}

			expandAll() {
				this.setLevel(maxActualLevel(this.items));
			}

			collapseAll() {
				this.setLevel(0);
			}

			toggleNode(index) {
				const node = this.findNode(index);
				if (node === null || node.children.length === 0) return;
				node.collapsed = !node.collapsed;
				if (node.collapsed !== true) node.forceExpanded = true;
				this.notify();
			}

			revealNode(index) {
				/* revealPath 落空时 clearForceVisible 也动过树标记，而这条路不会
				   notify —— 缓存必须就地失效，否则下一次无关重渲染会读回旧快照。 */
				this._snapshot = null;
				clearForceVisible(this.tree, this.expandLevel);
				if (revealPath(this.tree, index)) this.notify();
			}

			setSearchQuery(query) {
				this.searchQuery = query;
				if (query === "") {
					this.matchCount = 0;
					clearForceExpandedState(this.tree, this.expandLevel);
				} else {
					this.performSearch(query);
				}
				this.notify();
			}

			/** 搜索范围：全部 / 只看提问 / 只看标题（切换后用当前关键词重算）。 */
			setSearchScope(scope) {
				const next = scope === "query" || scope === "heading" ? scope : "all";
				if (next === this.searchScope) return;
				this.searchScope = next;
				if (this.searchQuery !== "") this.performSearch(this.searchQuery);
				this.notify();
			}

			performSearch(query) {
				/* 只改树标记与 matchCount，notify 由调用方负责；缓存先失效兜底。 */
				this._snapshot = null;
				const needle = query.toLowerCase();
				const scope = this.searchScope;
				let count = 0;
				const traverse = (nodes) => {
					let anyMatch = false;
					for (const node of nodes) {
						const inScope = scope === "all"
							|| (scope === "query" && node.isUserQuery === true)
							|| (scope === "heading" && node.isUserQuery !== true);
						node.isMatch = inScope && node.text.toLowerCase().includes(needle);
						if (node.isMatch) count++;
						node.hasMatchedDescendant = traverse(node.children);
						if (node.hasMatchedDescendant) node.collapsed = false;
						if (node.isMatch || node.hasMatchedDescendant) anyMatch = true;
					}
					return anyMatch;
				};
				traverse(this.tree);
				this.matchCount = count;
			}

			setBookmarkMode(on) {
				this.bookmarkMode = on;
				this.notify();
			}

			toggleBookmark(index) {
				const node = this.findNode(index);
				if (node === null) return;
				if (this.bookmarkIds.has(node.id)) this.bookmarkIds.delete(node.id);
				else this.bookmarkIds.add(node.id);
				markBookmarkedPaths(this.tree, this.bookmarkIds);
				if (typeof this.onBookmarksChange === "function") this.onBookmarksChange(this.bookmarkIds);
				this.notify();
			}

			findNode(index) {
				const walk = (nodes) => {
					for (const node of nodes) {
						if (node.index === index) return node;
						const hit = walk(node.children);
						if (hit !== null) return hit;
					}
					return null;
				};
				return walk(this.tree);
			}
		}

		// 快照契约兼容：新结构是 snapshot.nodes 数组 + snapshot.partial；
		// 旧结构是 snapshot.chat = { order, nodes(Map) } + node.data.content。
		// 快照契约兼容：dsh 0.1.2+ 把会话内容迁入 ChatSnapshot.legacy.nodes（官方兼容
		// 面，mindmap 同款读法）；更早是 snapshot.nodes / snapshot.chat={order,nodes}。
		function snapshotRows(snapshot) {
			if (snapshot === null || snapshot === undefined) return [];
			if (Array.isArray(snapshot)) return snapshot;
			if (typeof snapshot !== "object") return [];
			const legacy = snapshot.legacy;
			if (legacy !== null && legacy !== undefined && typeof legacy === "object" && Array.isArray(legacy.nodes)) {
				return legacy.nodes;
			}
			if (Array.isArray(snapshot.nodes)) return snapshot.nodes;
			if (Array.isArray(snapshot.items)) return snapshot.items;
			if (Array.isArray(snapshot.messages)) return snapshot.messages;
			const chat = snapshot.chat;
			if (chat !== null && chat !== undefined && Array.isArray(chat.order)) {
				const nodes = chat.nodes;
				const out = [];
				if (nodes !== null && nodes !== undefined && typeof nodes.get === "function") {
					for (const key of chat.order) {
						const row = nodes.get(key);
						if (row !== undefined && row !== null) out.push(row);
					}
					return out;
				}
				if (nodes !== null && nodes !== undefined && typeof nodes === "object") {
					for (const key of chat.order) {
						const row = nodes[key];
						if (row !== undefined && row !== null) out.push(row);
					}
					return out;
				}
			}
			if (snapshot.nodes !== null && snapshot.nodes !== undefined && typeof snapshot.nodes.values === "function") {
				try {
					const vals = snapshot.nodes.values();
					if (Array.isArray(vals)) return vals;
				} catch (_) {}
			}
			return [];
		}

		function rowContent(node) {
			if (Array.isArray(node.content)) return node.content;
			const data = node.data;
			if (data !== null && data !== undefined && Array.isArray(data.content)) return data.content;
			return [];
		}

		function rowTime(node) {
			if (typeof node.time === "number") return node.time;
			const data = node.data;
			if (data !== null && data !== undefined && typeof data.time === "number") return data.time;
			if (typeof node.timestamp === "number") return node.timestamp;
			return undefined;
		}

		function textBlocks(node) {
			if (node === null || node === undefined) return [];
			if (typeof node === "string" && node.length > 0) return [node];
			const out = [];
			// rowContent() 取的就是 node.content / node.data.content,与下面 data.content 那条分支可能指向**同一个数组**。
			// 各收一遍会让同一段正文进两次:表现为同一批标题在大纲里重复出现、该轮字数翻倍。
			// 记下已收过的数组,同一个数组只收一次。
			const harvested = new Set();
			const harvest = (blocks) => {
				if (Array.isArray(blocks) === false || harvested.has(blocks)) return;
				harvested.add(blocks);
				for (const block of blocks) {
					if (block === null || block === undefined) continue;
					if (typeof block === "string" && block.length > 0) out.push(block);
					else if ((block.kind === "text" || block.type === "text") && typeof block.text === "string") out.push(block.text);
				}
			};
			if (typeof node.text === "string" && node.text.length > 0) out.push(node.text);
			harvest(node.blocks);
			harvest(rowContent(node));
			if (node.data && typeof node.data === "object") {
				if (typeof node.data.text === "string" && node.data.text.length > 0) out.push(node.data.text);
				harvest(node.data.content);
			}
			return out;
		}

		function userText(node) {
			const texts = textBlocks(node);
			if (texts.length === 0) {
				if (typeof node.text === "string") return node.text.trim().split("\n", 1)[0].trim();
				if (typeof node.title === "string") return node.title.trim().split("\n", 1)[0].trim();
				return "";
			}
			return texts.join("\n").trim().split("\n", 1)[0].trim();
		}

		function buildOutlineItems(snapshot) {
			const items = [];
			let userIndex = 0;
			let headingIndex = 0;
			// 当前轮次的提问项：工具调用数与正文长度都累加到它身上（侧边刻度条与行内统计用）。
			let turn = null;
			const pushHeadings = (markdown, streaming) => {
				for (const heading of parseMarkdownHeadings(markdown)) {
					const item = { level: heading.level, text: heading.text, headingIndex: headingIndex++ };
					if (streaming) item.streaming = true;
					items.push(item);
				}
			};
			for (const node of snapshotRows(snapshot)) {
				if (node === null || node === undefined) continue;
				const kind = String(node.kind === undefined ? node.role : node.kind);
				if (kind === "user" || kind === "steering" || kind === "human") {
					const text = userText(node);
					if (text === "") continue;
					const item = {
						level: 0,
						text: text.length > MAX_USER_TEXT ? text.slice(0, MAX_USER_TEXT) : text,
						isUserQuery: true,
						userIndex: userIndex++,
						toolCount: 0,
						charCount: 0,
					};
					if (text.length > MAX_USER_TEXT) item.isTruncated = true;
					const key = node.key === undefined ? node.id : node.key;
					if (key !== undefined) item.key = key;
					const ts = rowTime(node);
					if (ts !== undefined) item.ts = ts;
					items.push(item);
					turn = item;
					continue;
				}
				// 工具调用/结果只计数，不进大纲（保持大纲是"人话"）。
				if (kind.indexOf("tool") !== -1) {
					if (turn !== null) turn.toolCount += 1;
					continue;
				}
				if (kind === "assistant" || kind === "ai" || kind === "model") {
					for (const text of textBlocks(node)) {
						if (turn !== null) turn.charCount += text.length;
						pushHeadings(text, false);
					}
				}
			}
			const partial = snapshot === null || snapshot === undefined ? undefined : snapshot.partial;
			if (partial !== null && partial !== undefined && typeof partial === "object") {
				for (const text of textBlocks(partial)) {
					if (turn !== null) turn.charCount += text.length;
					pushHeadings(text, true);
				}
			}
			return items;
		}

		const EXCLUDE_ANCESTOR =
			'[data-chat-flow-kind="tool-call"], [data-chat-flow-kind="context"], [data-chat-flow-kind="turn-tail"]';
		const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
		const FLASH_CLASS = "dsh-conv-flash";
		const FLASH_MS = 1600;

		/**
		 * 面板依赖的宿主 DOM 契约（点击定位 / 阅读位置跟随）。宿主整体改名时，
		 * 精确定位会退化为文本顺序匹配 —— 这里只负责探测与一次性告警，不改变容错行为。
		 */
		const DOM_CONTRACT = Object.freeze({
			scroll: "[data-conversation-scroll]",
			flowKind: "[data-chat-flow-kind]",
			anchorKey: "[data-chat-anchor-key]",
			messageKey: "[data-message-key]",
			nodeKey: "[data-node-key]",
		});

		function findChatRoot() {
			try {
				const slotRoot = document.querySelector('[data-slot="conversation"]');
				if (slotRoot instanceof HTMLElement) return slotRoot;
				return document.body;
			} catch (e) {
				return null;
			}
		}

		function findChatScrollContainer(root) {
			try {
				const scrollAttr = document.querySelector("[data-conversation-scroll]");
				if (scrollAttr instanceof HTMLElement) return scrollAttr;
				return findScrollableAncestor(root.querySelector("[data-chat-flow-kind]"));
			} catch (e) {
				return null;
			}
		}

		function collectUserRows(root) {
			try {
				return Array.prototype.slice.call(root.querySelectorAll(
					'[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]',
				));
			} catch (e) {
				return [];
			}
		}

		function collectHeadings(root) {
			try {
				return Array.prototype.slice.call(root.querySelectorAll(HEADING_SELECTOR))
					.filter((el) => el.closest(EXCLUDE_ANCESTOR) === null);
			} catch (e) {
				return [];
			}
		}

		// 一次性诊断状态：宿主契约变化时控制台只提示一次，避免刷屏。
		let domContractReported = false;
		let snapshotShapeReported = false;

		/** 探测宿主 DOM 契约；纯读取，返回 { ok, missing, present }。 */
		function probeDomContract(doc) {
			const target = doc !== null && doc !== undefined && typeof doc.querySelector === "function" ? doc : null;
			const has = (selector) => {
				if (target === null) return false;
				try {
					return target.querySelector(selector) !== null;
				} catch (_) {
					return false;
				}
			};
			const present = {
				scroll: has(DOM_CONTRACT.scroll),
				flowKind: has(DOM_CONTRACT.flowKind),
				anchorKey: has(DOM_CONTRACT.anchorKey),
				messageKey: has(DOM_CONTRACT.messageKey),
				nodeKey: has(DOM_CONTRACT.nodeKey),
			};
			const missing = [];
			if (!present.scroll) missing.push("data-conversation-scroll");
			if (!present.flowKind) missing.push("data-chat-flow-kind");
			// 三个锚点属性是等价候选：只要有一个在，精确定位就还可用。
			if (!present.anchorKey && !present.messageKey && !present.nodeKey) {
				missing.push("data-chat-anchor-key | data-message-key | data-node-key");
			}
			return { ok: missing.length === 0, missing, present };
		}

		/** 一次性 DOM 契约诊断：缺失/改名时明确告知降级后果，健康时也留一条 info。 */
		function reportDomContractOnce(doc) {
			if (domContractReported) return;
			domContractReported = true;
			const report = probeDomContract(doc);
			if (report.ok) {
				console.info("[conversation] DOM contract OK: data-conversation-scroll, data-chat-flow-kind, anchor keys");
				return;
			}
			console.warn(
				"[conversation] DOM contract changed or missing: " + report.missing.join(", ")
				+ " — click-to-locate falls back to text-order matching (data-chat-flow-kind + heading text) "
				+ "instead of exact anchors. If the host renamed these attributes, add the new names in "
				+ "locateByKey / findChatScrollContainer / collectUserRows.",
			);
		}

		/** 快照形状（与 snapshotRows 的判定顺序一致，便于对照日志）。 */
		function snapshotShapeOf(snapshot) {
			if (snapshot === null || snapshot === undefined) return "absent";
			if (Array.isArray(snapshot)) return "array";
			if (typeof snapshot !== "object") return "non-object";
			const legacy = snapshot.legacy;
			if (legacy !== null && legacy !== undefined && typeof legacy === "object" && Array.isArray(legacy.nodes)) {
				return "legacy.nodes";
			}
			if (Array.isArray(snapshot.nodes)) return "nodes";
			if (Array.isArray(snapshot.items)) return "items";
			if (Array.isArray(snapshot.messages)) return "messages";
			if (snapshot.chat !== null && snapshot.chat !== undefined && typeof snapshot.chat === "object"
				&& Array.isArray(snapshot.chat.order)) {
				return "chat.order";
			}
			if (snapshot.nodes !== null && snapshot.nodes !== undefined && typeof snapshot.nodes === "object"
				&& typeof snapshot.nodes.values === "function") {
				return "nodes.values";
			}
			return "unknown";
		}

		/** 像 ChatSnapshot、但形状不认识：值得报一次，避免宿主改结构后静默空态。 */
		function looksLikeChatSnapshot(snapshot) {
			if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
			for (const key of ["legacy", "nodes", "items", "messages", "chat", "order", "partial"]) {
				if (Object.prototype.hasOwnProperty.call(snapshot, key)) return true;
			}
			return false;
		}

		/**
		 * 一次性快照形状诊断：新旧结构（legacy.nodes / nodes / chat.order …）都支持，
		 * 这里只把「这次实际用的是哪种 + 行数」打出来；陌生形状明确警告。
		 * 数据还没到时（absent / non-object）不消耗这次机会。
		 */
		function reportSnapshotShapeOnce(snapshot, rowCount) {
			if (snapshotShapeReported) return;
			const shape = snapshotShapeOf(snapshot);
			if (shape === "absent" || shape === "non-object") return;
			if (shape === "unknown" && looksLikeChatSnapshot(snapshot) === false) return;
			snapshotShapeReported = true;
			const rows = typeof rowCount === "number" ? rowCount : safeNodesOf(snapshot).length;
			if (shape === "unknown") {
				console.warn(
					"[conversation] unrecognised session snapshot shape; the outline stays empty. "
					+ "Expected legacy.nodes[] / nodes[] / items[] / messages[] / chat.{order,nodes}. "
					+ "Keys seen: " + Object.keys(snapshot).join(", "),
				);
				return;
			}
			console.info("[conversation] session snapshot shape: " + shape + " (" + rows
				+ (rows === 1 ? " row)" : " rows)"));
		}

		/** 测试用：重置一次性诊断标记（生产代码不调用）。 */
		function resetDiagnostics() {
			domContractReported = false;
			snapshotShapeReported = false;
		}

		function compactText(value) {
			return value.replace(/\s+/g, "");
		}

		function elementText(el) {
			return el.textContent === null || el.textContent === undefined ? "" : el.textContent;
		}

		function matchesUser(el, item) {
			const probe = compactText(item.text.slice(0, 20));
			if (probe === "") return true;
			return compactText(elementText(el)).includes(probe);
		}

		function matchesHeading(el, item) {
			return el.tagName === "H" + item.level && elementText(el).trim() === item.text;
		}

		function locateItem(root, item) {
			if (item.isUserQuery === true) {
				const rows = collectUserRows(root);
				const direct = item.userIndex === undefined ? undefined : rows[item.userIndex];
				if (direct !== undefined && matchesUser(direct, item)) return direct;
				if (compactText(item.text) === "") return null;
				const hit = rows.filter((el) => matchesUser(el, item));
				return hit.length === 0 ? null : hit[0];
			}
			const headings = collectHeadings(root);
			const direct = item.headingIndex === undefined ? undefined : headings[item.headingIndex];
			if (direct !== undefined && matchesHeading(direct, item)) return direct;
			const hit = headings.filter((el) => matchesHeading(el, item));
			return hit.length === 0 ? null : hit[0];
		}

		/** 宿主内部锚点属性（hqst 旧契约）优先，命不中再走大纲的顺序匹配。 */
		function locateByKey(key) {
			if (key === undefined || key === null) return null;
			const suffix = String(key).replace(/"/g, '\\"');
			const selectors = [
				'[data-chat-anchor-key="' + suffix + '"]',
				'[data-message-key="' + suffix + '"]',
				'[data-node-key="' + suffix + '"]',
			];
			for (const selector of selectors) {
				try {
					const el = document.querySelector(selector);
					if (el instanceof HTMLElement) return el;
				} catch (e) { /* 非法选择器：换下一个候选 */ }
			}
			try {
				const rows = document.querySelectorAll("[data-chat-anchor-key]");
				for (const row of rows) {
					if (row.getAttribute("data-chat-anchor-key") === String(key)) return row;
				}
			} catch (_) {}
			return null;
		}

		function flashElement(el) {
			try {
				el.classList.add(FLASH_CLASS);
				window.setTimeout(() => { el.classList.remove(FLASH_CLASS); }, FLASH_MS);
			} catch (e) { /* 高亮是 best-effort */ }
		}

		function scrollToItem(root, item) {
			const el = locateByKey(item.key) || locateItem(root, item);
			if (el === null) return false;
			const container = findChatScrollContainer(root);
			if (container !== null) scrollElementInContainer(el, container);
			else el.scrollIntoView({ block: "start" });
			flashElement(el);
			return true;
		}

		function scrollChatToTop(root) {
			const container = findChatScrollContainer(root);
			if (container !== null) container.scrollTo({ top: 0, behavior: "instant" });
		}

		function scrollChatToBottom(root) {
			const container = findChatScrollContainer(root);
			if (container !== null) container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
		}

		function computeActiveItemId(root, items) {
			const container = findChatScrollContainer(root);
			if (container === null) return null;
			const threshold = container.getBoundingClientRect().top + 80;
			let active = null;
			for (const item of items) {
				const el = locateItem(root, item);
				if (el === null) continue;
				if (el.getBoundingClientRect().top <= threshold) active = item;
				else break;
			}
			return active === null ? null : active.id;
		}

		/**
		 * 扁平顺序里"下一节的起点"：下一个同级或更高级的节点。
		 * 没有这样的节点说明已是最后一节 → 返回 null（调用方回退到"滚到底部"）。
		 */
		function nextSectionItem(flat, item) {
			const index = flat.findIndex((node) => node.id === item.id);
			if (index === -1) return null;
			for (let i = index + 1; i < flat.length; i++) {
				if (flat[i].level <= item.level) return flat[i];
			}
			return null;
		}

		/** 把树摊平成先序数组（面板跟随与节跳转共用）。 */
		function flattenTree(nodes, out) {
			const list = out === undefined ? [] : out;
			for (const node of nodes) {
				list.push(node);
				flattenTree(node.children, list);
			}
			return list;
		}

		/** 当前节点所在的顶层轮次 id（侧边刻度条要高亮"第几轮"）。 */
		function topLevelId(tree, id) {
			const path = findPath(tree, id);
			return path === null || path.length === 0 ? null : path[0].id;
		}

		const CHROME_KEY = "dsh-conversation:panel";
		const LEVEL_KEY = "dsh-conversation:expandLevel";
		const BOOKMARKS_PREFIX = "dsh-conversation:bookmarks:";
		const BOOKMARKS_CAP = 200;
		const POS_PREFIX = "dsh-conversation:pos:";

		/* 面板背景不透明度（百分比）。100 = 完全不透明，也就是旧版本的观感；
		   下限压到 40：再低正文对比度就崩了，不如不给这一档。
		   背景模糊半径由它反向派生（见 panelSurfaceStyle）：越透明 → 背后的字越
		   透得出来，模糊半径也越大。这是设计使然，不是渲染故障 —— UI 文案要把
		   「它调的是背景不透明度、模糊跟着反向变」讲清楚，别让人误以为自己在调模糊。 */
		const OPACITY_MIN = 40;
		const OPACITY_MAX = 100;
		const OPACITY_STEP = 5;

		function normalizeOpacity(value) {
			if (typeof value !== "number" || Number.isFinite(value) === false) return OPACITY_MAX;
			const clamped = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, value));
			return Math.round(clamped / OPACITY_STEP) * OPACITY_STEP;
		}

		/**
		 * 宿主能否混出半透明底色。DSH 桌面端跑 Electron，Chromium 111+ 才有 color-mix；
		 * 更老的宿主上该声明会被整行丢弃、底色恒为纯色，此时滑杆拖了没有效果——
		 * 与其留一个「拖了没反应」的控件，不如整行不渲染。
		 * 取不到 CSS.supports（非浏览器环境、单测）时按支持处理，避免误伤。
		 */
		function supportsBackgroundAlpha() {
			try {
				if (typeof CSS === "undefined" || CSS === null || typeof CSS.supports !== "function") return true;
				return CSS.supports("background", "color-mix(in srgb, #fff 50%, transparent)") === true;
			} catch (e) {
				return true;
			}
		}

		function readJson(key) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? null : JSON.parse(raw);
			} catch (e) {
				return null;
			}
		}

		function writeJson(key, value) {
			try {
				window.localStorage.setItem(key, JSON.stringify(value));
			} catch (e) { /* 隐私模式写失败：偏好丢失可接受 */ }
		}

		function createChromeStore() {
			const saved = readJson(CHROME_KEY);
			const picked = saved === null || typeof saved !== "object" ? {} : saved;
			let state = {
				// hqst 历史上是常驻面板；dsh-outline 的 open=true 也迁移为 pinned=true。
				pinned: picked.pinned === undefined
					? (picked.open === undefined ? true : picked.open === true)
					: picked.pinned === true,
				left: typeof picked.left === "number" ? picked.left : null,
				top: typeof picked.top === "number" ? picked.top : null,
				// 面板尺寸档位：panel / wide / full。
				view: VIEW_ORDER.indexOf(picked.view) === -1 ? "panel" : picked.view,
				// 停用保留：面板收起时是否显示右侧刻度条（原默认 true）。
				// 刻度条渲染点已在 7a525af 移除，此字段自此只写不读，故一并注释掉。
				// 老 localStorage 里的 rail 键不会被清除、但也读不到；恢复这行即可继续复用旧值。
				// rail: picked.rail === undefined ? true : picked.rail === true,
				// 面板背景不透明度；老用户没有这个字段，归一化后落到 100，观感不变。
				opacity: normalizeOpacity(picked.opacity),
			};
			const listeners = new Set();
			return {
				getSnapshot: () => state,
				subscribe(fn) {
					listeners.add(fn);
					return () => { listeners.delete(fn); };
				},
				set(patch) {
					state = Object.assign({}, state, patch);
					writeJson(CHROME_KEY, state);
					for (const fn of listeners) fn();
				},
			};
		}

		function loadExpandLevel() {
			const value = readJson(LEVEL_KEY);
			return typeof value === "number" && value >= 0 && value <= 6 ? value : 6;
		}

		function saveExpandLevel(level) {
			writeJson(LEVEL_KEY, level);
		}

		function loadBookmarks(sessionId) {
			const value = readJson(BOOKMARKS_PREFIX + sessionId);
			return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
		}

		function saveBookmarks(sessionId, ids) {
			writeJson(BOOKMARKS_PREFIX + sessionId, Array.from(ids).slice(-BOOKMARKS_CAP));
		}

		/** 每个会话的阅读位置（节点签名 id）：切回来时面板能直接落在上次看到的地方。 */
		function loadPos(sessionId) {
			const value = readJson(POS_PREFIX + sessionId);
			return typeof value === "string" && value !== "" ? value : null;
		}

		function savePos(sessionId, id) {
			if (typeof id !== "string" || id === "") return;
			writeJson(POS_PREFIX + sessionId, id);
		}

		function formatTime(ms) {
			try {
				return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			} catch (e) {
				return "";
			}
		}

		/** 大纲 → Markdown 文本（复制到剪贴板与导出文件共用同一份渲染）。 */
		function outlineToMarkdown(tree, t) {
			const lines = ["# " + t("panel.title"), ""];
			const walk = (nodes) => {
				for (const node of nodes) {
					const indent = "  ".repeat(Math.max(0, node.level));
					lines.push(node.isUserQuery === true
						? "- **Q" + (node.queryIndex === undefined ? "" : node.queryIndex) + "** " + node.text
						: indent + "#".repeat(node.level) + " " + node.text);
					walk(node.children);
				}
			};
			walk(tree);
			return lines.join("\n") + "\n";
		}

		/** 按节点签名 id 在树里找节点（侧边刻度点击用）。 */
		function findNodeById(nodes, id) {
			for (const node of nodes) {
				if (node.id === id) return node;
				const hit = findNodeById(node.children, id);
				if (hit !== null) return hit;
			}
			return null;
		}

		function OutlineGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M2 3.5h10M2 7h6.5M2 10.5h8.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }));
		}

		function OpacityGlyph() {
			return h("svg", {
				viewBox: "0 0 16 16",
				width: 13,
				height: 13,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				"aria-hidden": true,
			},
				h("circle", { cx: 8, cy: 8, r: 6 }),
				h("path", { d: "M8 2 A6 6 0 0 0 8 14 Z", fill: "currentColor", stroke: "none" }));
		}

		function DockSideGlyph(props) {
			return h("svg", {
				viewBox: "0 0 16 16",
				width: 14,
				height: 14,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.6,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
			},
				h("rect", { x: 2, y: 2, width: 12, height: 12, rx: 2 }),
				props && props.side === "left"
					? h("line", { x1: 6, y1: 2, x2: 6, y2: 14 })
					: h("line", { x1: 10, y1: 2, x2: 10, y2: 14 }));
		}

		function GitHubGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" },
				h("path", { d: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" }));
		}

		/**
		 * Extract preview text for hover tooltip.
		 * - User query: first sentence (~200 chars of正文首段)
		 * - Heading node: parent turn's opening body or just repeat heading text with context
		 */
		function PreviewLabelGlyph(props) {
			const node = props.node;
			const parts = [];
			if (node.isUserQuery === true) {
				parts.push(node.text);
			} else {
				parts.push("## " + node.text);
				if (typeof node.toolCount === "number" && node.toolCount > 0) {
					parts.push("🔧 工具调用 " + node.toolCount + " 次");
				}
				if (typeof node.charCount === "number" && node.charCount > 0) {
					parts.push("📝 正文 " + node.charCount + " 字");
				}
			}
			return h("div", {}, parts.join("\n"));
		}

		function CloseGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M4 4l6 6M10 4l-6 6", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }));
		}

		function ExpandAllGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("path", { d: "M4 6h6" }),
				h("path", { d: "M4 10h9" }),
				h("path", { d: "M4 14h9" }),
				h("path", { d: "M4 18h6" }),
				h("path", { d: "M18 5v14" }),
				h("path", { d: "m15.5 7.5 2.5-2.5 2.5 2.5" }),
				h("path", { d: "m15.5 16.5 2.5 2.5 2.5-2.5" }));
		}

		function CollapseAllGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("path", { d: "M4 6h9" }),
				h("path", { d: "M4 12h9" }),
				h("path", { d: "M4 18h9" }),
				h("path", { d: "M18 3v6" }),
				h("path", { d: "m15.5 6.5 2.5 2.5 2.5-2.5" }),
				h("path", { d: "M18 21v-6" }),
				h("path", { d: "m15.5 17.5 2.5-2.5 2.5 2.5" }));
		}

		function SearchGlyph() {
			return h("svg", { width: "14", height: "14", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true" },
				h("circle", { cx: "6.3", cy: "6.3", r: "3.8", stroke: "currentColor", strokeWidth: "1.5" }),
				h("path", { d: "M9.2 9.2l2.6 2.6", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }));
		}

		function StarGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true" },
				h("path", {
					d: "M7 1.8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 10.1l-3.2 1.6.6-3.6L1.8 5.6l3.6-.5L7 1.8z",
					stroke: "currentColor", strokeWidth: "1.2", strokeLinejoin: "round",
				}));
		}

		function CopyGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 1024 1024", fill: "currentColor", "aria-hidden": "true" },
				h("path", { d: "M632.96 954.88H201.813333a132.906667 132.906667 0 0 1-132.693333-132.693333V391.04a132.906667 132.906667 0 0 1 132.693333-132.906667h431.146667a132.906667 132.906667 0 0 1 132.906667 132.906667v431.146667a132.906667 132.906667 0 0 1-132.906667 132.693333zM201.813333 352a39.04 39.04 0 0 0-38.826666 39.04v431.146667a39.04 39.04 0 0 0 38.826666 38.826666h431.146667a39.04 39.04 0 0 0 39.04-38.826666V391.04a39.04 39.04 0 0 0-39.04-39.04z" }),
				h("path", { d: "M907.946667 846.293333a47.146667 47.146667 0 0 1-46.933334-46.933333V234.666667A71.04 71.04 0 0 0 789.333333 162.986667H224.64a46.933333 46.933333 0 1 1 0-93.866667H789.333333A164.906667 164.906667 0 0 1 954.88 234.666667v565.333333a46.933333 46.933333 0 0 1-46.933333 46.293333z" }),
				h("path", { d: "M531.626667 561.066667h-241.066667a46.933333 46.933333 0 0 1 0-93.866667h241.066667a46.933333 46.933333 0 0 1 0 93.866667zM531.626667 731.733333h-241.066667a46.933333 46.933333 0 0 1 0-93.866666h241.066667a46.933333 46.933333 0 0 1 0 93.866666z" }));
		}

		function CheckGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("polyline", { points: "20 6 9 17 4 12" }));
		}

		function ScrollTopGlyph() {
			return h("svg", { width: "14", height: "14", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true" },
				h("path", {
					d: "M2.5 2.5h9M7 11.5V5.2M4.6 7.4L7 5l2.4 2.4",
					stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round",
				}));
		}

		function ScrollBottomGlyph() {
			return h("svg", { width: "14", height: "14", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true" },
				h("path", {
					d: "M2.5 11.5h9M7 2.5v6.3M4.6 6.6L7 9l2.4-2.4",
					stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round",
				}));
		}

		function ChevronGlyph() {
			return h("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M4 2.5l4 3.5-4 3.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }));
		}

		/** 加宽：贴左向右、贴右向左、居中两侧对称（与全屏的"四角"图标区分开）。 */
		function WideGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M5 4.5L2.5 7 5 9.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }),
				h("path", { d: "M9 4.5L11.5 7 9 9.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }));
		}

		/** 全屏：四角外扩。 */
		function FullGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M2 5V2h3M12 5V2H9M2 9v3h3M12 9v3H9", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }));
		}

		/** 导出：向下箭头 + 底线（落到文件）。 */
		function ExportGlyph() {
			return h("svg", { width: "15", height: "15", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M7 2v7M4.2 6.4L7 9.2l2.8-2.8M2.5 11.5h9", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }));
		}

// ==== 停用保留：右侧刻度条组件 SessionRail ====
// 失效原因：唯一调用方是本文件后部的 HistoryOutlineRailWrapper，而它同样已停用，
//           因此这个组件没有任何可达路径，渲染不出任何东西。
// 保留原因：维护者决定留待刻度条功能重启时复用，只注释不删除。
// 恢复方式：去掉本段每行行首的注释符，并恢复 wrapper 的槽位注册。
// 停用日期：2026-11-03（v1.5.4 之后）。
		// /**
		 // * 侧边刻度条（面板收起时的常驻导航）：一 tick = 一轮提问，
		 // * fill 的宽度按该轮正文长度归一化 —— 顺带成了对话的"密度图"。
		 // */
		// const SessionRail = function SessionRail(props) {
			// const ticks = [];
			// for (const tick of props.ticks) {
				// const ratio = props.maxChars <= 0
					// ? 0.3
					// : Math.max(0.12, Math.min(1, tick.charCount / props.maxChars));
				// const active = tick.id === props.activeTickId;
				// ticks.push(h("button", {
					// key: tick.id,
					// type: "button",
					// className: active ? "dsh-conv-railtick dsh-conv-railtick-active" : "dsh-conv-railtick",
					// title: "Q" + (tick.queryIndex === undefined ? "" : tick.queryIndex) + " · " + tick.text,
					// "aria-label": tick.text,
					// onClick: () => props.onJump(tick),
				// }, h("span", { className: "dsh-conv-railfill", style: { width: Math.round(ratio * 100) + "%" } })));
			// }
			// return h("div", { className: "dsh-conv-rail", role: "navigation", "aria-label": props.t("rail.title") },
				// h("button", {
					// type: "button",
					// className: "dsh-conv-railbtn",
					// title: props.t("rail.open"),
					// "aria-label": props.t("rail.open"),
					// onClick: props.onOpen,
				// }, h(OutlineGlyph)),
				// ticks.length === 0 ? null : h("div", { className: "dsh-conv-railticks" }, ticks));
		// };

		function LevelSlider(props) {
			stg("child:LevelSlider");
			const counts = props.levelCounts === undefined || props.levelCounts === null ? {} : props.levelCounts;
			const dots = [];
			for (let level = 0; level <= 6; level++) {
				let className = "dsh-conv-dot";
				if (level <= props.expandLevel) className += " dsh-conv-dot-active";
				if (level === props.expandLevel) className += " dsh-conv-dot-current";
				dots.push(h("button", {
					key: level,
					type: "button",
					className,
					title: level === 0
						? props.t("level.zero")
						: props.t("level.tooltip", { level, count: counts[level] === undefined ? 0 : counts[level] }),
					"aria-label": level === 0 ? props.t("level.zero") : "H" + level,
					onClick: () => props.onChange(level),
				}));
			}
			return h("div", { className: "dsh-conv-slider", role: "group", "aria-label": "level" },
				h("div", { className: "dsh-conv-sliderdots" },
					h("div", { className: "dsh-conv-slidertrack" },
						h("div", { className: "dsh-conv-sliderprogress", style: { width: (props.expandLevel / 6) * 100 + "%" } })),
					dots),
				h("span", { className: "dsh-conv-sliderlabel" },
					props.expandLevel === 0 ? props.t("level.zero") : "H" + props.expandLevel));
		}

		/**
		 * 面板背景透明度控件：滑杆 + 百分比读数。
		 * 点百分比回到 100%（完全不透明）；双击滑杆也一样，供不习惯点数字的人用。
		 */
		function OpacityControl(props) {
			stg("child:OpacityControl");
			const value = normalizeOpacity(props.value);
			return h("div", { className: "dsh-conv-appearance" },
				h("span", {
					className: "dsh-conv-appearance-glyph",
					title: props.t("appearance.opacityTooltip"),
					"aria-hidden": "true",
				}, h(OpacityGlyph)),
				h("input", {
					className: "dsh-conv-opacity",
					type: "range",
					min: OPACITY_MIN,
					max: OPACITY_MAX,
					step: OPACITY_STEP,
					value,
					title: props.t("appearance.opacityTooltip"),
					"aria-label": props.t("appearance.opacity"),
					"aria-valuetext": value + "%",
					onChange: (e) => props.onChange(Number(e.target.value)),
					onDoubleClick: () => props.onChange(OPACITY_MAX),
				}),
				h("button", {
					type: "button",
					className: value === OPACITY_MAX
						? "dsh-conv-opacitylabel dsh-conv-opacitylabel-max"
						: "dsh-conv-opacitylabel",
					title: props.t("appearance.reset"),
					"aria-label": props.t("appearance.opacity") + " " + value + "%",
					onClick: () => props.onChange(OPACITY_MAX),
				}, value + "%"));
		}

		function HighlightText(props) {
			stg("child:HighlightText");
			const { query } = props;
			const text = typeof props.text === "string" ? props.text : String(props.text === undefined || props.text === null ? "" : props.text);
			if (query === "" || props.isMatch !== true) return text;
			const lower = text.toLowerCase();
			const needle = query.toLowerCase();
			if (needle === "") return text;
			const parts = [];
			let i = 0;
			while (i < text.length) {
				const hit = lower.indexOf(needle, i);
				if (hit === -1) {
					parts.push({ text: text.slice(i), hit: false });
					break;
				}
				if (hit > i) parts.push({ text: text.slice(i, hit), hit: false });
				parts.push({ text: text.slice(hit, hit + needle.length), hit: true });
				i = hit + needle.length;
			}
			return parts.map((part, idx) => part.hit
				? h("mark", { key: idx, className: "dsh-conv-mark" }, part.text)
				: part.text);
		}

		function OutlineRow(props) {
			stg("child:OutlineRow");
			const node = props.node;
			const hasChildren = Array.isArray(node.children) && node.children.length > 0;
			let className = "dsh-conv-item";
			if (props.active) className += " dsh-conv-item-active";
			if (node.isUserQuery === true) className += " dsh-conv-item-user";
			let chevronClass = "dsh-conv-chevron";
			if (hasChildren === false) chevronClass += " dsh-conv-chevron-hidden";
			if (node.collapsed !== true) chevronClass += " dsh-conv-chevron-open";
			const children = [
				h("span", {
					key: "chevron",
					className: chevronClass,
					onClick: (e) => {
						if (hasChildren === false) return;
						e.stopPropagation();
						props.onToggle(node);
					},
				}, h(ChevronGlyph)),
			];
			if (node.isUserQuery === true) {
				children.push(h("span", { key: "badge", className: "dsh-conv-badge" }, node.queryIndex));
			}
			let textClass = "dsh-conv-itemtext";
			if (node.streaming === true) textClass += " dsh-conv-itemstreaming";
			children.push(h("span", { key: "text", className: textClass },
				h(HighlightText, { text: node.text, query: props.query, isMatch: node.isMatch === true })));
			if (typeof node.ts === "number") {
				children.push(h("span", { key: "time", className: "dsh-conv-time" }, formatTime(node.ts)));
			}
			// 行内统计：这一轮用了多少次工具、正文多少字（只有提问行带）。
			const chips = [];
			if (node.isUserQuery === true && typeof node.toolCount === "number" && node.toolCount > 0) {
				chips.push(h("span", { key: "tools", className: "dsh-conv-metachip" },
					props.t("meta.tools", { count: node.toolCount })));
			}
			if (node.isUserQuery === true && typeof node.charCount === "number" && node.charCount > 0) {
				chips.push(h("span", { key: "chars", className: "dsh-conv-metachip" },
					props.t("meta.chars", { count: node.charCount })));
			}
			if (chips.length > 0) children.push(h("span", { key: "meta", className: "dsh-conv-meta" }, chips));
			children.push(h("span", {
				key: "bookmark",
				className: node.isBookmarked === true ? "dsh-conv-bookmark dsh-conv-bookmark-active" : "dsh-conv-bookmark",
				title: node.isBookmarked === true ? props.t("action.bookmarkRemove") : props.t("action.bookmarkAdd"),
				onClick: (e) => {
					e.stopPropagation();
					props.onBookmark(node);
				},
			}, h(StarGlyph)));
			return h("div", {
				className,
				style: { paddingLeft: 8 + node.level * 14 },
				"data-level": node.level,
				"data-hq-id": node.id,
				role: "button",
				tabIndex: 0,
				title: props.t("action.sectionEnd"),
				onClick: () => props.onClick(node),
				onDoubleClick: (e) => {
					e.preventDefault();
					props.onJumpEnd(node);
				},
				onKeyDown: (e) => {
					if (e.key !== "Enter" && e.key !== " ") return;
					e.preventDefault();
					props.onClick(node);
				},
				onMouseEnter: (e) => {
					if (props.previewSetter === undefined) return;
					const rect = e.currentTarget.getBoundingClientRect();
					const side = previewSideFor(rect.left, rect.right, window.innerWidth);
					props.previewSetter({
						node,
						// 只给「行的哪一条边」，间距统一由 previewPlacement 加 —— 两边各加
						// 一次会让浮层翻到左侧时反压住行首。
						x: side === "left" ? rect.left : rect.right,
						y: rect.top,
						side,
					});
				},
				onMouseLeave: () => {
					if (props.previewSetter !== undefined) props.previewSetter(null);
				},
			}, children);
		}

		/**
		 * 从宿主会话快照提取对话节点数组（两代契约全兼容）。
		 * 官方标准：legacy.nodes (0.1.2+) 优先、nodes 兜底。
		 */
		function conversationNodesOf(s) {
			if (!s) return [];
			if (Array.isArray(s)) return s;
			const legacy = s.legacy;
			if (legacy !== null && legacy !== undefined && typeof legacy === "object" && Array.isArray(legacy.nodes)) {
				return legacy.nodes;
			}
			if (Array.isArray(s.nodes)) return s.nodes;
			if (Array.isArray(s.items)) return s.items;
			if (Array.isArray(s.messages)) return s.messages;
			if (s.chat && Array.isArray(s.chat.order)) {
				const nodes = s.chat.nodes;
				const out = [];
				if (nodes && typeof nodes.get === "function") {
					for (const key of s.chat.order) {
						const row = nodes.get(key);
						if (row) out.push(row);
					}
					return out;
				}
				if (nodes && typeof nodes === "object") {
					for (const key of s.chat.order) {
						const row = nodes[key];
						if (row) out.push(row);
					}
					return out;
				}
			}
			if (s.nodes && typeof s.nodes.values === "function") {
				try {
					const vals = s.nodes.values();
					if (Array.isArray(vals)) return vals;
				} catch (_) {}
			}
			return [];
		}

		/**
		 * 快照归一后的数组兜底。宿主换快照形状、第三方 header 传自定义 props、或服务暂时
		 * 不可用时，返回值都可能是 undefined / 非数组；UI 只接受数组。
		 */
		function safeNodesOf(snapshot) {
			let rows;
			try {
				rows = conversationNodesOf(snapshot);
			} catch (_) {
				return [];
			}
			return Array.isArray(rows) ? rows : [];
		}

		/**
		 * 只读宿主服务：优先走 cordis 反射层（`ctx.reflect.get(name, false)` —— 未提供时
		 * 返回 undefined 而不是抛错），再退回属性访问。宿主改名 / 尚未就绪时返回 undefined，
		 * 由 UI 降级为空态 —— 与 README/SECURITY 的「宿主 API 降级不拖垮同槽位」承诺一致。
		 */
		function readHostService(ctx, name) {
			if (ctx === null || ctx === undefined) return undefined;
			try {
				const reflect = ctx.reflect;
				if (reflect !== null && reflect !== undefined && typeof reflect.get === "function") {
					const value = reflect.get(name, false);
					if (value !== undefined && value !== null) return value;
				}
			} catch (_) { /* 反射层不可用：继续尝试属性访问 */ }
			try {
				const value = ctx[name];
				return value === null ? undefined : value;
			} catch (_) {
				return undefined;
			}
		}

		/**
		 * 插件私有的宿主桥。apply() 时创建一次，随槽位 props 下发（包装器里最后合并，
		 * 第三方 header 传什么 props 都覆盖不掉它）：
		 * - slot props 里的 useChat / useSession / useSessions 在 0.2.0-rc.2 的
		 *   `conversation.session.header.actions` 上可能全缺失，面板因此还有第二条数据路径：
		 *   直接读 uiSession 服务里「主视图绑定」的 chat / session 源；
		 * - 服务同样缺失（旧宿主 / 精简宿主）时退回 slot props 路径，行为与 1.3.1 一致。
		 */
		function createHostBridge(ctx) {
			return {
				read(name) {
					return readHostService(ctx, name);
				},
			};
		}

		// uSES 的 fallback source 必须是模块级常量：服务缺席时 hook 形状仍与就绪时一致。
		const NOOP_SUBSCRIBE = () => () => {};
		const EMPTY_HOST_SNAPSHOT = Object.freeze({});
		const EMPTY_HOST_SNAPSHOT_GET = () => EMPTY_HOST_SNAPSHOT;

		/** 把一个 { getSnapshot, subscribe } 的宿主 store 包成 uSES 可直接使用的稳定 source。
		 *  订阅/读取都吞掉异常：宿主 store 抛错时返回空快照，面板降级为空态而不是崩槽位。 */
		function snapshotSourceOf(store) {
			/* 宿主 store 的 getSnapshot/subscribe 可能是 getter（0.2.x 的 store 是类实例）：
			   读取属性本身就会抛错，因此整段探测都放进 try/catch，坏 store 只降级为 null。 */
			try {
				if (store === null || store === undefined || typeof store !== "object") return null;
				if (typeof store.getSnapshot !== "function" || typeof store.subscribe !== "function") return null;
				return {
					subscribe: (listener) => {
						try {
							const off = store.subscribe(listener);
							return typeof off === "function" ? off : NOOP_SUBSCRIBE();
						} catch (_) {
							return NOOP_SUBSCRIBE();
						}
					},
					getSnapshot: () => {
						try {
							const value = store.getSnapshot();
							return value === undefined ? EMPTY_HOST_SNAPSHOT : value;
						} catch (_) {
							return EMPTY_HOST_SNAPSHOT;
						}
					},
				};
			} catch (_) {
				return null;
			}
		}

		/** 从宿主桥读服务；bridge 自己抛错时按缺失处理（不向上冒泡）。 */
		function hostServiceOf(host, name) {
			if (host === null || host === undefined || typeof host.read !== "function") return undefined;
			try {
				return host.read(name);
			} catch (_) {
				return undefined;
			}
		}

		/** 会话列表里「主视图正在使用」的会话（与宿主 ui-session 的 publishMain 同款判定）。 */
		function mainSessionIdOf(sessionsService, listSnapshot) {
			/* 与宿主 dsh-client-ui-session `publishMain()` 同序：
			   current 且 retainedBy.mainView>0 优先，否则 byId 的插入顺序里第一个 retained>0 的会话。
			   整个探测过程吞异常：服务/快照是宿主对象，getter 可能抛错（不能让槽位渲染挂掉）。 */
			try {
				if (sessionsService === null || sessionsService === undefined) return undefined;
				let list = listSnapshot;
				if (list === null || list === undefined || typeof list !== "object") {
					try {
						const store = safeRead(sessionsService, "list");
						list = store !== null && store !== undefined && typeof store.getSnapshot === "function"
							? store.getSnapshot() : undefined;
					} catch (_) {
						list = undefined;
					}
				}
				if (list === null || list === undefined || typeof list !== "object") return undefined;
				const byId = safeRead(list, "byId");
				const retainedOf = (row) => {
					const retainedBy = safeRead(row, "retainedBy");
					return Number(safeRead(retainedBy, "mainView")) || 0;
				};
				const currentId = safeRead(list, "current");
				if (typeof currentId === "string" && currentId.length > 0
					&& byId !== null && typeof byId === "object") {
					const currentRow = safeRead(byId, currentId);
					if (currentRow !== undefined && retainedOf(currentRow) > 0) return currentId;
				}
				if (byId !== null && typeof byId === "object") {
					for (const id of Object.keys(byId)) {
						if (retainedOf(safeRead(byId, id)) > 0) return id;
					}
				}
				if (typeof currentId === "string" && currentId.length > 0) return currentId;
				const ids = safeRead(list, "ids");
				return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string" ? ids[0] : undefined;
			} catch (_) {
				return undefined;
			}
		}

		/**
		 * slot props 路径的回退快照 selector（0.1.x 契约）：props 里带 sessions 服务时，
		 * 用会话根的 current 找当前会话 face。纯函数，hook 已在组件顶层调用。
		 */
		function makeSessionBindingSelector(sessionsFace) {
			return (root) => {
				try {
					if (root === null || root === undefined || typeof root !== "object") return null;
					const id = typeof root.current === "string" ? root.current : undefined;
					if (id === undefined || sessionsFace === null || sessionsFace === undefined
						|| typeof sessionsFace.binding !== "function") return null;
					const binding = sessionsFace.binding(id);
					return binding !== null && binding !== undefined && binding.session
						? binding.session.getSnapshot() : null;
				} catch (_) {
					return null;
				}
			};
		}

		/**
		 * 服务路径的会话快照（不依赖 slot props）。每个 hook 都无条件调用：服务缺失时使用
		 * 模块级 no-op source，因此 hook 顺序不随宿主能力 / 数据时序变化（1.3.1 崩溃的反面）。
		 *
		 * 数据来源（宿主 0.2.0-rc.2 的公开面）：
		 * - `uiSession.current`：主视图绑定的 `{ key, hooks: { session, chat }, props }`；
		 * - `hooks.chat`：ChatSnapshot（`legacy.nodes` / `partial`），即大纲数据；
		 * - `hooks.session`：Session 对象（`hasMore` / `loadingOlder` / `loadOlder`）。
		 * uiSession 缺席时退回 `sessions.list` + `sessions.binding(id).session`；这条退路没有
		 * chat 源，因此只保证「不崩、不闪」，数据为空态而不是伪造。
		 */
		/** 稳定快照源：同一宿主 store（且 getSnapshot 身份不变）跨渲染返回同一个 {subscribe,getSnapshot}，
		 *  避免 useSyncExternalStore 因 source 身份每轮变化而反复 resubscribe（PR review suggestion 3）。
		 *  只缓存源对象、不改宿主 store；store 换了立即重建。 */
		/** 只读属性访问：宿主对象上的 getter 可能抛错，槽位渲染期间任何服务属性读取都必须走这里。 */
		function safeRead(object, key) {
			try {
				return object === null || object === undefined ? undefined : object[key];
			} catch (_) {
				return undefined;
			}
		}

		function useStableSnapshotSource(store) {
			const sourceRef = useRef(null);
			const storeRef = useRef(null);
			const getRef = useRef(null);
			let get = null;
			try {
				get = store !== null && store !== undefined && typeof store.getSnapshot === "function"
					? store.getSnapshot : null;
			} catch (_) { get = null; }
			if (sourceRef.current === null || storeRef.current !== store || getRef.current !== get) {
				const source = snapshotSourceOf(store);
				if (source !== null) { source.__get = get; sourceRef.current = source; }
				else { sourceRef.current = null; }
				storeRef.current = store;
				getRef.current = get;
			}
			return sourceRef.current;
		}

		function useHostSession(host) {
			const uiSession = hostServiceOf(host, "uiSession");
			const sessionsService = hostServiceOf(host, "sessions");

			const currentSource = useStableSnapshotSource(safeRead(uiSession, "current"));
			const binding = useSyncExternalStore(
				currentSource === null ? NOOP_SUBSCRIBE : currentSource.subscribe,
				currentSource === null ? EMPTY_HOST_SNAPSHOT_GET : currentSource.getSnapshot,
			);
			const bindingKey = (() => {
				const key = safeRead(binding, "key");
				return typeof key === "string" && key.length > 0 ? key : undefined;
			})();

			const listSource = useStableSnapshotSource(safeRead(sessionsService, "list"));
			const listSnapshot = useSyncExternalStore(
				listSource === null ? NOOP_SUBSCRIBE : listSource.subscribe,
				listSource === null ? EMPTY_HOST_SNAPSHOT_GET : listSource.getSnapshot,
			);
			const listedSessionId = useMemo(() => mainSessionIdOf(sessionsService, listSnapshot), [sessionsService, listSnapshot]);
			const sessionId = bindingKey === undefined ? listedSessionId : bindingKey;

			const bindingHooks = safeRead(binding, "hooks");
			const chatSource = useStableSnapshotSource(safeRead(bindingHooks, "chat"));
			const chatSnapshot = useSyncExternalStore(
				chatSource === null ? NOOP_SUBSCRIBE : chatSource.subscribe,
				chatSource === null ? EMPTY_HOST_SNAPSHOT_GET : chatSource.getSnapshot,
			);

			const session = useMemo(() => {
				try {
					const hooks = safeRead(binding, "hooks");
					const direct = safeRead(hooks, "session");
					if (direct !== null && direct !== undefined && typeof direct.getSnapshot === "function"
						&& typeof direct.subscribe === "function") {
						return direct;
					}
					if (sessionId === undefined || sessionsService === null || sessionsService === undefined
						|| typeof sessionsService.binding !== "function") return null;
					const found = sessionsService.binding(sessionId);
					const fallback = safeRead(found, "session");
					return fallback !== null && fallback !== undefined
						&& typeof fallback.getSnapshot === "function" && typeof fallback.subscribe === "function"
						? fallback : null;
				} catch (_) {
					return null;
				}
			}, [binding, sessionId, sessionsService]);

			const sessionSource = useStableSnapshotSource(session);
			const sessionSnapshot = useSyncExternalStore(
				sessionSource === null ? NOOP_SUBSCRIBE : sessionSource.subscribe,
				sessionSource === null ? EMPTY_HOST_SNAPSHOT_GET : sessionSource.getSnapshot,
			);

			const nodes = useMemo(() => safeNodesOf(chatSnapshot), [chatSnapshot]);
			const snapshot = chatSnapshot !== null && typeof chatSnapshot === "object" ? chatSnapshot : null;
			return {
				// available 只看"真的能读"的源：宿主把服务对象给成空壳（如 ctx.sessions = {}）
				// 时不能让闸门误判为"服务可用但未就绪"，否则旧宿主/测试会被卡在占位。
				available: currentSource !== null || listSource !== null
					|| (sessionsService !== null && sessionsService !== undefined
						&& typeof sessionsService.binding === "function"),
				ready: sessionId !== undefined,
				sessionId,
				session,
				sessions: sessionsService,
				snapshot,
				sessionSnapshot: sessionSnapshot !== null && typeof sessionSnapshot === "object" ? sessionSnapshot : null,
				nodes,
				hasMore: sessionSnapshot !== null && typeof sessionSnapshot === "object" && sessionSnapshot.hasMore === true,
				loadingOlder: sessionSnapshot !== null && typeof sessionSnapshot === "object" && sessionSnapshot.loadingOlder === true,
			};
		}

		/**
		 * 首屏挂载闸门：数据未就绪时先渲染占位，就绪后再挂载面板组件。
		 * - 宿主服务不可用（旧宿主 / 测试桩）⇒ 无法判断就绪，保持 1.3.1 的直接挂载；
		 * - 服务可用但还没有会话绑定 ⇒ pending（除非等待超时）；
		 * - 有会话绑定 ⇒ mount（此时 chat 快照可能仍是空数组，面板展示空态）。
		 */
		/**
		 * 窗口尺寸变化时让调用方重渲染一次：面板位置是按旧视口算的，窗口拉窄后
		 * 拖拽坐标会整块落到视口外。rAF 节流，拖动窗口时不会每个事件都渲染。
		 */
		function useViewportTick() {
			const [tick, setTick] = useState(0);
			useEffect(() => {
				if (typeof window === "undefined" || window === null || typeof window.addEventListener !== "function") return undefined;
				let raf = 0;
				const onResize = () => {
					if (raf !== 0) return;
					raf = window.requestAnimationFrame(() => {
						raf = 0;
						setTick((n) => n + 1);
					});
				};
				window.addEventListener("resize", onResize);
				return () => {
					window.removeEventListener("resize", onResize);
					if (raf !== 0) window.cancelAnimationFrame(raf);
				};
			}, []);
			return tick;
		}

		function panelMountStateOf(hostSession, timedOut) {
			if (hostSession === null || hostSession === undefined || hostSession.available !== true) return "mount";
			if (hostSession.ready === true) return "mount";
			return timedOut === true ? "mount" : "pending";
		}

		/** 只读「宿主是否就绪」的轻量 hook：只订阅 uiSession.current 与 sessions.list，
		 *  不订阅 chat 快照 ⇒ 流式 token 更新不会带着标题栏按钮一起重渲染（PR review suggestion 1）。 */
		function useHostReadiness(host) {
			const uiSession = hostServiceOf(host, "uiSession");
			const sessionsService = hostServiceOf(host, "sessions");
			const currentSource = useStableSnapshotSource(safeRead(uiSession, "current"));
			const binding = useSyncExternalStore(
				currentSource === null ? NOOP_SUBSCRIBE : currentSource.subscribe,
				currentSource === null ? EMPTY_HOST_SNAPSHOT_GET : currentSource.getSnapshot,
			);
			const bindingKey = (() => {
				const key = safeRead(binding, "key");
				return typeof key === "string" && key.length > 0 ? key : undefined;
			})();
			const listSource = useStableSnapshotSource(safeRead(sessionsService, "list"));
			const listSnapshot = useSyncExternalStore(
				listSource === null ? NOOP_SUBSCRIBE : listSource.subscribe,
				listSource === null ? EMPTY_HOST_SNAPSHOT_GET : listSource.getSnapshot,
			);
			const listedSessionId = useMemo(() => mainSessionIdOf(sessionsService, listSnapshot), [sessionsService, listSnapshot]);
			const sessionId = bindingKey === undefined ? listedSessionId : bindingKey;
			return {
				available: currentSource !== null || listSource !== null
					|| (sessionsService !== null && sessionsService !== undefined
						&& typeof sessionsService.binding === "function"),
				ready: sessionId !== undefined,
				sessionId,
				sessions: sessionsService,
			};
		}

		/**
		 * 无 hooks 的外壳：store 不可用时直接不渲染。
		 * 放在这里而不是组件内部，是为了不在 hooks 之前做条件返回。
		 */
		function HistoryOutlinePanel(props) {
			const store = props === undefined || props === null ? undefined : props.store;
			if (store === undefined || store === null
				|| typeof store.subscribe !== "function" || typeof store.getSnapshot !== "function") {
				return null;
			}
			return h(HistoryOutlinePanelInner, props);
		}

		function HistoryOutlinePanelInner(props) {
			const safeProps = props === undefined || props === null ? {} : props;
			const store = safeProps.store;
			stg("panel:before-t");
			const t = useMemo(() => makeTranslate(safeProps.t), [safeProps.t]);
			stg("panel:after-t");

			stg("panel:before-chrome");
			const chrome = useSyncExternalStore(store.subscribe, store.getSnapshot);
			stg("panel:after-chrome");

			/* ===== 钩子布局钉死（main 008030c）=====
			   无论宿主这次下发了哪几个 hook 工厂，本组件都固定调用 4 次：
			   3 次取会话状态 + 1 次取对话节点；缺哪一路就换成等价占位钩子。
			   （改造前按 props 形态条件调用，sessionId 从空变成字符串时少调一次，
			   hook 槽位整体错位 -> useMemo 抛 "Cannot read properties of undefined (reading 'length')"。） */
			const sessionSource = typeof safeProps.useSession === "function" ? safeProps.useSession
				: (typeof safeProps.useSessions === "function" ? safeProps.useSessions : useNoSession);
			const nodesSource = typeof safeProps.useChat === "function" ? safeProps.useChat
				: (sessionSource === useNoSession ? useNoNodes : sessionSource);

			stg("panel:before-hasMore");
			const propHasMore = sessionSource(SEL_HAS_MORE) === true;
			stg("panel:after-hasMore");
			const propLoadingOlder = sessionSource(SEL_LOADING_OLDER) === true;
			stg("panel:after-loadingOlder");
			const boundSessionId = sessionSource(SEL_CURRENT_ID);
			stg("panel:after-sessionsHook");
			const rawNodesSnapshot = nodesSource(IDENTITY_SNAPSHOT);
			/* 关键：safeNodesOf 对 chat.{order,nodes(Map)} 这类旧契约会分配新数组；若在 hook 外
			   直接算，每轮渲染 hookNodes 身份都变 ⇒ activeNodes/items 变化 ⇒ 下方 bump() effect
			   无限重渲染（真实 React：Maximum update depth exceeded）。用 useMemo 按原始快照身份
			   缓存归一结果；EMPTY_NODES 只是 safeNodesOf 返回空数组时的稳定占位。 */
			const hookNodes = useMemo(() => safeNodesOf(rawNodesSnapshot) || EMPTY_NODES, [rawNodesSnapshot]);
			stg("panel:after-hookNodes");

			/* 服务路径（PR#2 f228ac4，叠加在钉死布局之上）：
			   0.2.x 的 header.actions owner props 可能为空；服务桥在 apply() 时捕获
			   sessions / uiSession，这里无条件调用自己的 service hook（内部调用次数恒定），
			   不改变上面钉死的 4 次宿主 hook。 */
			const hostSession = useHostSession(safeProps.host);
			const sessionsFace = (safeProps.sessions !== null && safeProps.sessions !== undefined
				&& typeof safeProps.sessions.binding === "function") ? safeProps.sessions : hostSession.sessions;

			// 会话 id：优先槽位直接下发，其次 hook 选出的当前会话，最后服务路径。
			// 诊断要的是「宿主给的原始快照」：先取原始值，再统一 safeNodesOf 归一；
			// props 路径优先（hookNodes 本身已按 props → 服务的顺序合成），旧回退已并入服务桥。
			const propSnapshot = rawNodesSnapshot;
			const propNodes = hookNodes;
			const propFallbackSnapshot = null;
			const propSessionId = typeof safeProps.sessionId === "string" && safeProps.sessionId.length > 0
				? safeProps.sessionId : undefined;
			const sessionId = propSessionId !== undefined ? propSessionId : "";
			const currentId = sessionId !== ""
				? sessionId
				: (typeof boundSessionId === "string" && boundSessionId.length > 0
					? boundSessionId
					: (typeof hostSession.sessionId === "string" && hostSession.sessionId.length > 0
						? hostSession.sessionId : "default-session"));

			// 诊断用快照：props/宿主 hook 路径的原始快照；该路径无数据时用服务路径的 chat 快照。
			// （currentSessionNodes 是旧 sessions fallback 的归一结果，不在这里重复诊断。）
			const observedSnapshot = (Array.isArray(propNodes) && propNodes.length > 0)
				? propSnapshot
				: (hostSession.snapshot !== null ? hostSession.snapshot : propFallbackSnapshot);

			const hasMore = propHasMore === true || hostSession.hasMore === true;
			const loadingOlder = propLoadingOlder === true || hostSession.loadingOlder === true;
			const [loadingAll, setLoadingAll] = useState(false);

			/** 当前会话 face：sessions.binding 可能缺失/抛错，统一在这里收口成 undefined。 */
			const sessionBinding = (sid) => {
				if (sid === undefined || sessionsFace === undefined || sessionsFace === null
					|| typeof sessionsFace.binding !== "function") return undefined;
				try {
					return sessionsFace.binding(sid);
				} catch (_) {
					return undefined;
				}
			};
			const loadTarget = () => {
				if (hostSession.session !== null) return hostSession.session;
				const sid = propSessionId ?? hostSession.sessionId
					?? (currentId === "default-session" ? undefined : currentId);
				const binding = sessionBinding(sid);
				return binding && binding.session ? binding.session : null;
			};

			const onLoadOlder = useCallback(() => {
				const target = loadTarget();
				if (target === null || typeof target.loadOlder !== "function") return;
				try {
					const pending = target.loadOlder();
					if (pending !== null && pending !== undefined && typeof pending.catch === "function") {
						pending.catch((err) => console.warn("[conversation] loadOlder failed", err));
					}
				} catch (err) {
					console.warn("[conversation] loadOlder failed", err);
				}
			}, [hostSession.session, hostSession.sessionId, propSessionId, currentId, sessionsFace]);

			const onLoadAll = useCallback(async () => {
				const target = loadTarget();
				if (target === null || typeof target.loadOlder !== "function"
					|| typeof target.getSnapshot !== "function" || loadingAll) return;
				setLoadingAll(true);
				try {
					let count = 0;
					while (target.getSnapshot()?.hasMore === true && count < 100) {
						await target.loadOlder();
						count += 1;
					}
				} catch (err) {
					console.warn("[conversation] loadAll failed", err);
				} finally {
					setLoadingAll(false);
				}
			}, [hostSession.session, hostSession.sessionId, propSessionId, currentId, sessionsFace, loadingAll]);

			const [copied, setCopied] = useState(false);
			const copiedTimer = useRef(0);
			useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

			const [unlocatable, setUnlocatable] = useState(false);
			const unlocatableTimer = useRef(0);
			useEffect(() => () => window.clearTimeout(unlocatableTimer.current), []);

			// 每个会话一个大纲管理器（收藏按会话持久化，层级偏好全局）。
			stg("panel:before-manager");
			const manager = useMemo(() => {
				try {
					return new OutlineManager({
						expandLevel: loadExpandLevel(),
						bookmarks: loadBookmarks(currentId),
						onExpandLevelChange: saveExpandLevel,
						onBookmarksChange: (ids) => saveBookmarks(currentId, ids),
					});
				} catch (e) {
					console.warn("[conversation] outline manager init failed", e);
					return new OutlineManager({});
				}
			}, [currentId]);

			stg("panel:after-manager");
			// 兜底：槽位没给 hookNodes（或为空）时，按 boundSessionId 直接从 sessions face 取快照
			const currentSessionNodes = useMemo(() => {
				if (Array.isArray(hookNodes) && hookNodes.length > 0) return hookNodes;
				if (!boundSessionId) return EMPTY_NODES;
				try {
					const b = sessionsFace && typeof sessionsFace.binding === "function"
						? sessionsFace.binding(boundSessionId) : null;
					if (!b || !b.session || typeof b.session.getSnapshot !== "function") return EMPTY_NODES;
					const nodes = conversationNodesOf(b.session.getSnapshot());
					return Array.isArray(nodes) && nodes.length > 0 ? nodes : EMPTY_NODES;
				} catch (_) {
					return EMPTY_NODES;
				}
			}, [hookNodes, boundSessionId, sessionsFace]);
			stg("panel:after-sessionNodes");

			// 数据优先级：props 钉死 hook → 宿主服务 chat 快照 → props sessions 旧回退
			const activeNodes = (Array.isArray(hookNodes) && hookNodes.length > 0)
				? hookNodes
				: (hostSession.nodes.length > 0 ? hostSession.nodes : currentSessionNodes);
			const items = useMemo(() => {
				if (!activeNodes || activeNodes.length === 0) return [];
				try {
					return buildOutlineItems(activeNodes);
				} catch (e) {
					console.warn("[conversation] outline build failed; showing an empty panel", e);
					return [];
				}
			}, [activeNodes]);
			stg("panel:after-items");

			// 一次性诊断（每次页面加载最多各一条）：快照形状 + 宿主 DOM 契约。
			// 只在真实渲染路径上打，普通单测直接调纯函数不会触发。
			const diagnosticsReady = items.length > 0;
			useEffect(() => {
				if (observedSnapshot !== null && observedSnapshot !== undefined) {
					reportSnapshotShapeOnce(observedSnapshot, activeNodes.length);
				}
				if (diagnosticsReady === true) reportDomContractOnce(document);
			}, [observedSnapshot, diagnosticsReady]);

			if (items.length > 0 && manager.items.length === 0) {
				manager.setItems(items);
			}

			const [, bump] = useReducer((x) => x + 1, 0);
			useEffect(() => {
				if (manager !== null) {
					manager.setItems(items);
					bump();
				}
			}, [manager, items]);

			useEffect(() => {
				if (manager === null) return undefined;
				return manager.subscribe(bump);
			}, [manager]);

			const state = manager === null ? undefined : manager.getState();
			stg("panel:after-state");
			/* getState() 的字段由包内 OutlineManager 提供；这里按数组兜底，
			   避免某次返回不完整快照时整块面板被 "reading 'length'" 打崩。 */
			const tree = state !== undefined && Array.isArray(state.tree) ? state.tree : EMPTY_NODES;
			const visible = state !== undefined && Array.isArray(state.visible) ? state.visible : EMPTY_NODES;

			// 阅读位置跟随（捕获阶段监听会话根 + rAF 节流）。state 来自 OutlineManager
			// 的快照缓存，身份只在真实数据变更（notify）时变化：effect 只在数据/会话
			// 变化时重跑，hover 之类的本地重渲染不会进来，闭包里的 tree/visible 也
			// 因此与 state 保持一致。
			const activeIdRef = useRef(null);
			const listRef = useRef(null);
			const lastScrollTopRef = useRef(null);
			const [, bumpActive] = useReducer((x) => x + 1, 0);
			useEffect(() => {
				if (state === undefined) return undefined;
				const root = findChatRoot();
				if (root === null) return undefined;
				const flat = [];
				const collect = (nodes) => {
					for (const node of nodes) {
						flat.push(node);
						collect(node.children);
					}
				};
				collect(tree);
				const followActive = (id) => {
					const list = listRef.current;
					if (id === null || id === undefined || list === null) return;
					let row = null;
					try {
						row = list.querySelector('[data-hq-id="' + String(id).replace(/"/g, '\\"') + '"]');
					} catch (e) {
						return;
					}
					if (row instanceof HTMLElement) ensureElementInView(row, list);
				};
				let raf = 0;
				/* 阅读位置同步：从正文当前滚动位置算出「正在看哪一条」，需要时写库并让
				   面板跟随。effect 重跑时的立即调用只走这份，绝不碰预览 —— v1.5.4 曾把
				   清预览放在这条路径上，任何本地重渲染（hover 自己、搜索输入、透明度
				   拖动）都会在下一帧把刚出现的预览清掉（issue #4 重开的 ~45ms 回归）。 */
				const syncActive = () => {
					let id = null;
					try {
						id = resolveVisibleActiveId(computeActiveItemId(root, flat), tree, visible);
					} catch (e) { /* 阅读位置跟随是 best-effort */ }
					if (id !== activeIdRef.current) {
						activeIdRef.current = id;
						if (currentId !== undefined && id !== null) savePos(currentId, id);
						bumpActive();
						followActive(id);
					}
				};
				const onScroll = () => {
					if (raf !== 0) return;
					raf = window.requestAnimationFrame(() => {
						raf = 0;
						/* 正文真滚动了，浮层锚定的那一行已经不在鼠标下了，但浏览器不会为
						   「元素自己滑走」补发 mouseleave —— 不清掉就会留一块悬在旧位置的预览。
						   但「收到 scroll 事件」不等于「真滚动了」，必须比对 scrollTop：
						   窗口变化、其他代码触发的合成 scroll 都可能位置没动，此时不该清。 */
						try {
							const container = findChatScrollContainer(root);
							const top = container === null ? null : container.scrollTop;
							if (top !== null && lastScrollTopRef.current !== null
								&& top !== lastScrollTopRef.current) {
								setPreviewNode(null);
							}
							if (top !== null) lastScrollTopRef.current = top;
						} catch (e) { /* 滚动清预览是 best-effort，别打断阅读位置同步 */ }
						syncActive();
					});
				};
				// 阅读位置恢复：切回某个会话时，面板列表直接落在上次看到的那个节点上
				// （只动面板滚动，不牵动正文）。
				const savedPos = currentId === undefined ? null : loadPos(currentId);
				if (savedPos !== null && activeIdRef.current === null) {
					activeIdRef.current = savedPos;
					window.setTimeout(() => followActive(savedPos), 0);
				}
				// scrollTop 基线：effect 每次重跑（含换会话）都重读，保证第一条 scroll
				// 事件就有可比基准 —— 否则「hover 后的首个滚动」会漏清一次预览。
				try {
					const bootContainer = findChatScrollContainer(root);
					lastScrollTopRef.current = bootContainer === null ? null : bootContainer.scrollTop;
				} catch (e) { /* 基线读不到就靠下一条 scroll 事件自建 */ }
				root.addEventListener("scroll", onScroll, { capture: true, passive: true });
				syncActive();
				return () => {
					root.removeEventListener("scroll", onScroll, { capture: true });
					if (raf !== 0) window.cancelAnimationFrame(raf);
				};
			}, [state, currentId]);

			// 标题栏拖拽（4px 移动阈值：没有阈值时标题栏按钮的 pointerup 会误判成拖动）
			const panelRef = useRef(null);
			/* 拖拽期间挂在 window 上的监听必须能被外部收掉：触屏手势被浏览器接管时
			   只发 pointercancel、不发 pointerup，旧实现会把 pointermove 永久留在
			   window 上 —— 之后鼠标随便动一下，面板就跟着跑（而且每次取消再叠一份）。 */
			const dragCleanupRef = useRef(null);
			useEffect(() => () => {
				if (dragCleanupRef.current !== null) dragCleanupRef.current();
			}, []);
			const onDragStart = useCallback((e) => {
				if (e.button !== 0) return;
				const panel = panelRef.current;
				if (panel === null) return;
				const rect = panel.getBoundingClientRect();
				// 拖拽时是直接改内联样式的，取消 / 中断要还原成 React 上一轮写的那份
				const initial = { left: panel.style.left, top: panel.style.top, right: panel.style.right };
				const dx = e.clientX - rect.left;
				const dy = e.clientY - rect.top;
				const startX = e.clientX;
				const startY = e.clientY;
				let moved = false;
				const clampX = (x) => Math.max(0, Math.min(window.innerWidth - rect.width, x));
				const clampY = (y) => Math.max(0, Math.min(window.innerHeight - MIN_PANEL_VISIBLE_HEIGHT, y));
				function onMove(ev) {
					if (moved === false && Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
					moved = true;
					panel.style.left = clampX(ev.clientX - dx) + "px";
					panel.style.top = clampY(ev.clientY - dy) + "px";
					panel.style.right = "auto";
				}
				function cleanup() {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					window.removeEventListener("pointercancel", onCancel);
					dragCleanupRef.current = null;
				}
				function onUp(ev) {
					cleanup();
					if (moved === false) return;
					store.set({ left: clampX(ev.clientX - dx), top: clampY(ev.clientY - dy) });
				}
				/* 浏览器接管手势（触屏滚动、系统手势）：放弃这次拖拽，位置回滚到拖拽前，
				   不写 localStorage —— 半途的位置是用户的意外，不该被持久化。 */
				function onCancel() {
					cleanup();
					if (moved === false) return;
					panel.style.left = initial.left;
					panel.style.top = initial.top;
					panel.style.right = initial.right;
				}
				if (dragCleanupRef.current !== null) dragCleanupRef.current();
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
				window.addEventListener("pointercancel", onCancel);
				dragCleanupRef.current = cleanup;
			}, [store]);

			const onItemClick = (node) => {
				const root = findChatRoot();
				let ok = false;
				try {
					ok = root !== null && scrollToItem(root, node);
				} catch (e) {
					ok = false;
				}
				window.clearTimeout(unlocatableTimer.current);
				setUnlocatable(ok === false);
				if (ok === false) {
					unlocatableTimer.current = window.setTimeout(() => setUnlocatable(false), 2000);
				}
				if (manager !== null && node.collapsed === true) manager.revealNode(node.index);
			};

			const onCopy = () => {
				if (state === undefined) return;
				try {
					if (navigator.clipboard !== undefined && navigator.clipboard !== null) {
						navigator.clipboard.writeText(outlineToMarkdown(state.tree, t));
					}
				} catch (e) { /* 剪贴板不可用：静默 */ }
				window.clearTimeout(copiedTimer.current);
				setCopied(true);
				copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
			};

			/** 导出为 .md 文件（内容与"复制大纲"完全一致）。 */
			const onExport = () => {
				if (state === undefined) return;
				try {
					const blob = new Blob([outlineToMarkdown(state.tree, t)], { type: "text/markdown;charset=utf-8" });
					const url = window.URL.createObjectURL(blob);
					const link = document.createElement("a");
					link.href = url;
					link.download = EXPORT_FILE_NAME;
					document.body.appendChild(link);
					link.click();
					document.body.removeChild(link);
					window.setTimeout(() => window.URL.revokeObjectURL(url), 5000);
				} catch (e) {
					console.warn("[conversation] markdown export failed", e);
				}
			};

			/** 双击：跳到"本节末尾"（下一个同级或更高级节点）；已是最后一节则滚到底。 */
			const onJumpEnd = (node) => {
				const root = findChatRoot();
				if (root === null || state === undefined) return;
				try {
					const next = nextSectionItem(flattenTree(state.tree), node);
					if (next !== null && scrollToItem(root, next)) return;
					scrollChatToBottom(root);
				} catch (e) { /* 跳转失败不影响面板 */ }
			};

			/** 
			 * 面板内快捷键：
			 * - Alt+↑/↓ 或焦点在列表容器时裸↑↓：上一个/下一个节点（跳转定位）
			 * - Enter：执行跳转（同单击，预览模式下优先触发）
			 * - Esc：依次退出预览→清空搜索→收起面板
			 * 不注册全局监听，避免抢宿主按键。
			 */
			const onPanelKeyDown = (e) => {
				const isListFocused = document.activeElement === listRef.current || 
				                    (listRef.current && listRef.current.contains(document.activeElement));
				if (e.altKey === true && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
					if (state === undefined) return;
					const flat = flattenTree(tree);
					if (flat.length === 0) return;
					e.preventDefault();
					const current = activeIdRef.current;
					const index = current === null ? -1 : flat.findIndex((node) => node.id === current);
					const nextIndex = e.key === "ArrowDown"
						? Math.min(flat.length - 1, index + 1)
						: Math.max(0, index - 1);
					const target = flat[nextIndex];
					if (target !== undefined) onItemClick(target);
				} else if (isListFocused === true && (e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey !== true) {
					// 裸↑↓在行间移动高亮
					if (state === undefined) return;
					const flat = [];
					const collect = (nodes) => { for (const node of nodes) { flat.push(node); collect(node.children); } };
					collect(visible);
					if (flat.length === 0) return;
					e.preventDefault();
					const current = activeIdRef.current;
					const index = current === null ? -1 : flat.findIndex((node) => node.id === current);
					const nextIndex = e.key === "ArrowDown"
						? Math.min(flat.length - 1, index + 1)
						: Math.max(0, index - 1);
					const target = flat[nextIndex];
					if (target !== undefined) {
						activeIdRef.current = target.id;
						bumpActive();
						if (currentId !== undefined && target.id !== null) savePos(currentId, target.id);
						// 让目标行滚入视野
						const row = listRef.current?.querySelector(`[data-hq-id="${String(target.id).replace(/"/g, '\\"')}"]`);
						if (row instanceof HTMLElement) ensureElementInView(row, listRef.current);
					}
				} else if (e.key === "Enter" && previewNode !== null) {
					e.preventDefault();
					onItemClick(previewNode.node);
					setPreviewNode(null);
				} else if (e.key === "Escape") {
					e.preventDefault();
					if (previewNode !== null) {
						setPreviewNode(null);
					} else if (state?.searchQuery) {
						manager?.setSearchQuery("");
					} else if (chrome.pinned === true) {
						store.set({ pinned: false });
					}
				}
			};

			const queryCount = items.filter((item) => item.isUserQuery === true).length;

			// 侧边刻度条数据：每轮提问一根 tick，fill 长度按该轮正文量归一化。
			const ticks = tree.filter((node) => node.isUserQuery === true).map((node) => ({
				id: node.id,
				queryIndex: node.queryIndex,
				text: node.text,
				charCount: typeof node.charCount === "number" ? node.charCount : 0,
			}));
			const maxChars = ticks.reduce((max, tick) => (tick.charCount > max ? tick.charCount : max), 0);
			const activeTickId = state === undefined ? null : topLevelId(tree, activeIdRef.current);

			const [dockSide, setDockSide] = useState(() => loadDockSide());
			const onToggleDockSide = useCallback(() => {
				const next = dockSide === "left" ? "right" : "left";
				setDockSide(next);
				saveDockSide(next);
				store.set({ left: undefined, top: undefined });
			}, [dockSide, store]);

			const panelOpacity = normalizeOpacity(chrome.opacity);
			/* 同一帧只探测一次能力：既决定要不要渲染滑杆，也决定要不要写这两个变量。 */
			const alphaSupported = supportsBackgroundAlpha();
			/* 透明度只作用于背景色：面板底色用 color-mix 掺透明，文字保持不透明，
			   否则整块降 opacity 会连正文一起淡掉，反而更看不清。 */
			const panelStyle = panelSurfaceStyle(chrome, dockSide, alphaSupported);

			const allExpanded = state !== undefined && state.isAllExpanded === true;
			const bookmarkMode = state !== undefined && state.bookmarkMode === true;
			const searchScope = state === undefined ? "all" : state.searchScope;
			const viewLabel = chrome.view === "wide"
				? t("panel.viewFull")
				: (chrome.view === "full" ? t("panel.viewPanel") : t("panel.viewWide"));

			const viewIndex = Math.max(0, VIEW_ORDER.indexOf(chrome.view));

			// Preview state for hover tooltip.
			const [previewNode, setPreviewNode] = useState(null);
			stg("panel:before-tree");

			const listChildren = state === undefined || visible.length === 0
				? [h("div", { key: "empty", className: "dsh-conv-empty" },
					h("span", { className: "dsh-conv-emptyglyph" }, h(OutlineGlyph)),
					h("div", null, t("panel.empty")),
					h("div", { className: "dsh-conv-emptyhint" }, t("panel.emptyHint")),
					hasMore ? h("div", {
						className: "dsh-conv-empty-tip",
						onClick: onLoadOlder,
					}, "↳ " + t("history.loadOlder")) : null)]
				: visible.map((node) => h(OutlineRow, {
					key: node.id,
					node,
					active: node.id === activeIdRef.current,
					query: state.searchQuery,
					t,
					onClick: onItemClick,
					onJumpEnd,
					onToggle: (target) => { if (manager !== null) manager.toggleNode(target.index); },
					onBookmark: (target) => { if (manager !== null) manager.toggleBookmark(target.index); },
					previewSetter: setPreviewNode,
				}));

			return h("div", {
				ref: panelRef,
				className: chrome.view === "full" ? "dsh-conv-panel dsh-conv-panel-full" : "dsh-conv-panel",
				style: panelStyle,
				role: "complementary",
				"aria-label": t("panel.title"),
				tabIndex: -1,
				onKeyDown: onPanelKeyDown,
			},
				h("div", { className: "dsh-conv-header", onPointerDown: onDragStart },
					h("span", { className: "dsh-conv-headerglyph" }, h(OutlineGlyph)),
					h("span", { className: "dsh-conv-title" }, t("panel.title")),
					h("button", {
						type: "button",
						className: "dsh-conv-iconbtn",
						title: dockSide === "left" ? t("panel.dockRight") : t("panel.dockLeft"),
						"aria-label": dockSide === "left" ? t("panel.dockRight") : t("panel.dockLeft"),
						onPointerDown: (e) => e.stopPropagation(),
						onClick: onToggleDockSide,
					}, h(DockSideGlyph, { side: dockSide })),
					h("button", {
						type: "button",
						className: "dsh-conv-iconbtn",
						title: viewLabel,
						"aria-label": viewLabel,
						onPointerDown: (e) => e.stopPropagation(),
						onClick: () => {
							const nextView = VIEW_ORDER[(viewIndex + 1) % VIEW_ORDER.length];
							const prevSize = VIEW_SIZES[chrome.view] === undefined ? VIEW_SIZES.panel : VIEW_SIZES[chrome.view];
							const nextSize = VIEW_SIZES[nextView] === undefined ? VIEW_SIZES.panel : VIEW_SIZES[nextView];
							// 拖拽过的面板要把新宽度重新落位，否则宽度只朝右长、右缘顶出窗口。
							const nextLeft = resolveResizedLeft(
								chrome.left,
								prevSize.width,
								nextSize.width,
								typeof window.innerWidth === "number" ? window.innerWidth : 0,
							);
							store.set(nextLeft === null ? { view: nextView } : { view: nextView, left: nextLeft });
						},
					}, chrome.view === "full" ? h(FullGlyph) : h(WideGlyph)),
					h("a", {
						className: "dsh-conv-iconbtn",
						href: REPO_URL,
						target: "_blank",
						rel: "noopener noreferrer",
						title: t("panel.github"),
						"aria-label": t("panel.github"),
						onPointerDown: (e) => e.stopPropagation(),
					}, h(GitHubGlyph)),
					h("button", {
						type: "button",
						className: "dsh-conv-iconbtn",
						title: t("panel.collapse"),
						"aria-label": t("panel.collapse"),
						onClick: () => store.set({ pinned: false }),
					}, h(CloseGlyph))),
				hasMore ? h("div", { className: "dsh-conv-history-bar" },
					h("span", null, loadingOlder || loadingAll ? t("history.loading") : t("history.hasMore")),
					h("div", { className: "dsh-conv-history-btns" },
						h("button", {
							type: "button",
							className: "dsh-conv-histbtn",
							disabled: loadingOlder || loadingAll,
							onClick: onLoadOlder,
						}, t("history.loadOlder")),
						h("button", {
							type: "button",
							className: "dsh-conv-histbtn",
							disabled: loadingOlder || loadingAll,
							onClick: onLoadAll,
						}, t("history.loadAll")))) : null,
				h("div", { className: "dsh-conv-toolbar" },
					h("button", {
						type: "button",
						className: "dsh-conv-iconbtn",
						title: allExpanded ? t("action.collapseAll") : t("action.expandAll"),
						"aria-label": allExpanded ? t("action.collapseAll") : t("action.expandAll"),
						onClick: () => {
							if (manager === null) return;
							if (allExpanded) manager.collapseAll();
							else manager.expandAll();
						},
					}, allExpanded ? h(CollapseAllGlyph) : h(ExpandAllGlyph)),
					h("button", {
						type: "button",
						className: bookmarkMode ? "dsh-conv-iconbtn dsh-conv-iconbtn-active" : "dsh-conv-iconbtn",
						title: t("action.bookmarkMode"),
						"aria-label": t("action.bookmarkMode"),
						"aria-pressed": bookmarkMode,
						onClick: () => { if (manager !== null) manager.setBookmarkMode(bookmarkMode === false); },
					}, h(StarGlyph)),
					h("button", {
						type: "button",
						className: copied ? "dsh-conv-iconbtn dsh-conv-iconbtn-copied" : "dsh-conv-iconbtn",
						title: copied ? t("action.copied") : t("action.copy"),
						"aria-label": copied ? t("action.copied") : t("action.copy"),
						onClick: onCopy,
					}, copied ? h(CheckGlyph) : h(CopyGlyph)),
					h("button", {
						type: "button",
						className: "dsh-conv-iconbtn",
						title: t("action.export"),
						"aria-label": t("action.export"),
						onClick: onExport,
					}, h(ExportGlyph)),
					h("button", {
						type: "button",
						className: searchScope === "all"
							? "dsh-conv-scopebtn"
							: "dsh-conv-scopebtn dsh-conv-scopebtn-active",
						title: t("search.scopeTooltip", { scope: t("search.scope." + searchScope) }),
						"aria-label": t("search.scopeTooltip", { scope: t("search.scope." + searchScope) }),
						onClick: () => {
							if (manager === null) return;
							const index = Math.max(0, SEARCH_SCOPES.indexOf(searchScope));
							manager.setSearchScope(SEARCH_SCOPES[(index + 1) % SEARCH_SCOPES.length]);
						},
					}, t("search.scope." + searchScope)),
					h("div", { className: "dsh-conv-searchbox" },
						h("span", { className: "dsh-conv-searchicon" }, h(SearchGlyph)),
						h("input", {
							className: "dsh-conv-search",
							type: "search",
							placeholder: t("search.placeholder"),
							value: state === undefined ? "" : state.searchQuery,
							onChange: (e) => { if (manager !== null) manager.setSearchQuery(e.target.value); },
						}),
						state !== undefined && state.searchQuery !== ""
							? h("button", {
								type: "button",
								className: "dsh-conv-searchclear",
								title: t("search.clear"),
								"aria-label": t("search.clear"),
								onClick: () => { if (manager !== null) manager.setSearchQuery(""); },
							}, h(CloseGlyph))
							: null)),
				h(LevelSlider, {
					expandLevel: state === undefined ? 6 : state.expandLevel,
					levelCounts: state === undefined ? {} : state.levelCounts,
					onChange: (level) => { if (manager !== null) manager.setLevel(level); },
					t,
				}),
				alphaSupported
					? h(OpacityControl, {
						value: panelOpacity,
						onChange: (next) => store.set({ opacity: normalizeOpacity(next) }),
						t,
					})
					: null,
				h("div", { className: "dsh-conv-list", ref: listRef }, listChildren),
				h("div", { className: "dsh-conv-footer" },
					h("button", {
						type: "button",
						className: "dsh-conv-footbtn",
						onClick: () => {
							const root = findChatRoot();
							if (root !== null) scrollChatToTop(root);
						},
					}, h(ScrollTopGlyph), t("action.scrollTop")),
					h("button", {
						type: "button",
						className: "dsh-conv-footbtn",
						onClick: () => {
							const root = findChatRoot();
							if (root !== null) scrollChatToBottom(root);
						},
					}, h(ScrollBottomGlyph), t("action.scrollBottom"))),
				unlocatable ? h("div", { className: "dsh-conv-toast", role: "status" }, t("action.unlocatable")) : null,
				previewNode !== null
					? h("div", {
							className: "dsh-conv-preview",
							style: previewPlacement(
								previewNode.x,
								previewNode.y,
								currentViewport().width,
								currentViewport().height,
								previewNode.side,
							),
						},
						h("span", { className: "dsh-conv-preview-label" },
							previewNode.node.isUserQuery === true 
								? (typeof navigator !== "undefined" && navigator.language.startsWith("zh") ? "轮次" : "Turn") 
								: `Heading ${previewNode.node.level}`),
						h(PreviewLabelGlyph, { node: previewNode.node }))
					: null);
		}

// ==== 停用保留：右侧刻度条包装器 HistoryOutlineRailWrapper ====
// 失效原因：全文件没有任何槽位注册或 JSX 引用它（唯一的槽位注册是面板本身），
//           刻度条自 7a525af「remove duplicate rail」起不再挂载；面板收起态改为只用标题栏按钮。
// 保留原因：维护者决定留待刻度条功能重启时复用，只注释不删除，便于原地恢复。
// 恢复方式：去掉本段每行行首的注释符，并重新为它注册槽位。
// 停用日期：2026-11-03（v1.5.4 之后）。
		// /**
		 // * 独立侧边刻度条包装器：在未展开面板且 rail=true 时在右侧边缘显示刻度条。
		 // */
		// function HistoryOutlineRailWrapper(props) {
			// const safeProps = props === undefined || props === null ? {} : props;
			// const store = safeProps.store;
			// const t = useMemo(() => makeTranslate(safeProps.t), [safeProps.t]);
//
			// /* 同面板：hook 调用次数钉死，缺哪一路就用占位钩子，避免顺序漂移 */
			// const nodesSource = typeof safeProps.useChat === "function" ? safeProps.useChat
				// : (typeof safeProps.useSession === "function" ? safeProps.useSession : useNoNodes);
			// const nodes = nodesSource(conversationNodesOf) || EMPTY_NODES;
//
			// const items = useMemo(() => {
				// if (!nodes || nodes.length === 0) return [];
				// try {
					// return buildOutlineItems(nodes);
				// } catch (_) {
					// return [];
				// }
			// }, [nodes]);
//
			// const ticks = items.filter((item) => item.isUserQuery === true).map((item, idx) => ({
				// id: item.key ?? ("turn-" + idx),
				// queryIndex: item.userIndex,
				// text: item.text,
				// charCount: typeof item.charCount === "number" ? item.charCount : 0,
			// }));
			// const maxChars = ticks.reduce((max, tick) => (tick.charCount > max ? tick.charCount : max), 0);
//
			// return h(SessionRail, {
				// ticks,
				// maxChars,
				// activeTickId: null,
				// onJump: () => {
					// store.set({ pinned: true });
				// },
				// onOpen: () => store.set({ pinned: true }),
				// t,
			// });
		// }

		/**
		 * 首屏占位（pinned 且会话数据未就绪）：与面板同位置、同外壳，
		 * 但不挂载 HistoryOutlinePanelInner —— 刷新时数据到达前不进入面板的 hook/订阅路径。
		 */
		function HistoryOutlinePlaceholder(props) {
			const safeProps = props === undefined || props === null ? {} : props;
			const t = useMemo(() => makeTranslate(safeProps.t), [safeProps.t]);
			const side = safeProps.side === "left" ? "left" : "right";
			// 与真正面板共用同一套外壳样式：定位（拖拽位置 / 视图档位）与背景透明度都一致，
			// 否则就绪的一瞬间面板会从 100% 不透明跳到用户设定值。
			const style = panelSurfaceStyle(safeProps.chrome, side, supportsBackgroundAlpha());
			return h("div", {
				className: "dsh-conv-panel dsh-conv-panel-pending",
				style,
				role: "status",
				"aria-live": "polite",
				"aria-busy": "true",
				"aria-label": t("panel.title"),
			},
				h("div", { className: "dsh-conv-header" },
					h("span", { className: "dsh-conv-headerglyph" }, h(OutlineGlyph)),
					h("span", { className: "dsh-conv-title" }, t("panel.title"))),
				h("div", { className: "dsh-conv-pending-body" },
					h("span", { className: "dsh-conv-pending-dot" }),
					h("span", null, t("panel.pending"))));
		}

		/**
		 * 槽位标准组件：挂载在 conversation.session.header.actions 槽位。
		 * 1. 无论面板开闭，Header 工具栏中永远渲染一个稳固的「大纲」操作按钮，绝不会消失！
		 * 2. pinned === true 且会话数据就绪后，同级挂载悬浮大纲面板；
		 *    数据未就绪时先渲染占位（见 panelMountStateOf），就绪后再挂载。
		 * 3. 原第 3 条「pinned === false 且 rail === true 时，同级挂载右边缘刻度滑轨」已停用（2026-11-03）：
		 *    刻度条组件与右侧刻度条包装器都在本文件内注释保留（搜索「停用保留」），
		 *    面板收起态仍然只由标题栏按钮进入，不再有边缘刻度条。
		 */
		function HistoryOutlineSlot(props) {
			const safeProps = props === undefined || props === null ? {} : props;
			const rawStore = safeProps.store;
			const hasStore = rawStore !== undefined && rawStore !== null
				&& typeof rawStore.subscribe === "function" && typeof rawStore.getSnapshot === "function";
			/* hooks 必须在任何提前 return 之前跑完：这里给一个空 store 占位，
			   保证 store 迟到（第一次渲染还没注入）时 hook 数量也不变。 */
			const store = hasStore ? rawStore : EMPTY_STORE;
			const t = useMemo(() => makeTranslate(safeProps.t), [safeProps.t]);
			const chrome = useSyncExternalStoreSafe(store.subscribe, store.getSnapshot);
			const pinned = chrome.pinned === true;

			/* 宿主下发的 hook 工厂集合若发生变化，强制重挂载面板：
			   否则面板内 hook 顺序会漂移，useMemo 读到上一轮的错位槽位。 */
			const hookShape = [
				typeof safeProps.useChat,
				typeof safeProps.useSession,
				typeof safeProps.useSessions,
				typeof safeProps.sessionId,
			].join("|");

			// 首屏闸门用到的 hook 全部无条件调用（与宿主服务是否就绪无关）。
			const hostSession = useHostReadiness(safeProps.host);
			// 窗口尺寸变化时重算面板位置：拖拽坐标可能已被拉窄的视口甩到外面。
			useViewportTick();
			const [timedOut, setTimedOut] = useState(false);
			useEffect(() => {
				if (hostSession.available !== true || hostSession.ready === true || timedOut === true) return undefined;
				const timer = window.setTimeout(() => setTimedOut(true), PANEL_READY_TIMEOUT_MS);
				return () => window.clearTimeout(timer);
			}, [hostSession.available, hostSession.ready, timedOut]);
			const mountPanel = panelMountStateOf(hostSession, timedOut) === "mount";
			const dockSide = useMemo(() => loadDockSide(), []);
			/* 所有 hook 都必须在任何提前 return 之前执行：store 缺席→注入若发生在两次渲染之间，
			   提前 return 会让 hook 数量变化（Rules of Hooks 崩溃）。 */
			if (!hasStore) return null;

			return h(Fragment, null, [
				h("button", {
					key: "conv-header-btn",
					type: "button",
					className: pinned ? "dsh-conv-header-btn dsh-conv-header-btn-active" : "dsh-conv-header-btn",
					title: pinned ? t("panel.collapse") : t("panel.title"),
					"aria-label": t("panel.title"),
					"aria-pressed": pinned,
					onClick: () => store.set({ pinned: !pinned }),
				}, h(OutlineGlyph), h("span", { className: "dsh-conv-header-btn-text", style: { marginLeft: 4 } }, t("panel.title"))),

				pinned && !DIAG_NO_PANEL
					? (mountPanel
						? h(PanelBoundary, { key: hookShape },
							h(HistoryOutlinePanelInner, Object.assign({}, safeProps, { key: "conv-panel" })))
						: h(HistoryOutlinePlaceholder, { key: "conv-pending", t: safeProps.t, side: dockSide, chrome }))
					: null,
			]);
		}

		/**
		 * 判定宿主提供哪条槽位注册通道。三条通道都能把条目挂上去，区别在契约来源：
		 * - inject：宿主核心的公开契约（官方插件指南里的 `ctx.slots.inject(owner, cb)`）。
		 * - declaration：slots 包自己导出的声明生命周期事件 `subscribeDeclaration(key, fn)`。
		 * - register：两者都没有时，只能"注册失败就退避重试"。
		 * @param {object} slots ctx.slots
		 * @returns {"inject"|"declaration"|"register"}
		 */
		function resolveSlotChannel(slots) {
			if (slots === null || typeof slots !== "object") return "register";
			if (typeof slots.inject === "function") return "inject";
			if (typeof slots.subscribeDeclaration === "function") return "declaration";
			return "register";
		}

		/** 客户端插件所需服务：槽位注册表与会话 face。 */
		const inject = ["slots", "sessions"];

		/**
		 * Client plugin body.
		 * 挂载到 conversation.session.header.actions 会话级操作栏。
		 */
		function apply(ctx) {
			try {
				/* 只依赖 register：inject 或 subscribeDeclaration 任一存在就能工作，
				   两者都没有也还有退避重试，不该整块禁用面板。 */
				if (ctx.slots === null || typeof ctx.slots !== "object" || typeof ctx.slots.register !== "function") {
					console.warn("[conversation] slots.register missing; panel disabled");
					return;
				}
				const store = createChromeStore();
				// 宿主桥与 store 由插件自己合并，且放在最后：第三方 header 传给槽位的 props
				// （可能为空、可能是另一套形状）覆盖不掉这两个字段。
				const host = createHostBridge(ctx);
				const slotProps = (props) => Object.assign(
					{},
					props === undefined || props === null ? {} : props,
					{ store, host },
				);

				const SLOT = "conversation.session.header.actions";
				const entryOpts = { name: SLOT, id: "dsh-conversation", order: 100, label: "大纲" };
				const entryComp = (props) => h(HistoryOutlineSlot, slotProps(props));

				const slots = ctx.slots;
				const channel = resolveSlotChannel(slots);
				/* 声明 epoch：创建与塌缩各推进一次。用它分辨"我们的条目仍然在"与
				   "槽位塌了又重建"——同一个 id 重复注册会直接抛 already has an entry。 */
				const epochOf = typeof slots.declarationEpoch === "function"
					? () => {
						try {
							return slots.declarationEpoch(SLOT);
						} catch (e1) {
							return -1;
						}
					}
					: null;

				/* 槽位是延迟声明的：第一次 register 会报 "is not declared"，等父条目的
				   children 表落地后再注册即可，所以这里做幂等重试。 */
				let registered = false;
				let registeredEpoch = -1;
				let regTries = 0;
				let regTimer = null;
				const tryRegister = () => {
					if (registered) return;
					regTries += 1;
					try {
						slots.register(entryOpts, entryComp);
						registered = true;
						registeredEpoch = epochOf === null ? -1 : epochOf();
						if (regTimer) { clearTimeout(regTimer); regTimer = null; }
					} catch (e0) {
						const msg = e0 && e0.message ? e0.message : String(e0);
						if (regTries >= 12) {
							console.warn("[conversation] register failed after " + regTries + " tries: " + msg);
						} else {
							regTimer = setTimeout(tryRegister, 700);
						}
					}
				};

				/* 声明通知里重新置位：塌缩后我们的条目已被宿主丢弃，
				   只有再次 register 才能回到工具条上。 */
				const onDeclared = () => {
					const epoch = epochOf === null ? -1 : epochOf();
					if (registered && (epochOf === null || epoch === registeredEpoch)) return;
					registered = false;
					regTries = 0;
					tryRegister();
				};

				tryRegister();

				if (channel === "inject") {
					try {
						slots.inject(SLOT, () => {
							tryRegister();
							return () => {};
						});
					} catch (e4) {
						console.warn("[conversation] slot inject failed: " + (e4 && e4.message ? e4.message : e4));
					}
				} else if (channel === "declaration") {
					try {
						slots.subscribeDeclaration(SLOT, onDeclared);
					} catch (e5) {
						console.warn("[conversation] slot subscribeDeclaration failed: " + (e5 && e5.message ? e5.message : e5));
					}
				}
			} catch (err) {
				console.warn("[conversation] init failed; panel disabled: " + (err && err.message ? err.message : err));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.internals = Object.freeze({
			snapshotRows,
			textBlocks,
			userText,
			buildOutlineItems,
			conversationNodesOf,
			normalizeOpacity,
			panelSurfaceStyle,
			clampPlacementToViewport,
			previewPlacement,
			previewSideFor,
			resolveResizedLeft,
			resolveSlotChannel,
			HistoryOutlinePanelInner,
			HistoryOutlineSlot,
			HistoryOutlinePlaceholder,
			panelMountStateOf,
			probeDomContract,
			snapshotShapeOf,
			reportDomContractOnce,
			reportSnapshotShapeOnce,
			resetDiagnostics,
			readHostService,
			createHostBridge,
			mainSessionIdOf,
			snapshotSourceOf,
			safeNodesOf,
			makeSessionBindingSelector,
			OutlineManager,
		});
		return module.exports;
	}
});
