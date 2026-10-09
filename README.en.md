# dsh-conversation

English | [中文](./README.md)

A conversation outline panel for the DSH web surface: it turns the current session into a navigable tree — **user questions** are the root nodes (index, time, per-turn tool count and text volume), and the **Markdown headings of the assistant replies** hang under the question they belong to. Clicking any row jumps to the message and flashes it briefly. Pure UI: it never touches prompts, messages, tool results, and makes no provider requests.

> Project status: 1.x. Verified on **dsh 0.1.5-rc.2** with the `web` profile. Older dsh versions and other profiles are **not certified** — the plugin degrades to "panel absent" rather than throwing, but that path is not part of the tested matrix.

Version history: 1.1.0 merged the whole former `dsh-outline` plugin and renamed the package from `dsh-client-hqst`; 1.2.0 added the bulk of the navigation surface (three width tiers, side rail, search scope, export, section jump, keyboard shortcuts, reading-position memory).

## What it looks like

- **Pinned (default)** — a floating panel (`dsh-conv-panel`) titled "History · Outline".
  - **Three width tiers**: compact 320px → wide 480px → full 720px full-height, cycled from the title bar.
  - The title bar doubles as the drag handle (4px threshold, position persisted).
  - Tool row: expand/collapse all, bookmarks-only, **copy outline** (Markdown to clipboard), **export as .md**, search box with highlighted hits.
  - **Search scope**: the button left of the search box cycles all / questions / headings.
  - Level slider: 0 = questions only, 1–6 = open down to that heading level; dot tooltips show per-level counts.
  - Rows: collapse arrow, `Q1` badge, text, time, **this turn's "N tools / N chars" stats**, bookmark star; the row at the current reading position is softly highlighted and scrolled into view.
  - Footer: top / bottom, plus the **side-rail toggle**.
- **Collapsed** — defaults to the **right-edge rail** (`dsh-conv-rail`): one tick per question, length normalised by that turn's text volume (effectively a conversation density map); hover shows a summary, click jumps to the turn, the icon at the top re-opens the panel. Turning the rail off falls back to the corner capsule (`dsh-conv-fab`) "History · Outline (N)".
- **Jump granularity** — single click jumps to the node; **double click jumps to the end of that section** (next node at the same or higher level, or the very bottom).
- **Keyboard** — with the panel focused, `Alt+↓` / `Alt+↑` move to the next / previous node; the listener is scoped to the panel and never steals host shortcuts.
- **Reading position memory** — each session remembers the outline node you last looked at, and the panel lands there when you come back.
- **Empty state** — "No outline content yet" until the session has questions or headings.
- Persisted state: `pinned` / drag position / view tier / rail toggle / default level / per-session bookmarks / per-session reading position — all in `localStorage` under the `dsh-conversation:` prefix.

## How it works

| Half | File | Responsibility |
| --- | --- | --- |
| Node half | `index.js` | An empty `apply()` — it exists only so the plugin is visible to the host `cordis.yml` / Loader. No host-side behaviour. |
| Client half | `client.js` | The actual UI, discovered by the web host through `exports["./client"]` plus the `dsh.client` declaration in `package.json`. |

Client behaviour:

1. Takes two required services via `inject: ["slots", "sessions"]`; if either is missing it warns and disables the panel.
2. Registers `question-history` (`order: 100`) in the `shell.overlay` slot, passing `store` / `sessions` down instead of relying on face injection.
3. `sessions.binding(id)` obtains the current session face and subscribes to `getSnapshot()` via `useSyncExternalStore`.
4. `buildOutlineItems` flattens the snapshot into outline items: user/steering → level 0 (counting that turn's tools and text volume); assistant text blocks become level 1–6 by ATX heading (`^#{1,6}\s+`, `#` inside fenced code blocks skipped); streaming `partial` headings appear live with a breathing animation; non-prose nodes (tool-call / context) are counted but never enter the outline.
5. `OutlineManager` owns level, search (with scope) and bookmark state, synced to `localStorage`; tree building, collapse restoration, visible-row flattening and reveal-on-locate are pure functions.
6. Click-to-locate tries the host's internal anchors `[data-chat-anchor-key]` → `[data-message-key]` → `[data-node-key]`, then falls back to matching `data-chat-flow-kind` order plus a text check; when nothing matches it says "this node cannot be located right now" rather than silently scrolling to the wrong place.
7. "End of section" is resolved by `nextSectionItem` walking the pre-order flat list for the next node at the same or higher level, falling back to scrolling to the bottom.
8. Export uses an in-memory Blob + `URL.createObjectURL` (no host request, nothing written to the workspace) and shares its content with "copy outline" (`outlineToMarkdown`).
9. All styling goes through `dsw-alias-*` / `dsw-shadow-*` theme tokens; no hard-coded colours.

## Compatibility

- **Both snapshot contracts**: the new `snapshot.nodes[]` + `snapshot.partial`, and the legacy `snapshot.chat.{order, nodes(Map)}` + `node.data.content`. A shape mismatch yields an empty list, never an exception.
- **Host API degradation**: the shapes of `slots` / `sessions` and the face's `getSnapshot` / `subscribe` are probed layer by layer; a rename or removal only makes this panel disappear, it never takes down other plugins in the same slot.
- **Bilingual copy**: the plugin ships its own zh/en dictionary and falls back by `navigator.language`; if the host injects a usable `t` that wins.

## Design notes and provenance

The **feature choices** here were informed by publicly described functionality and interaction patterns of similar plugins in the DSH ecosystem (conversation outline / question navigation / minimap style). Capabilities of this kind — an outline tree, an edge rail, search, export, reading-position tracking — are generic interaction design and are not protected by copyright. **The code is an independent implementation in this repository; no third-party source was copied or adapted**, and there is no third-party runtime dependency (the only peer dependency is the host-provided `react`).

## Requirements

| Component | Supported baseline |
| --- | --- |
| Node.js | >= 22.19 |
| DSH | >= 0.1.5-rc.2 < 1.0.0 (certified on 0.1.5-rc.2) |
| react | ^18.2.0 (provided by the host) |
| Surface | `web` (`dsh.client.platform`) |

Anything outside this table is unverified.

## Installation

An immutable tag is preferred:

```sh
dsh plugin --profile web add github:huangfuren/dsh-conversation#v1.3.0
```

Tracking the development branch (no tag published yet? use this):

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
a minimal loader stub and asserts the pure helpers it exports as `internals`.

## Known limitations

- Click-to-locate depends on the host's DOM contract (`data-chat-anchor-key` or `data-chat-flow-kind`);
  if those attributes are renamed wholesale, new candidates must be added in `locateByKey` / `collectUserRows`.
- The panel is `fixed`-positioned, so it can overlap other top-right floating plugins — they have to offset
  their `top`. The rail hugs the right edge centred, so it will visually collide with a similar navigation
  plugin if both are enabled.
- The "N tools / N chars" figures count tool nodes after that turn in the snapshot and the character count of
  assistant prose; if the host renames node kinds they degrade to not displayed (never throw).
- The export filename is fixed at `dsh-conversation-outline.md`; there is no naming option.

## Dependencies and license

- peerDependencies: `react ^18.2.0`
- license: MIT
