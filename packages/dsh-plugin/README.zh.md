# dsh-magic-context

Magic Context 的 DeepSeek Harness（DSH）社区移植。作为持久 DSH 插件
（Host / Agent / Client 三面 + profile bundle），加载共享的 Magic Context
SQLite（`harness='dsh'` 行隔离），注册 `ctx_*` 工具、`/ctx-*` 命令、知识注入、
historian/dreamer 调度、压缩策略与 Typert Remote 面。

> 社区移植，与官方 Magic Context 或 DeepSeek 无隶属关系。
> 上游：https://github.com/cortexkit/magic-context（MIT）

## 安装

在 DSH profile 的 `package.json` 中：

```json
{
  "dependencies": { "dsh-magic-context": "github:xiaohj233/dsh-magic-context#v0.1.0&path:/packages/dsh-plugin" },
  "dsh": { "profile": { "bundles": ["...", "dsh-magic-context"] } }
}
```

然后 `pnpm install` 并重启 dsh。依赖包（`dsh-magic-context-adapter`）自动解析。

## 初始化

```sh
dsh-magic-context setup   # 生成 magic-standard 薄 preset
dsh-magic-context doctor  # 验证安装
```

为新会话选择 `magic-standard` preset，然后重启 dsh。首次会话自动创建共享
SQLite（`~/.local/share/cortexkit/magic-context/context.db`）。

## 功能

- 知识模式：m0/m1 基线注入、auto-search、§N§ tags
- 上下文管理：transcript + surface CAS（outbox saga）、historian 分区、Magic 压缩策略
- 自动化：Dreamer 任务、/ctx-recomp /ctx-wrapup /ctx-session-upgrade、/ctx-embed、feedback 桥接
- Web：状态卡 + Remote 诊断

完整功能对照与约束见仓库 README。

## 卸载

移除依赖与 `bundles` 条目后重启 dsh。共享 SQLite 与 `dsh_*` 适配表**有意保留**
（跨 harness 数据）；不再需要时手动删除 `~/.dsh/.agent-presets/magic-standard/`。

## 兼容

- DSH `0.1.0-rc.6` exact-rc（升级前先跑契约门）
- Magic Context 0.36.1 共享 schema 基线

## 许可证

MIT。上游版权声明见 THIRD_PARTY_NOTICES.md。
