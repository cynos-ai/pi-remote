# pi-remote

在手机上管理开发项目与 pi coding agent 会话。

Android / iOS App 连接统一 Linux 环境中的后端，查看项目、继续会话、切换模型与思考等级、压缩上下文，并实时查看回复、工具调用和模型实际提供的 thinking。手机断网或锁屏后，后端继续执行，重新连接时补回记录。

**产品原则：整体保留同环境本地 pi TUI 的使用体验。** 原生工具、扩展、skills、模型、会话及交互默认可用；先适配和验证，真正出现问题后才按证据作局部调整，不提前增加整类功能限制。

**当前状态：设计与开发交接文档已建立，应用代码尚未实现。** 本仓库不是一个已经可以启动的 App；文档中的开发命令是后续阶段必须实现的接口。

## 第一版选择

| 部分 | 决策 |
| --- | --- |
| 移动端 | React Native + Expo + TypeScript，Android / iOS |
| 后端 | Node.js + TypeScript + Fastify，主进程管理 session worker |
| Agent | `@earendil-works/pi-coding-agent@0.85.1`，worker 内直接调用 SDK |
| 通信 | HTTPS 操作请求 + WebSocket 事件流 |
| 数据 | SQLite + pi 原生 JSONL 会话文件 |
| 部署 | 统一 Linux 环境，Docker Compose；非 root、持久状态卷、显式项目挂载 |
| 使用范围 | 自托管单 owner；保留用户归属，不提供公开多租户执行 |

## 从哪里开始

1. [产品与架构设计](docs/v1-design.md)：范围、运行模型、并发和恢复规则。
2. [协议约定](docs/protocol-v1.md)：HTTP、WebSocket、命令、事件与重连。
3. [数据设计](docs/data-model.md)及[参考 SQL](docs/schema-v1.sql)：数据归属、约束和事务。
4. [分步骤开发计划](docs/development-plan.md)：每阶段依赖、文件、实现任务、验证命令及通过标准。
5. [验收矩阵](docs/acceptance.md)：正常流程、故障、真实模型和双端设备验证。
6. [Linux / Docker 部署约定](docs/deployment.md)：工具链、卷、权限、配对、备份和恢复。
7. [开发进度](docs/progress.md)：实际完成情况及证据。
8. [独立评审与修订记录](docs/reviews/2026-09-12-design-review.md)：7 项发现、处置与后续验证。
9. [Bash 与 TUI 兼容要求](docs/bash-compatibility.md)：原生 Bash 能力、后台服务和逐项对照验收。
10. [整体 TUI 体验原则](docs/tui-experience.md)：全产品兼容基线、撤回的预先限制和对照验收。
11. [原生运行补充契约](docs/native-runtime-contract.md)：自主运行、无 Run 内容、输入恢复、双向标题及原生会话替换。
12. [按新宗旨的独立审核](docs/reviews/2026-09-12-tui-principle-review.md)：6 项发现、修订与复核证据。

交给其他 AI 开发时，让它先读取 [AGENTS.md](AGENTS.md)，然后从进度表中第一个未完成且前置条件满足的阶段开始。不要将文档、模拟事件或成功构建当作真实 agent 与手机链路已经验收。

本次文档仓库可以执行的检查：

```sh
python3 scripts/check_docs.py
```

这会检查文档链接与表格、阶段与验收的双向映射、两套兼容矩阵、参考 SQL，以及正常 / 异常、无 Run 内容与表单、自主运行和输入恢复的合成契约；不调用模型，也不代表应用实现通过测试。

## 第一版能力

- 项目及 Session 列表，新建、改名、归档和恢复会话。
- 文本对话、工具参数与输出、thinking、错误、重试与上下文压缩状态。
- 模型选择、思考等级选择、手动压缩、停止、steer 和 follow-up。
- 保留 pi 原生 Bash：管道、脚本、网络、安装依赖、长运行与后台服务；不增加命令过滤、逐条审批或默认超时。
- 手机端回答执行、初始化、配置与扩展回调中的确认、选择和输入请求。
- 命令幂等、事件持久化、断线重放、worker 崩溃后的明确中断状态。
- 异常后保留未完成输出及待处理后续项，仍可主动继续会话；默认保留已加载 Session 和正常后台服务。

Matrix、多机 runner、自动 worktree、工作流编排、系统推送和公开多租户托管属于后续产品扩展。原生 pi 能力按 SDK 清单适配，移动界面尚未完成的项目会明确记录，不据此永久禁用后端能力。

## License

[MIT](LICENSE) © 2026 cynos-ai contributors.
