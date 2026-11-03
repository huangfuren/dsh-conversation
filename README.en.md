# dsh-conversation

English | [中文](./README.md)

A conversation outline panel for the DSH web surface: it turns the current session into a navigable tree — **user questions** are the root nodes (index, time, per-turn tool count and text volume), and the **Markdown headings of the assistant replies** hang under the question they belong to. Clicking any row jumps to the message and flashes it briefly. Pure UI: it never touches prompts, messages, tool results, and makes no provider requests.

> Project status: 1.x. Verified on **dsh 0.1.5-rc.2** with the `web` profile. Older dsh versions and other profiles are **not certified** — the plugin degrades to "panel absent" rather than throwing, but that path is not part of the tested matrix.

Version history: 1.1.0 merged the whole former `dsh-outline` plugin and renamed the package from `dsh-client-hqst`; 1.2.0 added the bulk of the navigation surface (three width tiers, side rail, search scope, export, section jump, keyboard shortcuts, reading-position memory).

## What it looks like

- **Pinned (default)** — a floating panel (`dsh-conv-panel`) titled "History · Outline".
  - **Three width tiers**: compact 320px → wide 480px → full 720px full-height, cycled from the title bar.
  - **Left/right docking**: the title-bar dock button switches between docking to the left and to the right, resetting to the default position.
  - The title bar doubles as the drag handle (4px threshold, position persisted).
  - Tool row: expand/collapse all, bookmarks-only, **copy outline** (Markdown to clipboard), **export as .md**, search box with highlighted hits.
  - **Search scope**: the button left of the search box cycles all / questions / headings.
  - Level slider: 0 = questions only, 1–6 = open down to that heading level; dot tooltips show per-level counts.
  - **Background opacity**: a slider at the bottom of the panel adjusts the **panel background** between 40% and 100% (default 100%, i.e. the old look). Only the background is dimmed — text stays fully opaque — and the **backdrop blur is derived from it in reverse**: the more transparent, the more the text behind shows through and the larger the blur radius (about 3.6px at 40%, 0 at 100%). That is by design, not a rendering fault. Click the percentage to go back to fully opaque, or double-click the slider. Useful when the panel covers the content you are reading.
  - Rows: collapse arrow, `Q1` badge, text, time, **this turn's "N tools / N chars" stats**, bookmark star; the row at the current reading position is softly highlighted and scrolled into view.
  - Footer: top / bottom.
- **Collapsed** — the only entry point is the "Outline" button in the session title bar (`order: 100`, next to
  the native buttons). Since 1.3.1 the former right-edge rail (`dsh-conv-rail`) and the corner capsule
  (`dsh-conv-fab`) are **disabled**: they duplicated the header button, and the rail overlapped plugins that
  ship their own navigation rail. Both components and their styles are still in the repo, just not mounted.
- **Jump granularity** — single click jumps to the node; **double click jumps to the end of that section** (next node at the same or higher level, or the very bottom).
- **Keyboard** — with the panel focused, `Alt+↓` / `Alt+↑` move to the next / previous node; the listener is scoped to the panel and never steals host shortcuts.
- **Reading position memory** — each session remembers the outline node you last looked at, and the panel lands there when you come back.
- **Empty state** — "No outline content yet" until the session has questions or headings.
- **First-paint placeholder** — after a reload, while the host's session / chat data is not ready yet, the panel position shows "Reading conversation…" and the panel mounts once the host session binding is ready (if the binding arrives before the chat snapshot, the panel may render the empty state once and fill in on the next snapshot update) (no more empty-state flash). If the host still has no session binding after 2 seconds, the panel mounts anyway and shows the empty state.
- **Adaptive header button (icon-only)** — when the right sidebar opens and the header narrows, the "Outline" button collapses to the bare icon via the **same mechanism as the native buttons**: the same container query (`@container (width<=540px)`) against the same `.wSkVaW_titleRow` container. The button really shrinks to icon width; `aria-label` / `title` stay, click and keyboard focus keep working; it restores when the space comes back. On older hosts without the container it degrades to the full-width button (safe).
- Persisted state: `pinned` / drag position / view tier / panel background opacity / default level / per-session bookmarks / per-session reading position — all in `localStorage` under the `dsh-conversation:` prefix. The rail-toggle field disabled in 1.3.1 is still read in, so old state migrates cleanly.

## How it works

| Half | File | Responsibility |
| --- | --- | --- |
| Node half | `index.js` | An empty `apply()` — it exists only so the plugin is visible to the host `cordis.yml` / Loader. No host-side behaviour. |
| Client half | `client.js` | The actual UI, discovered by the web host through `exports["./client"]` plus the `dsh.client` declaration in `package.json`. |

Client behaviour:

1. Takes two required services via `inject: ["slots", "sessions"]`; the panel is disabled (with a warning) only when `slots.register` itself is missing. `apply()` also captures the `sessions` / `uiSession` services into a plugin-private host bridge.
2. Registers `dsh-conversation` (`order: 100`) in the `conversation.session.header.actions` slot and merges `store` / `host` **last** into the slot props — empty owner props, or a third-party header passing a different shape, cannot override them. When the slot is declared late, registration goes through three channels (inject / declaration subscription / immediate + 700 ms backoff retry; see "Three-tier registration fallback").
3. Two data paths: the slot props `useChat` / `useSession` / `useSessions` injected by older hosts or third-party headers win when present; when they are absent the panel reads `uiSession.current` → `hooks.chat` (ChatSnapshot) and `hooks.session` (`hasMore` / `loadOlder`). Both paths normalise through `conversationNodesOf` and an `Array.isArray` guard; if neither yields data the panel renders its empty state. `sessions.binding(id)` is still used for the legacy fallback and `loadOlder`.
4. `buildOutlineItems` flattens the snapshot into outline items: user/steering → level 0 (counting that turn's tools and text volume); assistant text blocks become level 1–6 by ATX heading (`^#{1,6}\s+`, `#` inside fenced code blocks skipped); streaming `partial` headings appear live with a breathing animation; non-prose nodes (tool-call / context) are counted but never enter the outline.
5. `OutlineManager` owns level, search (with scope) and bookmark state, synced to `localStorage`; tree building, collapse restoration, visible-row flattening and reveal-on-locate are pure functions.
6. Click-to-locate tries the host's internal anchors `[data-chat-anchor-key]` → `[data-message-key]` → `[data-node-key]`, then falls back to matching `data-chat-flow-kind` order plus a text check; when nothing matches it says "this node cannot be located right now" rather than silently scrolling to the wrong place.
7. "End of section" is resolved by `nextSectionItem` walking the pre-order flat list for the next node at the same or higher level, falling back to scrolling to the bottom.
8. Export uses an in-memory Blob + `URL.createObjectURL` (no host request, nothing written to the workspace) and shares its content with "copy outline" (`outlineToMarkdown`).
9. All styling goes through `dsw-alias-*` / `dsw-shadow-*` theme tokens; no hard-coded colours.

## Compatibility

- **Both snapshot contracts**: the new `snapshot.nodes[]` + `snapshot.partial`, and the legacy `snapshot.chat.{order, nodes(Map)}` + `node.data.content`. A shape mismatch yields an empty list, never an exception.
- **Hardened slot data source**: the `conversation.session.header.actions` owner props can be empty (dsh 0.2.0-rc.2 renders the slot with `renderSlot(..., {})`), and a third-party header such as `dsh-better-sidebar` may pass a different shape entirely. The panel prefers hooks injected through slot props and falls back to `uiSession.current` → `hooks.chat` / `hooks.session`; when neither path has data it renders the empty state instead of taking down the slot.
- **Host API degradation**: the shapes of `slots` / `sessions` / `uiSession` and every store's `getSnapshot` / `subscribe` are probed layer by layer with exceptions swallowed; a rename or removal only degrades this panel to its empty state, it never takes down other plugins in the same slot.
- **One-shot compatibility diagnostics**: the first recognisable snapshot (including 0 rows) logs one `console.info` line with the actual structure (`legacy.nodes` / `nodes` / `chat.order` …) and row count; an unrecognised structure logs one `console.warn` naming the keys it saw. The first rendered outline probes the host DOM contract (`data-conversation-scroll` / `data-chat-flow-kind` / anchor attributes) and logs one `console.warn` when an attribute is missing or renamed, stating that exact-anchor jumps degraded to text-order matching. Both logs fire at most once per page load and change no fallback behaviour.
- **Three-tier registration fallback**: the slot may be declared after the plugin loads, and the first `slots.register` throws `slot "…" is not declared` (0.1.5-rc.2 / 0.2.0-rc.1 / 0.2.1-rc.5 all throw it). The channel is therefore chosen from what the host actually exposes: ① `slots.inject` present → use the host contract; ② otherwise `slots.subscribeDeclaration` → subscribe to declaration events and register, which also recovers after a slot collapses and is re-declared; ③ neither → try immediately plus 700ms backoff (up to 12 attempts). Losing `inject` no longer makes the whole panel disappear. Duplicate registration is gated by `declarationEpoch`, so the same id never triggers `already has an entry`.
- **Style capability probing**: background opacity relies on CSS `color-mix` (Chromium 111+). Where it is unsupported that row is not rendered and the panel stays fully opaque, instead of leaving a slider that does nothing.
- **Bilingual copy**: the plugin ships its own zh/en dictionary and falls back by `navigator.language`; if the host injects a usable `t` that wins.

## Design notes and provenance

The **feature choices** here were informed by publicly described functionality and interaction patterns of similar plugins in the DSH ecosystem (conversation outline / question navigation / minimap style). Capabilities of this kind — an outline tree, an edge rail, search, export, reading-position tracking — are generic interaction design and are not protected by copyright. **The code is an independent implementation in this repository; no third-party source was copied or adapted**, and there is no third-party runtime dependency (the only peer dependency is the host-provided `react`).

## Requirements

| Component | Supported baseline |
| --- | --- |
| Node.js | >= 22.19 |
| DSH | >= 0.1.5-rc.2 < 1.0.0 (slot name and `slots.inject` / `register` contract checked against 0.1.5-rc.2, 0.2.0-rc.1 and 0.2.1-rc.5; on-device verification: 0.2.1-rc.5 desktop) |
| react | ^18.2.0 (provided by the host) |
| Surface | `web` (`dsh.client.platform`) |
| Rendering engine | Chromium 111+ (only for "background opacity"; 0.2.1-rc.5 runs Electron 44.7.0 / Chromium 152) |

Anything outside this table is unverified.

## Installation

An immutable tag is preferred:

```sh
dsh plugin --profile web add github:huangfuren/dsh-conversation#v1.5.0
```

Tracking the development branch (need a commit that is not released yet? use this):

```sh
dsh plugin --profile web add github:huangfuren/dsh-conversation
```

Or point at a local checkout:

```sh
dsh plugin --profile web add file:/absolute/path/to/dsh-conversation
```

`package.json` declares `dsh.bundle.patch` (`./cordis.patch.yml`), so `dsh plugin add` wires the bundle
itself. If you prefer to insert it by hand in the profile's `cordis.patch.yml`, the equivalent is:

```yaml
- insert:
    - id: conversation
      name: dsh-conversation
```

The only peer dependency is `react ^18.2.0`, supplied by the host.

## Development

```sh
npm run check    # node --check on both entry points
npm test         # node --test
npm run verify   # check + test (bound to prepack, so a failing test cannot be packaged)
```

`client.js` is not an ES module: the dsh client module loader loads it as
`window.__ModuleLoader__.load({ id, factory })`, and the `require` inside `factory` can only resolve
host-provided external modules (this plugin uses `react` alone). Relative requires would not resolve in
the real loader, which is why the client stays a single self-contained file — the same choice
`dsh-grafana` makes (its `client.js` is ~67 KB). `test/client.test.js` therefore loads the module through
a minimal loader stub and asserts the pure helpers it exports as `internals`; `test/host-service.test.js`
drives the slot component registered by `apply()` and locks in two more contracts: with empty host slot
props the outline is built from the `uiSession` / `sessions` services, and missing services or hostile
props only degrade to the empty state. `test/diagnostics.test.js` locks in the DOM-contract probe matrix,
the snapshot-shape matrix, and the "at most one line per page load" rule for both diagnostics.

## Known limitations

- Click-to-locate depends on the host's DOM contract (`data-chat-anchor-key` / `data-message-key` / `data-node-key`
  or `data-chat-flow-kind`); if those attributes are renamed wholesale, new candidates must be added in
  `locateByKey` / `collectUserRows`. The plugin probes the contract once after the first rendered outline and logs
  a single `console.warn` when something is missing (see "One-shot compatibility diagnostics").
- The service path follows the host's "main view" binding (`uiSession.current`): the slot's owner props carry no
  `sessionId`, so on a subagent session header the panel still shows the main session's outline. A `sessionId`
  supplied through props, if the host ever adds one, takes precedence for bookmarks/reading position and the
  `loadOlder` target; the outline itself still follows the main-view binding.
- The panel is `fixed`-positioned, so it can overlap other top-right floating plugins — they have to offset
  their `top`.
- The "N tools / N chars" figures count tool nodes after that turn in the snapshot and the character count of
  assistant prose; if the host renames node kinds they degrade to not displayed (never throw).
- The export filename is fixed at `dsh-conversation-outline.md`; there is no naming option.

## Dependencies and license

- peerDependencies: `react ^18.2.0`
- license: MIT
