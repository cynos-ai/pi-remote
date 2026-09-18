# pi SDK 验证记录

状态：S02 的无模型 contract smoke 已通过；真实 provider、thinking、原生 TUI 和完整 live 对照仍未运行。本文只记录实际观察，不把 SDK 源码或合成 fixture 当作 live 证据。

## 环境与命令

2026-09-12 在 WSL Linux 环境运行：Node `v24.19.0`、pnpm `10.28.0`、固定 SDK `@earendil-works/pi-coding-agent@0.85.1`。测试均使用临时项目目录；没有读取或保存模型凭据、auth 文件或会话内容。

已运行的 contract 验证入口：

```text
pnpm run verify:S02
pnpm run test:bash-parity -- --target sdk
pnpm run test:tui-parity -- --target sdk
```

## 已通过的 S02 contract 场景

| 场景 | 结果 | 观察范围 |
| --- | --- | --- |
| S02-01 | passed | 空配置 Session 的 unflushed 生命周期、preflight 与 settle 边界 |
| S02-02 | passed | SDK 原生 Bash 结果边界、正常返回与执行器输出 |
| S02-03 | passed | missing / empty / persisted / invalid / identity mismatch 的 JSONL 策略，合法 header-only 与非 assistant 历史可认领 |
| S02-04 | passed | 原生资源加载、extension 表单与异步交互 hook 的边界 |
| S02-05 | passed | AgentSessionRuntime 替换、factory 与 rebind 顺序 |
| Bash B01 smoke | passed | SDK 执行器与同环境 `/bin/bash` 的管道、重定向和复合命令确定性对照 |

## 尚未运行

- `pnpm test:live -- --suite sdk`：需要运营者在仓库外提供至少两个真实模型，其中一个能够返回 thinking。
- 真实 provider 的重试、自动压缩、工具调用、错误修复和最终 settle。
- 原生 pi TUI 的实际 smoke 及 B02–B08 / T01–T08 的完整对照。
- 真实长 Bash、后台服务跨 Run 行为和 worker SIGKILL 故障窗口。

因此 S02 状态仍为 `blocked`，不能把 contract smoke 或确定性 Bash 对照升级为完整 AT02、AT03、AT26、AT31、AT32 通过。

详细机器报告默认位于 `test-results/s02/report.json` 和 `test-results/parity-bash-sdk/report.json`，不提交运行数据。

