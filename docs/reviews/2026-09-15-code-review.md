# pi-remote 整体代码审核报告

日期：2026-09-15。审核对象：本地工作树中的后端、pi 适配层、公共协议、移动端和测试。Git 基线为 `12994b3cafacb06b0cdd30339987db942305e10c`；大部分实现尚未被 Git 跟踪，本报告针对这些本地实现，不代表 GitHub 上该提交已经包含或通过代码审核。下文行号对应审核时工作树。

## 结论

**已有相当完整的工程骨架，但核心执行链路尚不能作为可日常使用的远程 pi 交付。** 问题不只在于缺少模型凭据或手机验收：真实 SDK 的消息生命周期、输入清理、历史恢复和扩展接入已有可确认的实现错误。

共列出 **16 项问题：10 项 P1、6 项 P2**。P1 应在交付可用版本前修复；P2 应在相应能力验收前修复。本次没有发现足以判为 P0 的问题，也没有据此推断整个系统不存在其他缺陷。

审核按“同一 Linux 环境下尽量保留本地 pi TUI 体验”的宗旨进行。建议修复桥接、持久化和呈现逻辑，不建议通过关闭扩展、限制 Bash、强制所有操作空闲或缩小 SDK 工具权限来规避问题。

值得保留的基础包括：协议与 SDK 类型隔离、Command/Run/Operation 分层、SQLite 事务与服务端幂等记录、事件落盘后广播、移动端账号缓存隔离，以及对部分 live/device 验收明确标记 blocked。这些方向合理，不需要推倒重来。

## 实际验证及证据边界

| 验证 | 本次结果 |
| --- | --- |
| `pnpm test:unit` | 17 个测试文件、85 个测试通过 |
| `pnpm run build:server` | protocol、agent-pi、server 构建通过 |
| `pnpm run lint` | 通过 |
| `pnpm run typecheck` | packages、server、mobile、测试类型检查通过 |
| `pnpm run check:docs` | 入口失败：当前 WSL 没有 `python` 命令 |
| `python3 scripts/check_docs.py` | 通过；这只是文档、协议样例和参考 schema 检查 |
| 固定 SDK 0.85.1 定向实验 | 见下表；未调用外部模型 |
| 真实 provider、原生 TUI 全量对照、Android/iOS 真机、Docker 部署 | 本次未运行 |

环境：WSL Linux、Node 24.19.0、pnpm 10.28.0。定向实验使用真实 PiWorker、真实 SDK 和临时项目/agentDir；模型实验只替换凭据预检及模型流为内存实现，保留真实 SDK 事件生成和 worker 转换，再通过真实 reducer 回放。它能证明 SDK 桥接错误，不能代替真实 provider 验收。

本地复现脚本位于忽略目录 `test-results/code-review/native-probes.mjs` 和 `recovery-probe.mjs`，前者的结果为同目录 `native-probes.json`。脚本不属于交付测试套件，不应直接据此把阶段标为 passed。以下记录已包含关键结果，不依赖读者拥有该忽略目录。

| 实验 | 观察结果 |
| --- | --- |
| 一条合成成功回复经过真实 SDK 流程 | 5 个 assistant start ID、1 个 end ID；4 个 live item 未闭合；reducer 报 `run success-run ended with open content; seal it first` |
| 合成 provider error 经过真实 SDK 流程 | worker 的 Run 和 Command 均报告 `completed`；同时存在上面的消息 ID 问题 |
| 真实 SDK 执行 `printf "review-bash-marker\n"` | command result 有输出、exitCode=0；内容事件数为 0 |
| 空闲 SDK `sendCustomMessage(..., {triggerTurn:false})` | manager 历史中存在消息；桥接内容事件数为 0 |
| SDK 排入 steer 后调用 worker 的清队列路径 | 输入事件为 `queued → consumed`，没有 `returned`；SDK 队列已清空。此项是边界实验，不是完整运行中 stop E2E |
| 合法 JSONL header 后追加半行损坏 JSON | 检查器返回 `persisted`、entryCount=0，未报损坏 |
| 按生产 follow_up 形状写入真实 EventStore 后执行 RecoveryManager | 恢复前 Command/Run 均 queued、队列长度 1；恢复后均 cancelled、队列长度 0。此项是持久化恢复合同实验，不是实际进程 SIGKILL |

## P1：交付前必须修复

### R01 — 消息 ID 依赖对象引用，真实 SDK 流式回复会被拆成多条未闭合消息

**位置：** `packages/agent-pi/src/worker.ts:1441`，以及 `messageStarted`、`messageUpdated`、`messageCompleted`。

`messageId()` 用 WeakMap 按对象引用分配 UUID。然而固定版本 pi-agent-core 的 `agent-loop.js:205`、`:220` 在 start/update 时发送 `{...partialMessage}`，end 又使用最终消息对象。它们属于同一回复，但对象不同。

**影响与证据：** 成功回复实验产生 5 个消息 ID，只完成最后一个。真实 reducer 因 4 条未闭合内容拒绝 Run completed。界面可能出现碎片消息，服务端事件处理进入失败恢复；这直接影响最基本的对话。

**修复及验证：** 按 SDK 消息生命周期建立稳定 ID，start 分配，后续 update/end 关联同一条活动消息；不能依赖对象引用或只靠时间戳猜测。用真实 SDK 和确定性流验证多段文字、thinking、工具调用、多轮续写：每条消息一个 ID，终态无残留 live item，完整事件可被 EventStore/reducer 接受。不要仅在终态强制封存来掩盖错误关联。

### R02 — 将 `prompt()` 正常返回等同于模型成功

**位置：** `packages/agent-pi/src/worker.ts:601`、`:613`、`:1328`。

执行逻辑在 `await session.prompt()` 返回后直接选择 completed；只有 Promise 抛错才 failed。SDK 可以把 provider 错误表示为 assistant 的 `stopReason: "error"`，正常结束调用。现有事件处理没有把这些结果、重试结果与 Run 终态关联。

**影响与证据：** 合成 error 流经过真实 SDK 后，worker 发出的 Command 和 Run 都是 completed。该错误独立于 R01：即使修正消息 ID，失败任务仍会被显示成功。

**修复及验证：** 基于 SDK 最终执行结果及 settled 生命周期判定失败、取消、重试后成功，保留错误说明和 partial。分别验证 provider error、不抛异常的错误消息、重试后成功、用户 abort、工具失败但模型最终正常完成；不要把所有工具错误直接当整轮失败。

### R03 — stop 取回草稿被标成已消费；compact 还复用了同一清队列路径

**位置：** `packages/agent-pi/src/worker.ts:797`、`:809`、`:1165`、`:1382`；`apps/server/src/services/commands.ts:785`。

真实 SDK `clearQueue()` 在返回旧队列前同步发出 `queue_update`。worker 先收到空队列，由 `reconcileSdkQueue()` 删除跟踪项并发 consumed；随后 `persistClearedInputs()` 已没有跟踪项可标 returned。

**影响与证据：** 实验得到 `queued → consumed`，草稿没有回到可恢复列表。另一个明确的语义问题是 `stopThenCompact()` 给 worker 发普通 abort，进而清除输入；这没有落实设计要求的 compact 独立原生队列语义。

**修复及验证：** 显式区分“SDK 消费”和“主动取回”，清理期间保留输入 ID 与完整内容，不能仅由长度减少推断消费。将 compact 的队列处理与原生 TUI 对照后单独实现。使用会同步发 queue_update 的真实 SDK 验证 steer/follow-up、重复文本、多项输入、stop 后完整返回且不自动重发，以及 compact 对队列的正确影响。

### R04 — 未分派 follow_up 在恢复时被当作失效控制取消

**位置：** `apps/server/src/services/commands.ts:462`；`apps/server/src/runtime/recovery.ts:269`。

生产命令接收为 follow_up 新建 queued Run，并把该 Run 写为 command.targetRunId。恢复逻辑优先处理 targetRunId：目标 queued 且未跨 IPC，就把 Command、Run、Operation 取消，并移出队列。它无法区分“新建的排队后续任务”和“指向旧运行的控制”。

**影响与证据：** 按生产事件形状写入 EventStore 的实验中，一个尚未执行的 follow_up 在恢复后从队列消失。预期应保留内容和待执行身份，按恢复语义暂停已有后续项。

**修复及验证：** 明确区分控制目标与命令拥有的 queued Run，恢复据此分类。测试必须从实际 CommandService 接收路径产生 follow_up，再中断 worker/main，确认未分派项保留、未知已分派项不重投、旧 abort/respond 被取消，且新对话仍可发起。

### R05 — JSONL 检查器会把损坏历史判断为有效

**位置：** `packages/agent-pi/src/session-file.ts:125`。

检查器把 SDK `parseSessionEntries()` 放在 try/catch 中，但该 SDK 解析器逐行捕获 JSON 错误并跳过损坏行。外层 catch 不会因此触发。合法 header 后的损坏记录会被当成不存在。

**影响与证据：** “合法 header + 被截断的 message JSON”返回 persisted、零记录。真实历史可能静默丢失上下文，继续运行时用户也不知道历史损坏。

**修复及验证：** 在 SDK open 前独立校验非空行的 JSON、记录身份及历史引用关系；保留原文件，显式报告损坏位置。合法 header-only 文件仍应可读。测试覆盖截断末行、中间坏行、重复/错误身份、合法分支和合法空历史，断言失败时文件字节不变。

### R06 — 重载没有传递持久状态和原 pi ID，空 Session 重启与持久历史保护都不完整

**位置：** `apps/server/src/runtime/manager.ts:581`、`:695`；`packages/agent-pi/src/session-file.ts:178`；`apps/server/src/storage/repositories.ts:542`。

启动查询只取 pi_session_file，没有取 pi_session_id、pi_persistence_state。worker 收到旧路径后允许 missing/empty 进入 `SessionManager.open()`；同时 `setPiMapping()` 对已有映射一律要求身份不变。

**影响（源码确认）：** 合法 unflushed Session 可能还没有 JSONL；重开路径时 SDK 会分配新身份，随后被不可变映射拒绝。对于已知 persisted 的缺失/空文件，系统又没有在 open 前按持久状态阻止初始化。不能靠 SDK 打开后的 mapping 校验替代历史保护。

**修复及验证：** 初始化协议携带预期 ID、路径和持久状态。仅对 unflushed 使用明确的恢复/重绑定流程；persisted 必须先验证原历史。测试“分配映射但未落盘后重启”“header-only 重启”“持久文件删除/清空/换成另一会话”，检查身份、错误状态及原文件不被改写。

### R07 — 用户 Bash 能执行，但输出没有进入时间线，且活动模型期间被统一拒绝

**位置：** `packages/agent-pi/src/worker.ts:549`、`:833`、`:1328`。

`executeBash()` 没有提供 chunk 回调，事件 switch 也没有处理 `bash_execution_update`。SDK 的 `recordBashResult()` 写入会话历史，并不会补发这段适配逻辑期待的 message_start/end。结果只进入 command_result。另有 `this.execution && !isExtension` 的统一 busy 判断，阻止模型活动期间启动用户 Bash。

**影响与证据：** printf 实验实际成功且有输出，内容事件却为零。手机无法获得本地 TUI 式的 Bash 进度和历史。busy 判断还把不同原生操作压成单一互斥操作，不符合既定体验目标。

**修复及验证：** 为用户 Bash 建立独立 Operation 和内容生命周期，接入增量输出、最终结果、退出码、取消及 user_bash 扩展结果，并保留 `!`/`!!` 的上下文差异。验证慢速分段输出、模型运行中执行、后台命令、非零退出、取消和历史回放。按 SDK 实际互斥条件处理冲突，不统一禁止。

### R08 — 初始化扩展表单超过 15 秒即被判为启动失败

**位置：** `packages/agent-pi/src/worker.ts:485`；`apps/server/src/runtime/manager.ts:590`。

worker 等待 `bindExtensions()` 中的 session_start hook 完成，之后才发 mapping/ready。主进程对 ready 默认只有 15 秒的硬超时，超时进入 worker failure；等待用户表单不豁免。

**影响（源码确认）：** 扩展启动时要求用户确认、输入或选择，手机用户花超过 15 秒回答，健康 worker 也会被终止。这个限制尤其不适合锁屏、弱网场景。

**修复及验证：** 区分进程握手失败与已进入合法初始化交互，建立可持久化的初始化状态及映射顺序，等待交互期间按存活状态管理。真实 session_start hook 打开表单，等待超过 15 秒并断连重连后回答，确认 worker 存活且只继续一次；真正无响应进程仍可检测。

### R09 — 生产 worker 没接完整原生 runtime，会丢掉无命令消息与会话切换能力

**位置：** `packages/agent-pi/src/worker.ts:374`、`:495`、`:1427`；`packages/agent-pi/src/runtime.ts:168`。

仓库定义了 createPiAgentRuntime，但生产 worker 使用 createPiAgentSession，bindExtensions 没传 commandContextActions，也未接入 runtime 的 session replacement 回调。固定 SDK 的默认 newSession/switchSession handler 是返回未取消的空操作，不能据接口存在认定切换有效。

另外，内容转换依赖当前 executionContext；空闲时没有上下文就直接丢弃消息。仅定义可空 Run 的协议，并没有实现无 Command 活动的归属与生命周期。

**影响与证据：** 空闲 sendCustomMessage 已写入 pi manager，却没有手机内容事件；扩展发起新会话、切换、fork，以及自主模型活动也没有完整应用映射。独立 runtime wrapper 的测试不能覆盖生产 worker。

**修复及验证：** 接通实际 runtime/command context actions、替换回调、映射持久化和必要的事件订阅迁移；从原生活动创建正确的 Operation/Run，不强制每次活动都有外部 Command。验证扩展空闲消息、自主 turn、new/switch/fork、替换后的延迟回调和重启，检查手机、SQLite 与 JSONL 身份一致。

### R13 — 手机重试身份仅活在单次函数调用里，弱网下可能重复执行

**位置：** `apps/mobile/src/api/client.ts:273`；`apps/mobile/App.tsx:1125`。

submitCommandWithRetry 内部重试一次时使用同一键，但每次调用默认创建新幂等键。页面没有持久化待确认提交的键和请求；两次响应都丢失后，再点击发送或重启 App 会形成新命令。

**影响（源码确认）：** 服务端可能已接受甚至执行 Bash，手机却显示失败；用户重试会再次执行。服务端幂等实现无法识别新的客户端键是同一次用户操作。

**修复及验证：** 提交前持久化请求身份与原 payload；未知结果显示“确认中”，重试沿用原键，并与明确的新提交区分。测试服务端已经提交、两次 HTTP 响应均丢失、App 重建后恢复，确认最终只有一个 Command、一份 shell 副作用；有意重复发送相同文本仍应能创建新命令。

## P2：能力完整性与可维护性

### R10 — 多个标准扩展 UI 方法被静默做成空操作

**位置：** `packages/agent-pi/src/worker.ts:1090`。

setStatus、setWidget、setWorkingMessage、pasteToEditor、setEditorText 等直接返回；getEditorText 恒为 `""`。这不仅是终端视觉差异，还会改变依赖编辑器读写的扩展逻辑。页面声称存在结构化回退，并不能使这些空操作真正产生可见结果。

**修复及验证：** 标准状态、文本部件和编辑器操作应有结构化事件与移动端呈现；对无法等价呈现的终端 custom UI 明确展示能力差异和可行回退，不伪装成功。用真实扩展依次设置/读取编辑器、状态和 widget，确认事件与界面结果一致，重连后必要状态可恢复。

### R11 — 模型目录与思考等级返回硬编码空列表

**位置：** `apps/server/src/routes.ts:198`；`apps/server/src/services/resources.ts:433`；`apps/mobile/App.tsx:1329`。

`/v1/models` 永远返回 items=[]，snapshot 永远返回 availableThinkingLevels=[]。因此配置好 provider 也不会出现模型目录和思考等级按钮。手机仍可手填 provider/model ID 切换模型，但这不等于目录功能可用；思考等级入口没有相应的手填替代。

**修复及验证：** 从实际 SDK model runtime 和当前模型读取可用值，覆盖自定义模型与配置刷新。用无需真实密钥的合成注册模型验证目录、能力、切换与等级 clamp；切换后手机显示 SDK 的实际值。

### R12 — 原生标题/配置更新不推进版本，未加载会话的改名不会同步到 pi

**位置：** `packages/agent-pi/src/worker.ts:856`、`:1349`、`:1364`；`packages/protocol/src/reducer.ts:681`；`apps/server/src/runtime/manager.ts:476`、`:695`。

worker 的 session.updated 不携带 version，reducer 也不会自动推进。扩展修改标题或思考等级后，旧手机仍持有可被接受的 expectedVersion。另一方面，notifyRename 仅通知已加载 worker；初始化数据不携带数据库标题，未加载时的改名没有持久同步意图可以补送。

**影响（源码确认）：** 双端更新可能覆盖较新配置；应用标题与原生历史标题分叉。协议中的 metadataSync/pendingTitle 并不代表生产链路已实现同步。

**修复及验证：** 由持久化边界统一分配版本，记录标题同步意图与回声识别，加载时完成未同步元数据。验证未加载改名再加载、原生先改配置后手机持旧版本更新、并发改名及自身回声不形成循环。

### R14 — 工具输出在落盘前被截断，却仍声明没有截断

**位置：** `packages/agent-pi/src/worker.ts:267`、`:1675`、`:1693`。

tool.updated/finished 对内容调用默认 32768 字符的 bounded()，同时写 `truncated: false`，也没有在此路径保存全文引用。下游 WSS 的大帧 artifact 机制无法恢复上游已经丢弃的文本。

**影响（源码确认）：** 较长构建日志、搜索结果或扩展输出在手机上呈现为“完整”，实际后半段已经缺失。这是应用展示副本的数据丢失；本项不声称 SDK 提供给模型的原始工具结果被同步缩短。

**修复及验证：** 完整保留结果或先保存 artifact，明确标记截断并提供完整输出位置，保留 SDK 自带 fullOutputPath 等有用信息。验证超过 32K、超过单帧限制、关键错误在结尾的输出，HTTP/WSS/历史视图都能访问相同完整结果。

### R15 — 每个增量事件都重读并复制整个会话历史

**位置：** `apps/server/src/storage/snapshot.ts:67`；`apps/server/src/storage/event-store.ts:398`；`packages/protocol/src/reducer.ts:77`、`:815`；`packages/agent-pi/src/worker.ts:1700`。

EventStore 每批调用 loadReducerState，读取全部 timeline_items；reducer 每事件 structuredClone 整个状态，再同步历史 Command/Run 等投影。worker 又把每个增量作为独立批次发送。处理新 token 的成本随历史增长，累计工作量有趋向二次增长的路径。

**影响（结构性风险，未做容量压测）：** 长会话会拖慢同一主进程的写入和其他连接；ACK 延迟累计到 256 批时 worker 报 IPC_BACKPRESSURE，而不是正常缓冲。不能从短合同测试推断长时间开发体验。

**修复及验证：** 将活动投影与不可变历史分开，增量更新受影响实体；使用有界批处理与明确背压。以固定增量负载对比短/长历史、多 Session 并行，记录写入延迟、事件循环延迟、内存和 ACK backlog。无需因此引入 PG/Redis，也不应靠限制用户工具输出规避。

### R16 — “Linux 进程恢复”测试没有杀死真实应用进程，关键集成覆盖缺失

**位置：** `tests/e2e/harness.ts:169`、`:188`；`tests/e2e/s11-recovery.test.ts:14`。

LinuxFaultHarness 启动的是打印 pid 后 setInterval 的替身进程。测试杀掉这些进程后，另外手工创建数据库状态并直接调用 RecoveryManager。它能验证 SIGKILL 与恢复投影合同，不能验证真实 main/worker 的 stdout 排空、退出事件、ACK、JSONL、Bash 子进程和重启顺序。

**影响：** 当前绿色测试漏掉了 R01/R03 等真实 SDK 行为，也没有证明最关键的断线、崩溃后不会丢输入或重复执行。现有文档对部分外部验收保持 blocked 是正确的，但还应区分“需真实 provider/设备”与“本地就能补的真实 SDK/进程集成”。

**修复及验证：** 保留合同测试并准确命名，另外启动真实 server/worker，通过 HTTP 提交、WSS 观察，使用确定性模型 provider，从外部发送 SIGKILL 后重启并核验数据库和副作用。这无需向生产应用增加调试 kill 接口。用不同故障时点验证 IPC 前、执行中、结果落盘前后及重连，最后再补原生 TUI、真机和 Docker 对照。

## 建议的修复顺序

1. **先打通最小真实 SDK 闭环：R01、R02、R07，并补 R16 的真实进程测试。** 一条流式回复和一条用户 Bash 必须能正确开始、显示增量、结束、回放。
2. **再修输入与恢复：R03—R06、R13。** 验证 stop 不吞草稿，follow_up 不消失，历史不静默重建，弱网不产生重复执行。
3. **补齐原生能力：R08—R12、R14。** 初始化表单、无命令内容、原生会话操作、编辑器状态、模型/思考和元数据同步都应走生产链路。
4. **做长会话与部署验收：R15，以及尚未完成的真机、TUI、Docker 验证。** 在前述正确性修复后再记录可用性和性能结论。

维护上，worker、manager 和移动端 App 已较大。修复时可按消息生命周期、输入、交互、会话替换拆出适配模块，但不建议先做无行为验证的大规模重构。AGENTS.md 和文档检查器仍有“仅设计仓库”表述，应在后续实现交接时更新；本次审核没有改动这些文件或其他 AI 的实现。

本报告仅新增审核文档；没有修复产品代码，没有提交或推送工作树。未进行真实 provider、真机和 Docker 验收的部分仍保持未验证。

## R16 修复与最终构建复验（真实进程集成，2026-09-15）

**最终构建结果：9 passed / 0 failed / 0 skipped / 0 cancelled，80.06 秒，退出码 0。此结果取代此前 81.38 秒的阶段性 9/9，以及更早的 3/9、2/9 失败运行，作为当前 R16 复验结论。** 在 parent 确认最终 build:server 退出码 0、所有 owner 冻结变更后，使用该构建的 dist，运行 `node scripts/test-real-process-e2e.mjs --no-build`。本次没有重新构建、修改产品代码、提交或调用收费模型；parent 的完整 unit/typecheck 由其单独运行。

运行环境：WSL/Linux，Node 24.19.0，pi SDK 0.85.1，OpenSSL 临时本地 TLS 证书。入口离线复制 180 个已安装生产依赖及当前 dist 到全新 Linux 临时目录，不复用旧 `/tmp/pi-r16-offline-20260915`。核心生产文件复制前后 SHA-256 一致，测试完成后再次核对原 dist 仍匹配；完整摘要见 `test-results/code-review/r16-runtime-manifest.json`。这是避免 WSL Windows 挂载下约 36 秒 SDK import 的执行位置调整，未改写 worker、SDK 或恢复逻辑。

| 实际应用进程场景 | 本轮结果 |
| --- | --- |
| HTTPS 提交模型 prompt；WSS 流式消息 ID 闭合；真实 SDK Bash tool round trip；JSONL 身份与内容；完成后 SIGKILL/restart/幂等重投不重复副作用 | passed |
| 本地 HTTP provider error → Command 与 Run failed | passed |
| Bash 执行中从外部 SIGKILL 真实 worker；unknown 终态；同幂等键一份副作用；新 Bash 可执行 | passed |
| Bash 执行中从外部 SIGKILL 真实 main；持久恢复、重连、一次副作用及新工作 | passed |
| SIGSTOP main 后放行 Bash 到完成标记，确认结果仍未落盘，再 SIGKILL main；重启保持 unknown 且不重投 | passed |
| 真实 SDK 排入两份同文 steer，stop 后保留不同 inputId 与完整草稿；Command cancelled、Run aborted；不自动重发 | passed |
| HTTP 产生未跨 execute IPC 的 follow_up；main SIGKILL 后旧项暂停保留、活动 partial 封存，新 Bash 仍可用 | passed |
| 真实 session_start confirm；从 interaction.requested 起等待 61.5 秒；WSS 重连、snapshot 保留表单、响应幂等且只继续一次 | passed |
| 原生 newSession/switchSession 与 withSession 自主 Run 按新/旧应用 Session 路由；SQLite/JSONL 身份一致；main SIGKILL 后继续 | passed |

实现入口：`scripts/test-real-process-e2e.mjs`；离线部署副本：`scripts/stage-real-process-runtime.mjs`；用例与外部进程控制：`tests/e2e/real-process.test.mjs`、`real-process-harness.mjs`。TLS bootstrap、确定性 HTTP 模型服务、真实 SDK 扩展分别位于 `tests/sdk/real-server-entry.mjs`、`local-http-provider.mjs`、`r16-native-extension.mjs`。使用说明见 `tests/e2e/README.md`。

bootstrap 创建真实 SQLite、生产 WorkerManager 与 buildServer，仅配置 TLS 和测试夹具的 mappingTimeoutMs=60000（60 秒是夹具设置，不是用户需求）。外部启动等待 90 秒，每项测试上限 300 秒；表单计时排除 import。唯一合成服务是通过独立 agentDir/models.json 配置的 loopback OpenAI-compatible 模型端点，使用无秘密的占位 key；子进程白名单环境不继承 owner 凭据或 home 资源。真实 SDK、工具、Bash 子进程、JSONL、SQLite、worker stdout/ACK、HTTP 与 WSS 均走生产链路。故障只用外部 OS 信号、文件屏障及只读数据库/`/proc` 观测，不添加产品 kill/debug 接口或手写执行事件。

旧 `LinuxFaultHarness` timer 替身已移除。`s11-recovery.test.ts` 保留为明确命名的 synthetic durable recovery projection contract，不再声称杀死真实应用进程。测试侧 ESLint 通过；现有 Vitest E2E contracts 为 3 文件、4 测试通过；文档检查通过。

本轮证据：`test-results/code-review/r16-final-real-process.log`（本次完整 9/9 日志）、`test-results/code-review/r16-runtime-manifest.json`（生产构建摘要）、`test-results/code-review/r16-details/`（按用例保存的合成持久事件与进程诊断）。较早的 `r16-real-process.log` 仅保留修复前失败的历史证据，已被本轮 9/9 取代。

真实集成曾暴露四类问题并提前协调产品 owner 修复：isPersisted() 被误当物理 flush；command-owned prompt 未进入 running；响应 claim 早于 Command 插入造成 FK 失败；多 Session recovery epoch/batch 冲突。修复前最近完整结果为 2/9，本轮最终构建 9/9 已覆盖这四类具体复现，未降低断言或将失败标 skip。

R16 的本地真实进程测试已补齐。本轮已对 editor/reap 与并发 native replacement intent correlation 修复合入后的最终构建完整复跑既有 9 项，结果仅覆盖表中场景，不替代这些改动各自的定向回归或 parent 的完整 unit/lint/typecheck。progress 与 remediation 文档由 parent 维护。这些确定性集成用例不代表收费 provider、原生 TUI、Docker 或 Android/iOS 真机验收，也不构成任意 Bash 副作用恰好一次的保证。没有修改产品代码或提交。
