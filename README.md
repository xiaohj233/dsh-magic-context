# Magic Context for DSH

<div align="center">

[English](./README.en.md) | **中文**

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.6-111827.svg)
![Magic Context](https://img.shields.io/badge/Magic%20Context-0.36.1-7C3AED.svg)
![Harness](https://img.shields.io/badge/harness-dsh-5391FE.svg)
![Community](https://img.shields.io/badge/community-port-0F766E.svg)
![Tests](https://img.shields.io/badge/tests-177%2F177-brightgreen.svg)
![License](https://img.shields.io/badge/license-MIT-brightgreen.svg)

**社区移植**：将 [Magic Context](https://github.com/cortexkit/magic-context) 移植到
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的独立社区项目。
与官方 DSH 及官方 Magic Context 均无隶属关系，能力对齐情况见
[功能特性](./docs/FEATURES.md)。

[E2E 环境](./e2e/README.md)

</div>

---

## 项目定位

一个把 Magic Context 移植到 DeepSeek Harness 的适配层：让 DSH 会话使用
Magic Context 的知识注入、上下文管理与记忆能力，并与 OpenCode/Pi 的
Magic Context **共享同一 SQLite 记忆库**（`harness='dsh'` 行隔离），
OpenCode/Pi 行为保持不变。

适合这些场景：

- 在 DSH 中复用已有的 Magic Context 记忆（与 OpenCode/Pi 共享）。
- 希望 DSH 会话获得 m0/m1 知识注入、§N§ 标签、historian 压缩、
  Dreamer 定时任务等能力。
- 想要 /ctx-* 工具族（search/memory/note/expand/reduce/embed/recomp/wrapup）的 DSH 用户。

## 安装

在 DSH profile 的 `package.json` 中：

```json
{
  "dependencies": { "dsh-magic-context": "github:xiao_hj909/dsh-magic-context#v0.1.0&path:/packages/dsh-plugin" },
  "dsh": { "profile": { "bundles": ["...", "dsh-magic-context"] } }
}
```

然后 `pnpm install`（或 `dsh plugin --profile <name> install`）并重启 dsh。

> 依赖包（`dsh-magic-context-adapter`）由主包的 `github:` 依赖自动解析，无需单独安装。

### 快速开始

```sh
# 1. 生成薄 preset + 验证
dsh-magic-context setup
dsh-magic-context doctor

# 2. 让新会话使用 magic-standard preset
#    Web UI: Settings → Agent preset → magic-standard
#    或 settings.yaml: agent-presets.default: magic-standard

# 3. 重启 dsh
```

首次会话自动创建共享 SQLite（`~/.local/share/cortexkit/magic-context/context.db`）。

## 功能一览

- **知识模式**：m0/m1 baseline 注入（含 Mural 图像）、auto-search、§N§ tags
- **上下文管理**：DshTranscript + SurfaceMutationCoordinator（CAS + outbox saga）、
  historian 后台 compartment、Magic 压缩策略、缓存分类 SOFT+/SOFT/HARD
- **自动化**：Dreamer 全部任务、Sidekick /ctx-aug、/ctx-recomp /ctx-wrapup
  /ctx-session-upgrade、/ctx-embed、feedback 桥接
- **维护**：setup/doctor、升级契约门、无写回安全（shipped preset 只读挂载）
- **Web**：状态卡 + Remote 诊断端点

完整对照见 [docs/FEATURES.md](./docs/FEATURES.md)。

## 验证状态

- **177/177 测试全绿**（dsh-plugin）+ adapter-api 14/14 + typecheck 0 错误
- **已在隔离的非全局 DSH 验证安装**：npm 安装 → setup（薄 preset）→ doctor 6/6 →
  薄 preset 挂载 → 知识注入（m0/§N§ tags）→ **真实模型链路**（本地中转
  deepseek-v4-flash 响应 Magic 注入的上下文）→ 共享 SQLite `harness='dsh'` 行写入
- OpenCode/Pi 零改动（共享 DB 兼容）

## 约束与边界

- 不修改 DSH 源码；不拦截/改写 `llm/stream messages[]`；OpenCode/Pi 行为不变。
- 兼容基线：DSH `0.1.0-rc.6`（升级先跑契约门）。
- 已知边界见 [docs/FEATURES.md](./docs/FEATURES.md)（差异记录）。

## 许可证

MIT（与 Magic Context、DSH 一致）。上游版权声明见各包 `NOTICE`。
