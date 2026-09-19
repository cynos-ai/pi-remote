# 分步骤开发计划

状态：执行规格，S01–S12 已有工作树实现，S02/S06–S11 的外部 live / 原生 TUI / 设备子集仍按报告状态执行。每一步的命令由该步实现；不要把下面的命令复制进 README 当作已有产品使用说明。

先读[整体 TUI 体验原则](tui-experience.md)、[架构](v1-design.md)、[协议](protocol-v1.md)、[数据](data-model.md)、[Bash 兼容要求](bash-compatibility.md)及[验收矩阵](acceptance.md)。阶段通过后在 [progress.md](progress.md) 保存真实证据，再继续下一个前置条件满足的阶段。

## 0. 通用完成条件

每阶段交付实际文件、相应 `pnpm verify:Sxx` 脚本、可重复测试和清洗后的验证摘要。脚本在未实现、配置缺失、断言失败或必需证据缺失时非零退出；不以空测试、无条件 skip 或打印 success 充当验证。

实现变更运行本阶段验证及受影响的回归。所有阶段都保持 `pnpm lint`、`pnpm typecheck`、`pnpm build` 可通过；S01 之前这些命令尚不存在。真实 SDK / 设备测试单独标记，公共 CI 不要求秘密凭据，也不能将缺少这些测试视为完整发布通过。

跨阶段验收项按本阶段列出的实现和环境验证子集，并在报告中写清范围；只有所有子集都验证后才能把整项 AT 标为 passed。S13 负责检查完整矩阵。不要让尚待后续实现的功能成为前置阶段的循环依赖。

测试数据只放临时项目。模型测试使用运营者配置的专用 provider / model，凭据放仓库外；至少准备两个可用模型，其中一个能返回 thinking。为 live 脚本设置请求数和 token / 时间上限，超过限制失败，不无限重试。iOS JS 打包可以在 Linux 做，原生构建 / 模拟器需要 macOS 或云构建，最终还需真实 iOS 设备。

| 阶段 | 前置 | 核心交付 | 验收 ID |
| --- | --- | --- | --- |
| S01 | 无 | 工程、依赖、基础 CI | AT01 |
| S02 | S01 | 固定版本 SDK、原生能力清单和 TUI 基线 | AT02, AT03, AT26, AT31, AT32 |
| S03 | S01 | DTO / schema / 纯事件 reducer | AT06 |
| S04 | S03 | 迁移、事件日志、投影与快照 | AT07, AT08 |
| S05 | S04 | 鉴权、项目与 Session 资源 API | AT09, AT10, AT11, AT12 |
| S06 | S02, S04, S05 | worker、调度、崩溃恢复 | AT13, AT19, AT25, AT31, AT32 |
| S07 | S05, S06 | 原生命令、模型、压缩与全阶段表单 | AT04, AT05, AT11, AT12, AT14, AT15, AT16, AT32 |
| S08 | S04, S05, S07 | WSS 与可靠回放、大输出 | AT17, AT20, AT27, AT31 |
| S09 | S03, S05 | 手机配对、项目、列表、历史 | AT21, AT22 |
| S10 | S07, S08, S09 | 手机流式时间线、原生入口和表单 | AT18, AT21, AT22, AT31, AT32 |
| S11 | S10 | 双端弱网与 Linux 进程故障闭环 | AT18, AT19, AT29 |
| S12 | S08 | Docker、开发环境兼容、故障恢复与备份 | AT19, AT23, AT24, AT25, AT28, AT31, AT32 |
| S13 | S11, S12 | 发布候选与完整验收 | AT30 |

默认按编号开发。S02 缺少真实模型条件时可继续 S03–S05；不能将 S02 标为通过，也不能宣布依赖真实 SDK 的 S06 / 发布已完成。其他外部限制同理处理。

## S01 — 创建工程与验证入口

**产物**：根 package.json、pnpm-workspace.yaml、锁文件、tsconfig；apps/server、apps/mobile、packages/protocol、packages/agent-pi；基础 lint / test / build 配置与 Linux CI。

**实现**：

1. 锁定 Node 24、pnpm 10、SDK 0.85.1，以及 Expo / React Native 的兼容版本。记录版本与选择依据。
2. 创建 Fastify 可启动骨架、Expo 可打开的最小页面、两个可构建 package，建立正确 workspace 依赖；服务进程与 App 不跨包直接引用源文件。
3. 创建环境变量校验和 `.env.example`，不带真实值。建立临时目录测试工具、报告目录和独立 live test 开关。
4. 配置 lint、typecheck、build、test:unit、verify:S01；保留文档检查。应用运行状态此时只允许称为骨架。

**验证**：`pnpm install --frozen-lockfile`、`pnpm verify:S01`。在干净 Linux checkout 构建所有 packages / server，分别完成 Android / iOS JS bundle，启动 server 后获取 healthz。确认 SDK 只有 agent-pi 包直接依赖。

**通过**：AT01；无隐含全局依赖，CI 从空缓存可运行。JS bundle 成功不等于原生设备验收。

## S02 — 验证 pi SDK 的真实行为

**产物**：packages/agent-pi/src 的最小 SDK 包装、测试 CLI、tests/sdk、docs/sdk-verification.md、docs/native-capabilities.md；需要时修正已发现的 SDK 文档差异。

**实现**：

1. 创建一次性 Linux 项目目录，在指定 agentDir / sessionDir 创建 Session，绑定事件后发 prompt；分别记录 SDK ID / 路径分配及首次文件出现时间，不假定 create 已写文件。
2. 验证文本、thinking、工具参数、累计结果、最终消息、preflight、agent_end / agent_settled 的时序。
3. 关闭再从同一有效文件恢复；验证模型、等级、标题及上下文。验证空配置会话无文件时重放 SQLite 配置、open 缺失 / 空文件的静默初始化；另用原生 forkFrom / import 产生合法 header-only / 非 assistant 历史，必须可认领和恢复，不能把首次自动 flush 条件误作文件格式要求。
4. 验证 setModel、getAvailableThinkingLevels、setThinkingLevel、compact、abortCompaction、steer、clearQueue、abort 和 bindExtensions。覆盖 streaming 切配置、clamp、默认值 flush；确定性阻塞模型流后加入重复文本及附件输入，按 TUI stop 清取并恢复未消费项。compact 单独对照原生待消费队列时序，不套用 stop 的清队列或预设全部 aborted。
5. 用测试 extension 在执行、session_start、model_select、thinking_level_select 及独立回调触发四种表单。验证无 Run 等待、initialize 未 ready 可 respond；thinking 方法返回后表单仍可回答。订阅 ExtensionRunner 的错误通道，验证 hook 抛错不一定 reject setModel，实际配置仍正确。DefaultResourceLoader 按原生配置 / trust 加载资源。
6. 在 Linux 运行原生 Bash 的长任务及已正常返回的后台服务，记录 worker / shell 的 PID、PGID、启动标识；验证 SDK abort 对当前调用的原生行为，区分未完成调用 SIGKILL 与正常后台进程。测试 harness 清理自己的临时服务，不把测试范围变成生产限制。
7. 按 Bash 兼容文档 B01–B08 建立可复用对照夹具：工具 schema / 结果、复杂 shell、网络 / 依赖、无默认 timeout、后台服务、非零退出后继续修复、原生大输出。用默认 SDK 执行器作确定性基线，并记录同环境 pi TUI 的实际 smoke；不通过替换为受限 Bash 工具取得测试通过。
8. 按 T01–T08 建立整体能力清单及 `pnpm test:tui-parity` 入口，记录原生 API、适配方式、阶段和证据。覆盖工具、扩展、skills、templates、上下文、附件、用户 Bash（`!` / `!!`）、会话树 / fork / 导入导出、扩展命令 / widget；状态为 available / needs_adapter / disabled_by_owner / upstream_unavailable。验证 streaming 期间扩展命令即时执行；needs_adapter 必须有实施步骤，不能以默认禁用代替适配。新增 DTO 在相应适配实施前同步协议、schema、示例与测试。
9. 按 [原生运行契约](native-runtime-contract.md) 验证 triggerTurn=false 的 custom、streaming 中延迟交付、自主扩展 prompt、一条扩展命令 compact 后 prompt、用户 Bash / user_bash hook / abortBash 的 Session 范围；记录真实归属，不能造 Run 或 HTTP 请求。验证扩展 setSessionName 事件与异步回声。
10. 对 AgentSessionRuntime 的 new / switch / fork / import 记录文件创建、factory、setRebindSession、session_start 和 withSession 顺序；验证源 S1 命令可在目标 S2 启动 Run，映射确认后才绑定目标执行回调。测试目标文件已写但映射未确认的窗口，保留可恢复结果，不重放 fork。

**验证**：`pnpm verify:S02` 执行无需模型的边界验证，`pnpm test:bash-parity -- --target sdk` 和 `pnpm test:tui-parity -- --target sdk` 执行 Linux 对照夹具；`pnpm test:live -- --suite sdk` 执行真实模型与工具验证。检查真实文件和 session JSONL；模拟 provider 失败，再用真实 provider 完成至少一次流程。测试使用临时项目和自己的总时限，产品 Bash 未传 timeout 时仍无默认时限。

**通过**：AT02、AT03、AT26 及 AT31 / AT32 的 SDK / TUI 基线子集均有证据；异常例包括无模型凭据、等级有效值校准、缺失 / 空文件静默初始化、hook 抛错。无 Run 对话框的等待 / 回答是必测正常路径。真实请求或 TUI 基线缺失时阶段不通过；待后续移动适配的条目不能提前标为 available。

## S03 — 公共协议、规范事件与 reducer

**产物**：packages/protocol/src/{http,commands,events,state,reducer}.ts、tests/protocol，消费现有合成 fixture。

**实现**：

1. 将 protocol-v1 的所有请求、响应、错误、内容块、事件和 Snapshot 定义为可运行 schema，导出 DTO。
2. 编写纯函数 reducer：事件序号、消息块、工具快照、Run / command / queue / operation / interaction 状态；不依赖 React、数据库或 SDK。Operation 为事件投影，维护 activeOperations，不另建长期操作队列。
3. 内容必有 operationId，runId 可空；实现 custom / bash 角色、父子 Operation、run.content_sealed / operation.content_sealed、input.updated 与 pendingInputs / recoveredInputs。明确累计替换、参数暂存、重复和缺口及队列版本；数据版本错误必须可见。
4. 消费 stream、interrupted、initialization-dialog、native-runtime 合成 fixture，扩展失败 / abort、重试、压缩、等待和截断；验证 Run 来源、多个因果 Run、无 Run 内容封存及延迟交付不落入已终态父操作。工具 / Bash 未知结果不虚构退出码，完整项不改写。

**验证**：`pnpm verify:S03`；AT06。按正常、重复、断批再重放的方式应用同一事件，最终状态相同；把 seq 3 跳到 5 时停止应用而非悄悄成功。工具累计快照不重复第一行；异常终态封存该 Run 的所有 partial，清空其 liveItems；有旧项才暂停，空队列 ready。旧 Run 不能污染新 Run 或独立配置表单。

**通过**：服务端与 App 可共用同一 reducer；不导出 pi 类型。超长输入、错误参数类型、未知核心事件及非法状态都有失败断言。

## S04 — SQLite 迁移、事件与投影

**产物**：apps/server/src/storage/{migrations,repositories,event-store,snapshot}.ts，基于参考 SQL 的初始迁移，tests/storage。

**实现**：

1. 版本化安装 schema，开启连接 PRAGMA，创建 owner；重复启动不重复写初始数据。
2. 实现命令收据、seq 分配、事件 / live_state / timeline / Run 状态的单事务更新，按 epoch + batchNo 去重。
3. 实现 snapshot 读事务、封存历史分页及固定 atSeq 边界；正常完成与异常 partial 同样分页，cursor 防篡改并绑定 Session。
4. 实现 artifact 封存元数据、路径校验及失败后的临时文件清理。
5. 在 live_state_json 维护 Operation、SDK 输入及 metadataSync 投影；验证无 Run 内容 / 交互、操作与 Run 对应关系、子操作存活及异常封存，最后一个后续项取消后 ready。Run.operation_id 必填且唯一；command_id 可空、非唯一；Run / Interaction 因果 Command 在事务中校验同 owner，允许同 owner 跨 Session，拒绝跨 owner；回答和 targeted 控制仍用同 Session FK。
6. 实现双向标题版本与来源 / 回声水位，模拟扩展改名、A→B→A、并发手机改名及 SDK 已落盘但事件未提交的恢复；不能只按标题字符串去重。真实 hook 路径由 S07 接续验证。

**验证**：`pnpm verify:S04`；AT07、AT08。使用真实临时 SQLite 文件而非全内存 stub，注入事务中途异常，确认事件、seq、投影全部回滚。重开数据库重放事件得到同样状态。快照取 S 后完成一个旧 partial，再分页旧历史，验证没有漏项或重复。

**通过**：复合 FK、跨 Session 因果 owner 校验、自主及一命令多 Run、无 Run 内容 / 交互、标题 / 输入投影及每 Session 一个活动 Run 有实际验证；异常封存 / 终态 / 对应交互关闭 / 队列变更原子提交。rollback 不产生广播。SQL 检查不冒充应用 owner / reducer 验证，性能测试不放真实项目数据。

## S05 — 设备、项目与 Session API

**产物**：apps/server/src/{auth,routes,services}、配对 CLI、tests/api。

**实现**：

1. 管理 CLI 生成短期配对 token，HTTP 原子消费，设备凭据只存摘要；实现 me、devices、吊销和限流。
2. 项目 realpath、允许根、读写能力、根 identity 和 git common dir 检测；实现注册、列表和默认配置更新。父子目录允许分别注册；相同真实目录 / 挂载身份映射到已有项目，workspaceKey 不产生默认串行门槛。
3. 实现 Session 新建、改名、归档 / 恢复、版本冲突，snapshot / history / events 查询；未加载的 Session 不启动模型。归档仅更新元数据，运行、排队、待答及归档后的命令保持可用。
4. 所有持久变更采用统一幂等收据，验证归属后重放原响应；事务外仅快查，操作锁和事务内在可变状态检查前重查，唯一键竞态转为原收据 / 幂等冲突。未实现的执行能力不在 capabilities 中宣称可用。

**验证**：`pnpm verify:S05`；AT09、AT10、AT11、AT12。并发复用配对 token 只能成功一次；跨用户资源必须 404。用同步屏障让同键同内容的两个 create / PATCH 请求都错过事务外快查，要求同状态码及收据、只写一次，不能返回 busy / version conflict / SQL 错误；并发同键异内容只有一个成功，另一个为 IDEMPOTENCY_CONFLICT。验证允许根下父子目录注册、symlink 越界和重复挂载身份、版本冲突；用持久化状态夹具验证活动 / 排队 / 待答时归档不改执行投影，实际运行由 S07 / AT32 续验。

**通过**：curl / 协议测试能完成配对→项目→Session→改名→归档→恢复；重启后状态一致；响应和日志没有秘密。

## S06 — worker、工作区调度与恢复

**产物**：apps/server/src/runtime/{manager,scheduler,recovery,ipc}.ts、packages/agent-pi/src/worker.ts、tests/runtime。

**实现**：

1. 实现 SDK wrapper 的独立 Node 进程入口、指定 cwd、workerEpoch、ready / fatal / stopped、心跳与 IPC ACK。
2. 主进程持单实例锁；同 Session 保持一个生成 Run，其他输入走原生路径；不同 Session 默认并行，包括相同工作区。默认无额外 Run / worker 数量上限、空闲回收为 0；运营者可配置容量、回收及工作区串行。可选回收只适用于无活动调用 / 待答操作的 worker，不额外杀已返回的后台服务。
3. 分派前持久化 dispatching；run 结束依据 SDK settle 与真正状态；工具控制不被 await prompt 阻塞。
4. 恢复先检查 target_run_id 再检查 kind；覆盖 queued 活动 prompt 已入库、尚未 IPC 的崩溃，必须 cancelled stale_runtime，不新建 queued Run / 后续成员。分派后未知仍 unknown；封存 Run 及无 Run partial，输入交付不明保留 unknown，关闭失效表单，只暂停已有后续项，不重投旧意图。
5. 实现初次 SDK 映射 ACK 及三种持久状态；合法 header-only / 非 assistant 历史可恢复，损坏文件保留。接入原生替换意图、runtime factory / rebind 交接、目标 worker 占用协调、未认领文件恢复；覆盖 new / switch / fork / import 写文件前后及映射 ACK 前后的崩溃。源与目标事件 / UI 不串 Session，未知替换不盲目重做。
6. 分派前记录 executionScopeKey / PID 等诊断信息，验证旧 epoch 不能写入新状态；已确认仍活着的旧 AgentSession worker 先完成退出，再加载同一 JSONL，不能把 worker PGID 消失当作所有 Bash 已退出。初始化操作事件先提交，initialize 等待表单时继续处理 respond；默认保留已加载扩展内存。故障诊断和可选进程处理按 [部署约定](deployment.md)，不增加清理证明协议。

**验证**：`pnpm verify:S06`；AT13、AT19、AT25 的 Linux 子集。测试同目录多 Session 并行、历史列表不启动 worker、默认已加载状态不因空闲消失；再单独配置容量 / 回收 / 串行验证选项。对真实子进程在分派前后 kill worker / 主进程，旧控制取消、未知命令不重复、旧后续项暂停，新 prompt / 配置可显式继续。配置空 Session 后主动回收；第一条 assistant 前崩溃；文件落盘后 / 标记提交前崩溃；删除、清空或替换持久 JSONL；每个窗口符合持久状态策略。

**通过**：`pnpm test:bash-parity -- --target runtime` 与 `pnpm test:tui-parity -- --target runtime` 覆盖 AT31 / AT32 的生命周期子集：后台服务跨 Run / 可选回收继续，前台长 Bash 不被回收；全阶段操作可等待输入，默认原生资源保持加载。AT25 对未返回 Bash SIGKILL 后保留真实 unknown、不重投旧意图；新明确操作可继续，残留进程由测试 harness 清理。两个主实例不能同时启动。本阶段不要求 Docker。

## S07 — 命令控制与交互表单

**产物**：command handlers、Session 操作锁、agent-pi UI bridge、tests/commands 与 tests/interactions。

**实现**：

1. 接入空闲 prompt、活动输入的 steer / followUp、独立 follow_up 持久队列与原生 extension_command 路径。异常只暂停旧项；cancel_queued / resume_queue 原子完成且校验队列版本；新 prompt 不恢复旧队列。steer / abort 以 targetRunId 定向，respond 按 operationId / epoch 定向，控制通道不等待长调用。
2. 实现模型 / 等级的 expectedVersion、streaming、clamp 与实际值；persist=true 等待 SettingsManager.flush。接入双向标题同步，验证原生 setSessionName、回声、并发及恢复。配置返回和异步 hook 分开，订阅 runner 错误监听，实际配置生效而 hook 失败分别展示。
3. stop / ctx.abort 先捕获并 clearQueue，再 abort；完整未消费输入变可取回草稿，不靠返回字符串猜附件或去重。测试迟到旧输入、停止窗口 crash 与 unknown。compact 按 S02 的原生队列行为等待旧执行实际结束后创建压缩 Run，不额外 clearQueue，不预设旧 Run 必然 aborted。
4. initialize / configure / run / bash / extension 各自支持四类表单、CAS、取消、到期及重连。setThinkingLevel 返回后异步 hook 的子 Operation 继续有效；Run 结束不误关独立表单。操作锁不跨 UI 等待，worker 退出只关闭失效回调。
5. 实现原生资源与 UI 适配、无 Run custom / 用户 Bash / user_bash hook 及 Session 级 abortBash；延迟 custom 交付保持独立 Operation。自主扩展可无 Command，一条命令可顺序产生多个 Run；GET command 返回完整 runs 列表，跨 Session 因果关联只限同 owner。接通 S06 的原生 new / switch / fork / import 回调及后续执行，源时间线不改绑。其他附件 / 导出等按 S02 核实 API 补齐 DTO，不用任意方法反射。

**验证**：`pnpm verify:S07`、`pnpm test:live -- --suite commands` 和 `pnpm test:tui-parity -- --target commands`；AT04、AT05、AT11、AT14、AT15、AT16 及 AT32 控制子集。运行时 steer、切模型 / 等级、扩展命令与 targeted abort；旧 runId 不得停新任务。覆盖旧队列暂停、新 prompt 可用但不恢复旧项、取消最后一项变 ready、过期版本及重启。并发重复 prompt / follow_up / respond 同收据且仅生效一次，复用 S05 竞态 harness。压缩的先停止 / 保留上下文、默认值显式持久化分别验证。session_start / model_select 的表单真正等待、回答后完成；另测 hook 抛错后实际配置校准。

**通过**：SDK 真实配置、压缩、扩展、取消及上述六类补充契约场景有证据；各操作的四类表单、异步 hook、到期 / 重启结果明确。无 Run 内容与并行 Run、标题回声及源 S1→目标 S2 执行不混淆，stop 草稿不重放，compact 与原生对照。运行 / 待答归档继续可用，没有统一 idle 门槛。

## S08 — WSS、断线回放与大输出

**产物**：apps/server/src/realtime、ws-ticket 端点、artifacts 下载、tests/realtime，Node 协议客户端及独立于 Docker 的测试 HTTPS / WSS 入口。

**实现**：

1. 单次设备绑定 ticket、WSS 首帧认证、超时、吊销断连、每会话授权、心跳和订阅上限。
2. 从数据库 tail 事件，消除历史 / 实时交接竞态；snapshot atSeq 与回放配套。
3. 有界发送缓冲、慢消费者 resync、输出替换与 artifact 封存 / 授权，禁止无界内存增长。只处理 SDK 输出的展示副本，手机配额 / 慢连接不裁剪模型结果、不删除原生输出文件、不结束 Bash。
4. GET command 与列表刷新支持丢失 ACK 后恢复；catalog.changed 只作刷新提示。
5. 实现 `pnpm test:serve -- --tls-cert <path> --tls-key <path>` 测试入口供 S10–S11 设备接入，可在 Linux 直接运行 Node。使用有效测试域名证书或两平台已信任的测试 CA，证书私钥留仓库外；不放宽 ATS / cleartext，不依赖 S12 的 Compose / Caddy。生产 TLS 由 S12 交付。

**验证**：`pnpm verify:S08`；AT17、AT20、AT27、AT31 的输出子集。生产事件同时断连和 snapshot，重放连续且一致；慢客户端关闭不影响执行，重连补全。达到 artifact 配额仍保持 Bash 及模型原生输出，后续 Bash 可读 SDK 保留的文件；显示明确截断，越权下载被拒绝。

**通过**：Node 客户端通过测试 HTTPS / WSS 完成真实 SDK 指令→工具→断网→重连；测试入口的证书配置有复现说明。没有未经提交就发出的事件，设备吊销同时影响 HTTP 与已有 WSS。

## S09 — 手机连接、项目和历史

**产物**：apps/mobile 的导航、API client、安全存储、项目 / Session 列表、归档入口、历史分页；tests/mobile 和初始 Maestro 流程。

**实现**：

1. 配对页保存服务器地址与设备凭据，秘密进 Keychain / Keystore；HTTP 错误和失效配对有明确状态。
2. 项目 / Session 列表显示真实 DTO；新建、改名、归档、恢复共用资源 API 和幂等键。
3. 历史使用 snapshot / cursor，当前页读取不创建 worker；断网展示已有缓存，不伪造执行状态。
4. 本地 SQLite 原子保存 reducer 状态与 cursor；账号或后端切换隔离缓存。

**验证**：`pnpm verify:S09`；AT21、AT22 的基础页面部分。Android / iOS JS 构建与组件测试都通过；至少在可用的模拟器上用真实资源 API 完成列表、改名和归档。记录尚未执行的另一端设备测试。

**通过**：页面不依赖硬编码业务数据；凭据不出现在普通缓存或日志。真实双端设备完整通过留到 S11 / S13，不提前勾选。

## S10 — 手机执行时间线、命令与表单

**产物**：移动端 WSS / 退避 / AppState 处理、时间线与工具卡、命令面板、交互表单和运行控制。

**实现**：

1. 接入共享 reducer，按块渲染文本 / thinking，工具累计输出替换，最终消息校准。
2. 顶部模型 / 思考等级、压缩 / 新建 / 改名 / 归档菜单、原生扩展 `/` 面板、steer / follow-up / 停止入口。根据 S02 清单连接附件、用户 Bash 及会话操作入口；以实际能力和 SDK 条件决定状态，不把活动 Run 当作统一禁用条件。
3. 展示所有阶段的 pending 表单、所属操作、到期状态及一次性回答；初始化未 ready 时也可回答，多设备更新可覆盖本地过期操作。
4. 历史阅读不强制滚动、长列表虚拟化、展开工具输出、断网及恢复提示。
5. partial 消息 / 工具显示已中断或结果未知并停止转圈；旧队列显示暂停原因、逐项取消和明确恢复入口，同时保留新输入及配置。用 queueVersion 防过期操作，展示实际环境 / HISTORY_UNAVAILABLE 错误，不扩展到不相关入口。
6. 按 AT31 在两平台展示长 Bash、工具错误后的自动修复、后台服务启动结果及后续访问；服务存活不把已完成工具一直显示成 running，应用不增加每条 Bash 的批准弹窗。
7. 渲染无 Run custom / 用户 Bash，遵循 display / excludeFromContext；独立内容中断后停止转圈。区分用户 Bash 停止与模型 stop，展示可恢复输入含附件及 unknown 草稿，重新发送产生新命令；自主 / 多 Run 和原生会话切换的实际归属可查看。验证重连及 snapshot 后与服务器一致。

**验证**：`pnpm verify:S10`；AT18、AT21、AT22 的执行页面部分及 AT31 / AT32 的手机子集。合成 fixture 与真实后端分别验证；模拟 HTTP 响应丢失保持原幂等键。运行中切模型后等级列表更新，压缩明确展示先停止的行为，全阶段表单不能因断网自动确认。复用整体 TUI / Bash 夹具验证两平台资源、输入、并发、归档、长运行 / 后台服务和断线观察；缺适配明确记录及落实步骤，不静默吞掉入口。真实设备缺失仍记录 not_run。

**通过**：手机能从真实后端发 prompt 并展示工具、配置与交互。模拟器覆盖和真实设备覆盖分别记录。

## S11 — 双端弱网与 Linux 进程故障闭环

**产物**：tests/e2e、Maestro Android / iOS 流程、故障注入 harness 与清洗的设备证据。后端使用 S08 的 Linux Node 测试 HTTPS / WSS 入口，不依赖 S12 镜像或 Compose。

**实现**：

1. 完成开始任务→锁屏→切换网络→重新前台→补事件→steer→表单→结束→恢复旧 Session 的路径。
2. 覆盖 HTTP 请求送达但响应丢失、WSS 回放中断、重复 frame、本地缓存丢失、凭据吊销及同时两部设备操作。
3. 注入 Linux worker / 主进程退出，与手机展示核对 queued / unknown / interrupted、partial 封存、旧队列暂停与失效表单关闭；验证旧命令不自动重放，用户明确发起的新操作可继续，未知结果仍诚实保留。harness 负责临时进程清理，不增加生产清理证明接口。容器退出及恢复属于 S12，组合发布闭环由 S13 验证。

**验证**：`pnpm verify:S11` 加 `pnpm test:device -- --platform android` 和 `pnpm test:device -- --platform ios`；AT18、AT19 的进程故障手机展示子集、AT29。在真实 Android 与 iOS 各执行一次，记录 OS、构建号、后端 commit、模型、TLS 配置及网络切换。正常完成后重启再继续、异常后新操作和旧队列明确恢复分别测试。

**通过**：两端都有真实证据；日志仅保留合成任务内容。任何设备未具备时阶段不能通过，但可继续独立的 S12 部署工作。

## S12 — Linux Docker 与可运维交付

**产物**：deploy/Dockerfile、compose.yaml、TLS 示例、初始化 / doctor / pair / backup / restore CLI、tests/deployment；更新部署文档为实际可用命令，普通启动使用 docker compose up。

**实现**：

1. 多阶段构建、非 root、Linux 工具链、init / 停止宽限、restart policy、单实例锁；项目显式挂载，状态卷持久化。
2. 实现 doctor 检查模型配置、路径、文件权限、Git / bash / Node / Python、SQLite 与模型网络；不打印秘密。
3. 实现 TLS / WSS 路径、配对与设备吊销；生产禁用测试注入接口。
4. 完成停止 / 备份 / 恢复流程，验证新卷恢复；明确操作会终止哪些 Run，保留中断结果。
5. 按 pi 配置加载原生工具、扩展、skills、templates、上下文和用户默认值，提供 HOME / PATH / 缓存 / 网络与项目工具链。无默认并发或回收上限。记录实际残留进程诊断及必要时定向处理 / 容器重启的步骤；不要求启动登记、清理证明或 helper 才可继续工作。

**验证**：`pnpm verify:S12`；AT19 的 Docker 子集、AT23、AT24、AT25、AT28 及 AT31 / AT32 部署子集。干净主机执行 build→docker compose up -d→doctor→配对→真实任务→重建→旧会话→备份→新卷恢复。用 `pnpm test:bash-parity -- --target docker` 和 `pnpm test:tui-parity -- --target docker` 对照同一镜像内原生 pi TUI 的工具、资源、控制与开发环境；后台服务跨 Run / 可选回收继续。未返回 Bash SIGKILL 后保留 unknown、不自动重放旧命令，新明确操作无需清理证明；实际测试容器重启后的进程退出及状态恢复，停止失败如实报告。验证非 root、授权挂载、无 privileged / 默认 Docker socket。

**通过**：部署命令可重现，容器重建不丢历史；TERM / 停止超时 / 并发主实例处理准确，重启影响的其他 Run 也变 interrupted，只有非空旧队列暂停。默认原生资源可用；故障与备份恢复有实际验证，不能只检查文件存在。本阶段不依赖 S11 手机，其 Docker 结果与手机组合在 S13 验收。

## S13 — 发布候选验收

**产物**：docs/release-readiness.md、版本固定信息、完整验收报告与用户安装说明。是否上架商店、发布镜像或打正式 release 由后续任务范围决定，不自动执行外部发布。

**实现**：

1. 汇总 AT01–AT32、FR01–FR14 对应证据，重新运行受变更影响的检查。AT30 是汇总验收，必须先完成 AT01–AT29、AT31 及 AT32 的全部必需子集。
2. 从干净 Linux 后端和干净移动端安装验证真实闭环，不复用仅在开发环境有效的缓存或手工数据库状态。
3. 列出支持范围、已知限制、故障排查、升级与备份恢复说明；更新 README 为实际产品状态。

**验证**：`pnpm verify:S13` 检查所有必需报告存在且通过，然后运行 `pnpm test:e2e`、必要的 live 回归和双端验收；AT30。缺凭据、缺设备、skip 或只有截图但缺关键步骤证据均不能通过。

**通过**：所有 FR 有实际实现与验证，未知调用不会自动重复、断线不丢已提交记录，整体 TUI 与 Bash 的 AT32 / AT31 对照全部通过。原生资源、控制、标准交互与会话入口完成适配，新增限制都有实际依据；不能用永久 needs_adapter 绕过基础能力发布要求。记录实际局限，尚未完成的自定义 TUI 渲染明确列出适配步骤，不禁用其整个扩展，也不声称已完全实现。

## 交给下一位 AI 的启动指令

> 阅读 AGENTS.md 和 docs/progress.md，核对真实文件，从第一个前置条件满足的未完成阶段开始。按本计划实现代码及 verify:Sxx，实际运行验证并记录证据；遇到外部模型或设备条件缺失，记录未运行并继续可独立的阶段，不用模拟结果替代真实验收。保持公共仓库中不包含运行数据与凭据。

## 验收入口的执行规则（2026-09-18）

S02、S06、S07、S08、S12 的 live / parity 检查读取先行执行的完整报告，S13 汇总时不重复触发付费调用。实际入口、逐项清单和原生对照采集见[验收入口说明](acceptance-runners.md)。S12 的 Docker 生命周期子集可用 `--deployment-only` 在 CI 执行，但不替代本计划的完整原生对照条件。源码变更后重新运行受影响检查，最终发布须针对同一源码版本重新汇总。
