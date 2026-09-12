# AI 开发交接规则

## 适用范围

本文件适用于整个仓库的后续开发。用户在当前会话中的明确要求优先。当前仓库为设计交付，不要声称 App 或后端已实现。

## 开始工作

按顺序读 README、docs/tui-experience.md、docs/v1-design.md、docs/protocol-v1.md、docs/native-runtime-contract.md、docs/data-model.md、docs/development-plan.md、docs/acceptance.md、docs/deployment.md、docs/progress.md。具体任务只需深入阅读相关章节，不重复做已经有证据支持的工作。

代码开发从进度表中第一个前置阶段通过但本阶段未通过的 Sxx 开始。先核对实际文件和历史证据，再实现；不要根据勾选状态推断代码存在。步骤通过后可继续下一阶段，不需要逐阶段请求用户确认。

## 固定约束

- V1 的执行目标是统一 Linux 环境，Docker Compose 为默认交付方式。移动端仍包含 Android 和 iOS；iOS 编译与设备验收需要 macOS / 云构建或已有安装包。
- 保持单主服务、按需 session worker、SQLite、pi JSONL 的边界。默认不增加 PG、Redis、Matrix、云 relay 或独立 runner。
- pi SDK 固定为 0.85.1；先通过 S02 验证再升级。只有 packages/agent-pi 可以导入 pi SDK 类型，公共协议不可泄漏其内部类型。
- 整体以同环境本地 pi TUI 为基线，原生工具、资源、扩展、模型、会话和交互默认保留。只有真实复现问题或用户配置才增加局部限制；不能因适配困难而默认关闭或自动取消。
- 无 Run 内容用 Operation；Run 的外部 Command 可空且可有多个因果 Run。原生会话替换、标题事件、合法 header-only 历史及异步 hook 均按 native-runtime-contract 接入，不能用原有表约束删掉这些能力。
- stop 先取回未消费 SDK 输入再 abort，完整草稿不自动重发；compact 单独对照原生队列路径。恢复先检查旧 target_run_id，活动输入型 prompt 不变成新 Run。
- 服务端先持久化再广播。不同 Session 默认可并行；同 Session 输入按原生 steer / follow-up 处理，控制命令不被长 prompt 或待答表单阻塞。容量、工作区串行和回收仅为按实际需求配置的选项。
- Bash 按 docs/bash-compatibility.md 与原生 pi TUI 对齐：保留默认执行器、命令 / 模型结果语义、无默认超时、后台命令及网络 / 开发工具。不加命令过滤、审批或路径沙箱；手机显示配额不得限制模型工具能力。
- 不把 `agent_end` 当作任务成功；不把 shell 副作用当成可以凭幂等键恰好执行一次；不在崩溃后盲目重发已分派但状态未知的命令。
- 空 Session 的 SDK 路径不代表文件已落盘；按持久状态初始化 / 校验，禁止对缺失或损坏的持久历史直接 open 以免静默重建。
- 异常终态封存 partial；只暂停已有的待执行后续项，不封锁新对话、配置或交互。未知命令及失效旧控制不自动重投；空队列不要求额外恢复。
- 模型、思考等级、压缩与扩展命令遵循 SDK 原生前置条件，不统一要求空闲。标准 UI 请求通过 operationId 支持初始化、配置和无 Run 的扩展回调，不自动取消。
- 归档是可恢复的列表元数据，不停止执行或拒绝会话控制。普通启动无需宿主清理证明，故障按实际情况处理，不强制所有项目整容器重启。
- 单 owner 的 shell 具有容器用户权限；代码目录校验不构成执行沙箱。不能通过 privileged、Docker socket 或挂载整个宿主机解决一般开发环境问题。

## 验证与记录

每个阶段必须实现 development-plan 中指定的 `pnpm verify:Sxx`，运行本阶段有意义的正常及异常验证，并更新 docs/progress.md。记录：提交、命令、环境、结果、证据路径、未覆盖项。仅文档修改执行 `python3 scripts/check_docs.py`。

没有模型凭据或真实设备时，继续能独立完成的工作，将对应 live / device 验收记录为 blocked 或 not_run。不得用 mock、skip 或“预计通过”替代真实验收，不得为了得到绿色结果削弱测试断言。付费模型测试按提供的测试配置和预算执行；不得读取、打印或提交无关凭据。

修改协议、状态机或 schema 时，同步设计、示例、迁移、测试和验收矩阵；在 docs/progress.md 记录决策。先修复矛盾，再继续依赖该契约的工作。

## 交付质量

不要向公共仓库提交 `.env`、pi auth.json、真实会话 JSONL、模型凭据、设备 token、SQLite 数据、私有项目代码或带敏感内容的日志。测试在临时项目目录执行。示例数据必须合成或清洗。

最终交接说明应区分：实现了什么、实际验证了什么、哪些仍未运行。应用尚未完成时，不把设计检查通过描述为端到端通过。
