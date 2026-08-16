# 功能特性

> dsh-magic-context 的功能 parity 表：OpenCode/Pi 的 Magic Context 能力在
> DSH 上的适配状态。DSH 适配遵循"注入而非改写"的架构约束：所有 Magic
> 变换通过注入消息与录制层管线承载，不修改 DSH 官方语义。

## 能力对照

| 能力 | DSH 适配 | 状态 |
|---|---|---|
| 预设激活 | `magic-standard` thin preset（stock standard + 禁 compaction-basic + 插 magic-compaction/magic-agent）；仅该预设会话激活 Magic 行为，其余预设零干预 | ✅ |
| ctx_search | 工具接线（无嵌入时纯词法 lane） | ✅ |
| ctx_memory / ctx_note | 记忆读写 / 笔记（含 smart note `surface_condition` 持久化） | ✅ |
| ctx_expand | raw 源 = transcript 映射（全日志恢复、tool 折叠、seq↔ordinal 可逆） | ✅ |
| ctx_reduce | §N§ drop 排队 + 记录型 TagTarget → surface CAS | ✅ |
| todowrite | Pi 六工具对齐；`last_todo_state` 持久化（共享 normalize 契约）+ HARD 物化轮合成重放 | ✅ |
| §N§ tags | 共享 tagger 全 fidelity（文本身份/指纹/token 计数由共享层承担）；首轮调用即打标 | ✅ |
| tag/drop 物化 | 协调器 surface CAS（三 CAS + outbox saga） | ✅ |
| reasoning 清理 / temporal markers | 水位重放 / 插入合并（5 分钟阈值） | ✅ |
| 官方压缩 | MagicCompactionEngine + summarize hook（compartment digest + mini-historian） | ✅ |
| historian 后台 | 压力/commit-cluster 触发 → fire-and-forget → 原子发布；发布后强制 m0 折叠渲染 `<session-history>`；chunk 预算随模型窗口推导；`historian.model` 独立路由 | ✅ |
| m0/m1 知识注入 | 两条独立合成消息（缓存分裂契约）；m1 占位恒发；首轮调用即注入 | ✅ |
| auto-search | 模糊回忆提示（门内 fire-and-forget，CAS 防双发） | ✅ |
| Dreamer 全部任务 | 12 任务（core scheduler/lease/gate/telemetry 复用） | ✅ |
| Sidekick /ctx-aug | 单轮直连 LLM + 记忆检索注入 | ✅ |
| Mural | 视觉门 + attachments.saveImage → m0 图像块 | ✅ |
| feedback | DSH 桥接（messageFeedback → dsh_feedback_signals） | ✅ |
| ctx_reduce nudge | Channel-1/2 双通道（共享决策 + 注入交付） | ✅ |
| heuristic cleanup | 共享 applyHeuristicCleanup 接入 mutation 管线 | ✅ |
| 配置面 | magic-context.jsonc 全键桥接进 agent 面（阈值/保护窗/记忆预算/压缩开关/dreamer 等） | ✅ |
| /ctx-status /ctx-flush | 状态 / flush（compaction-off 门一致） | ✅ |
| /ctx-dream /ctx-embed | seam 接线（定时器/状态/全部 outcome 映射） | ✅ |
| /ctx-recomp /ctx-wrapup /ctx-session-upgrade | DSH session client + Managed 上下文（同会话原地升级） | ✅ |
| Web 状态/设置 | client 注册 + Remote diagnostics 端点 | ✅ |
| 压缩-off 模式 | 知识层继续（`compaction.enabled=false` 时 compartments 不渲染、命令不可用） | ✅ |
| 跨 harness 记忆 | 共享 SQLite + `harness='dsh'` 行隔离 | ✅ |
| 升级维护 | 无写回 include + doctor 契约检查 | ✅ |

## 差异记录

- **Sidekick**：Pi 用子代理（含工具）；DSH 单轮直连 + 记忆检索注入
  （需工具路径由 worker 承担——maxDepth 0 + 工具 allowlist + 委托策略钉死）。
- **feedback**：核心零消费（研究确认）——DSH 自建桥接；retrospective 消费接
  DSH raw provider 后生效。
- **命令可见性**：DSH 的 `/ctx-*` 命令是模型可见用户消息（Pi 是模型不可见
  custom entry）；命令行为与输出一致。
- **nudge 交付形态**：DSH 通过注入独立消息交付（Pi 追加在工具结果尾部）；
  决策与提醒文本同源。
- **todowrite 工具描述**：DSH 平台无 promptSnippet 字段，使用准则并入
  description（模型可见内容一致）。
- **Web 渲染**：headless 环境无法驱动 Web UI；Remote 端点契约已测，
  真机渲染验证留待发布后。
- **Rust/subc**：显式阻止（不静默降级）。

## 验证状态

- dsh-plugin **194/194** 测试全绿（29 文件）+ adapter-api 14/14 +
  pi-plugin 762/762（Pi oracle 基线）+ typecheck 0 错误
- 隔离环境真实模型验证：首轮注入（m0/m1/§N§）、低上下文（8k 窗口）压缩
  触发与 `<session-history>` 渲染、跨对话记忆注入、Pi/DSH 共享库双向读写
  与 harness 隔离、非 magic 预设零干预
- 发布物（tgz）干净安装链路验证通过（setup/doctor/启动/行为一致）
- 兼容基线：DSH `0.1.0-rc.6`、Magic Context 0.36.1（共享 schema v77）
