# 按整体 TUI 宗旨的独立审核

日期：2026-09-12。审核基线：[cf02e916a148b8125144f6408ccbd81d58b71a8d](https://github.com/cynos-ai/pi-remote/commit/cf02e916a148b8125144f6408ccbd81d58b71a8d)。该基线的[文档 CI](https://github.com/cynos-ai/pi-remote/actions/runs/34692163097)已通过；不代表以下修订或 SDK 运行已验收。

用户要求按新宗旨再独立审核：整体保留同环境 pi TUI 的原生能力，只在实际问题或用户配置要求下增加局部限制。本次使用新的独立代理 `tui_principle_review`，不继承旧审核上下文，以只读方式检查仓库并对照固定 SDK 0.85.1 源码。代理未参与初稿或本轮文件修改；主代理根据发现修订，再交回同一审核代理复查实际差异。

## 首次发现与处置

| ID | 等级 | 原方案问题与原生依据 | 本轮修订 | 后续实际验证 |
| --- | --- | --- | --- | --- |
| N1 | P1 | 内容 / timeline 强制属于 Run，无法承载 triggerTurn=false 的 custom 消息及用户直接 Bash；保留表单的 null Run 尚不够 | 内容必有 Operation、Run 可空；custom / bash 角色保留原生元数据；独立封存、延迟交付及恢复 | S02 / S03 / S04 / S07 / S10，AT06 / AT07 / AT32 |
| N2 | P1 | runs.command_id 非空且唯一，拒绝无手机请求的自主扩展 Run，也拒绝一条扩展命令先 compact 再 prompt | Run 有唯一 operationId、source 和可空非唯一因果 commandId；GET command 返回完整 runs；允许同 owner 跨 Session 来源，定向执行仍绑定目标 | S02 / S04 / S06 / S07，AT07 / AT12 / AT32 |
| N3 | P1 | 只调用 SDK abort 未复用 TUI clearQueue / 恢复编辑器输入，旧输入可能继续执行 | SDK 输入按 ID / 完整内容持久化；stop / ctx.abort 清取未消费输入后 abort，草稿不自动重发，不明窗口保留 unknown；compact 单独对照原生队列时序 | S02 / S07 / S10，AT05 / AT14 / AT15 / AT32 |
| N4 | P2 | 恢复仅看命令 kind，把带旧 target_run_id 的活动 prompt 保留成独立后续任务 | 先检查目标绑定；旧目标 prompt 在 IPC 前 crash 时取消 stale_runtime，不创建 queued Run / 队列成员 | S06 / S11，AT19 |
| N5 | P2 | 标题仅由应用单向覆盖 pi，扩展 setSessionName 的 session_info_changed 不能正确同步 | 双向确认标题、版本、来源与回声水位；恢复未同步手机意图或校准原生有效标题，覆盖并发和 A→B→A | S02 / S04 / S07，AT07 / AT11 / AT32 |
| N6 | P2 | 以至少一条 assistant 作为 persisted 必要条件，拒绝原生可打开 / fork / import 的合法空历史 | 有效 header / 身份 / entry 关系决定有效性；header-only / 非 assistant 历史可恢复。零字节、真实损坏和身份不符仍保留原文件 | S02 / S06 / S07，AT02 / AT19 / AT32 |

没有以增加命令过滤、关闭扩展、强制空闲或整项目冻结处理上述问题。[原生运行契约](../native-runtime-contract.md)给出完整语义，已同步[协议](../protocol-v1.md)、[数据模型](../data-model.md)、[参考 SQL](../schema-v1.sql)、[步骤](../development-plan.md)、[验收矩阵](../acceptance.md)与合成示例。

## 修复方案复核补充

独立代理在文件修改前复核了修复思路，提出三处必须接上的边界，本轮一并处理：

1. 原生 new / fork / switch 后，来源 Command 可在 S1，而后续 withSession Run 在 S2。因果 Command 采用同 owner 事务检查；Run、事件和回答仍留在实际执行 Session。
2. fork / import 可能先写目标 JSONL 再返回 manager，不能对它们要求所有文件一律先映射 ACK 才创建。先持久化替换意图，取得目标后认领再绑定执行；保留中断窗口的源历史和未认领文件，不盲目重做。
3. streaming 中的 custom 消息可能在父配置返回后才交付，必须建立独立 delivery Operation；不能向终态父操作追加内容，也不能使用全局 currentOperationId 猜归属。

另外核对了两个 hook 差异：setThinkingLevel 的异步 emit 不受方法返回约束；ExtensionRunner.emit 会捕获 hook 错误并报告监听器，不保证 setModel Promise reject。文档要求分别处理配置有效值、异步子操作和真实错误通道。

## 依据与验证边界

固定源码 gitHead 为 `d981de1229ef899957bbe968bc8dcda02a21f477`：

- [AgentSession 自定义消息](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L1470)、[clearQueue / abort](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L1587)、[用户 Bash](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L2983)、[setSessionName](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L3091)。
- [TUI 停止输入恢复](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2854)与[手动压缩路径](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5062)。
- [SessionManager 打开行为](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts#L898)、[首次自动 flush](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts#L1029)、[forkFrom](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts#L1611)。
- [AgentSessionRuntime 重绑定与替换](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session-runtime.ts#L187)、[ExtensionRunner 错误报告](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts#L851)。

主代理在临时 SQLite 中复现了旧 schema 对自主 Run、一命令多 Run 的拒绝；修订后用真实临时 SQLite 文件检查允许的因果形状、无 Run timeline、唯一 Operation 及保留的执行归属 FK。跨 owner 的业务校验、标题回声算法、SDK 队列、runtime 替换及异步 hook 仍须按 S02 / S04 / S06 / S07 实现验证，SQL 检查不能代替它们。

新增 [native-runtime.json](../examples/native-runtime.json) 是合成数据：覆盖并行模型旁的无 Run 内容、父操作结束后的交付、自主与一命令多 Run、跨 Session 因果、stop 草稿含附件及旧目标 prompt 恢复分类。合成事件检查不表示这些流程已在 SDK 或设备上运行。

## 修改后的独立复核

独立代理已对实际工作树差异完成只读复核，结论：**N1–N6 在设计契约层面均已对应修订，未发现剩余阻断项。** 跨 Session 因果、fork / import 写文件窗口、延迟 custom 与 thinking hook 子 Operation 均已衔接；协议、SQL、示例、步骤及验收没有发现剩余的相关冲突。代理未重复运行主代理负责的检查脚本。

本轮 Windows 本地 `python scripts/check_docs.py` 与 `git diff --check` 通过：14 份 Markdown、13 个阶段、14 条需求、32 个验收项、8 项 Bash + 8 项整体 TUI 对照、135 条合成事件及 12 张 SQLite 参考表。对应提交的 Linux 检查由仓库 Documentation checks 执行。

复核结论不代表原生体验已验收。应用阶段仍全部 not_started；实际 SDK、Linux 进程、Docker、设备及存储事务的 owner 校验须按计划实施验证。
