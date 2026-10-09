# Contributing

## 前置：跑通校验

```sh
npm run verify      # node --check 两个入口 + node --test
```

`prepack` 绑定 `verify`，所以**测试不过就打不出包**，这条门禁无法绕过。

## 目录约定

对齐 [PLUGIN-STYLE-GUIDE](../PLUGIN-STYLE-GUIDE.md)：

```
index.js            宿主入口（保持薄，只做装配）
client.js           客户端入口 —— dsh 加载器格式的单文件模块
test/<模块>.test.js 与实现对应
cordis.patch.yml    dsh bundle 声明
```

关于 `client.js` 为什么是单文件：客户端由 dsh 客户端模块加载器按
`window.__ModuleLoader__.load({ id, factory })` 加载，`factory(require)` 里的 `require`
**只能解析宿主提供的外部模块**（本插件只用到 `react`），相对路径依赖在真实加载器里解析不了。
因此客户端是自包含单文件，这一点与 `dsh-grafana`（其 `client.js` 约 67 KB）一致；
需要按职责切分的纯逻辑请放到能独立测试的位置，而不是在客户端里做相对拆分。

## 提交规范

```
<type>(<scope>): <简述>

<正文：为什么改 / 改了什么 / 影响范围>
```

- `type` 枚举：`feat` `fix` `chore` `refactor` `docs` `test` `release`
- `scope` 用模块名：`(panel)` `(outline)` `(locate)` `(i18n)` `(deps)`
- **release 独立成提交**（`release: v1.2.1`），不与代码改动混提
- 一个提交一件事；描述不清就补正文，不要塞进标题

## 用户可见行为变化 → 双语文档同步

任何用户可见的行为变化，必须同时更新 `README.md`（中文）与 `README.en.md`（英文），并在 `CHANGELOG.md`
里写清**之前的行为 vs 现在的行为**（只写结论不算）。这是 PR 的准入条件，不是可选项。

## 测试要求

- 只用 Node 内置 `node --test`，不引第三方测试框架。
- 客户端是加载器格式模块，测试方式见 `test/client.test.js`：搭最小加载器桩 +
  `react` 桩把模块 load 进来，再断言它导出的 `exports.internals` 纯函数。
- 缺陷修复必须留回归测试：先让测试复现旧行为，再改代码让它通过。

## 不要提交

- 任何凭证、token、真实内网地址；
- `node_modules/`、`*.tgz`、编辑器与系统垃圾文件（见 `.gitignore`）。
