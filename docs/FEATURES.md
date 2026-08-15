# 功能特性

> dsh-magic-context 的功能 parity 表：OpenCode/Pi 的 Magic Context 能力在
> DSH 上的适配状态。全部闭环；差异见文末。

## 能力对照

| 能力 | DSH 适配 | 状态 |
|---|---|---|
| ctx_search | 工具接线（无嵌入时纯词法 lane） | ✅ |
| ctx_memory / ctx_note | 记忆读写 / 笔记 | ✅ |
| ctx_expand | raw 源 = transcript 映射（全日志恢复、tool 折叠、seq↔ordinal 可逆） | ✅ |
| ctx_reduce | §N§ drop 排队 + 记录型 TagTarget → surface CAS | ✅ |
| §N§ tags | 共享 tagger 全 fidelity（文本身份/指纹/token 计数由共享层承担） | ✅ |
| tag/drop 物化 | 协调器 surface CAS（三 CAS + outbox saga） | ✅ |
| reasoning 清理 / temporal markers | 水位重放 / 插入合并 | ✅ |
| 官方压缩 | MagicCompactionEngine + summarize hook（compartment digest + mini-historian） | ✅ |
| historian 后台 | 原子发布 + 全量触发（contextPressure → 阈值 → fire-and-forget） | ✅ |
| m0/m1 知识注入 | 知识门（含 Mural 图像块注入） | ✅ |
| auto-search | 模糊回忆提示 | ✅ |
| Dreamer 全部任务 | 12 任务（core scheduler/lease/gate/telemetry 复用） | ✅ |
| Sidekick /ctx-aug | 单轮直连 LLM + 记忆检索注入 | ✅ |
| Mural | 视觉门 + attachments.saveImage → m0 图像块 | ✅ |
| feedback | DSH 桥接（messageFeedback → dsh_feedback_signals） | ✅ |
| /ctx-status /ctx-flush | 状态 / flush | ✅ |
| /ctx-dream /ctx-embed | seam 接线（定时器/状态/全部 outcome 映射） | ✅ |
| /ctx-recomp /ctx-wrapup /ctx-session-upgrade | DSH session client + Managed 上下文（同会话原地升级） | ✅ |
| Web 状态/设置 | client 注册 + Remote diagnostics 端点 | ✅ |
| 压缩-off 模式 | 知识层继续 | ✅ |
| 跨 harness 记忆 | 共享 SQLite + `harness='dsh'` 行隔离 | ✅ |
| 升级维护 | 无写回 include + doctor 契约检查 | ✅ |

## 差异记录

- **Sidekick**：Pi 用子代理（含工具）；DSH 单轮直连 + 记忆检索注入
  （需工具路径由 worker 承担——maxDepth 0 + 工具 allowlist + 委托策略钉死）。
- **feedback**：核心零消费（研究确认）——DSH 自建桥接；retrospective 消费接
  DSH raw provider 后生效。
- **Web 渲染**：headless E2E 环境无法驱动 Web UI；Remote 端点契约已测，
  真机渲染验证留待发布后。
- **Rust/subc**：显式阻止（不静默降级）；上游 seam 提案存于本地开发文档。

## 验证状态

- dsh-plugin **177/177** 测试全绿（26 文件）+ adapter-api 14/14 + typecheck 0 错误
- 真实 DSH 挂载 E2E 通过（scratch 隔离环境 + 真实安装链路含真实模型）
- OpenCode/Pi 零改动（共享 DB 兼容）
- 兼容基线：DSH `0.1.0-rc.6`、Magic Context 0.36.1（共享 schema）
