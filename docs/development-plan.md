# 分步骤开发计划

状态：执行规格，S01–S13 尚未实施。每一步的命令由该步实现；当前仅 `python3 scripts/check_docs.py` 可运行。不要把下面的命令复制进 README 当作已有产品使用说明。

先读 [架构](v1-design.md)、[协议](protocol-v1.md)、[数据](data-model.md)与[验收矩阵](acceptance.md)。阶段通过后在 [progress.md](progress.md) 保存真实证据，再继续下一个前置条件满足的阶段。

## 0. 通用完成条件

每阶段交付实际文件、相应 `pnpm verify:Sxx` 脚本、可重复测试和清洗后的验证摘要。脚本在未实现、配置缺失、断言失败或必需证据缺失时非零退出；不以空测试、无条件 skip 或打印 success 充当验证。

实现变更运行本阶段验证及受影响的回归。所有阶段都保持 `pnpm lint`、`pnpm typecheck`、`pnpm build` 可通过；S01 之前这些命令尚不存在。真实 SDK / 设备测试单独标记，公共 CI 不要求秘密凭据，也不能将缺少这些测试视为完整发布通过。

跨阶段验收项按本阶段列出的实现和环境验证子集，并在报告中写清范围；只有所有子集都验证后才能把整项 AT 标为 passed。S13 负责检查完整矩阵。不要让尚待后续实现的功能成为前置阶段的循环依赖。

测试数据只放临时项目。模型测试使用运营者配置的专用 provider / model，凭据放仓库外；至少准备两个可用模型，其中一个能返回 thinking。为 live 脚本设置请求数和 token / 时间上限，超过限制失败，不无限重试。iOS JS 打包可以在 Linux 做，原生构建 / 模拟器需要 macOS 或云构建，最终还需真实 iOS 设备。

| 阶段 | 前置 | 核心交付 | 验收 ID |
| --- | --- | --- | --- |
| S01 | 无 | 工程、依赖、基础 CI | AT01 |
| S02 | S01 | 固定版本真实 SDK 验证和适配器边界 | AT02, AT03, AT26 |
| S03 | S01 | DTO / schema / 纯事件 reducer | AT06 |
| S04 | S03 | 迁移、事件日志、投影与快照 | AT07, AT08 |
| S05 | S04 | 鉴权、项目与 Session 资源 API | AT09, AT10, AT11, AT12 |
| S06 | S02, S04, S05 | worker、调度、崩溃恢复 | AT13, AT19, AT25 |
| S07 | S05, S06 | 执行命令、模型、压缩与表单 | AT04, AT05, AT14, AT15, AT16 |
| S08 | S04, S05, S07 | WSS 与可靠回放、大输出 | AT17, AT20, AT27 |
| S09 | S03, S05 | 手机配对、项目、列表、历史 | AT21, AT22 |
| S10 | S07, S08, S09 | 手机流式时间线、命令和表单 | AT18, AT21, AT22 |
| S11 | S10 | 弱网、故障与双端完整闭环 | AT18, AT19, AT29 |
| S12 | S08 | Docker、权限、部署、备份 | AT23, AT24, AT25, AT28 |
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

**产物**：packages/agent-pi/src 的最小 SDK 包装、测试 CLI、tests/sdk、docs/sdk-verification.md；需要时修正已发现的 SDK 文档差异。

**实现**：

1. 创建一次性 Linux 项目目录，在指定 agentDir / sessionDir 创建 Session，绑定事件后发 prompt；记录 SDK 返回的 sessionId / file。
2. 验证文本、thinking、工具参数、累计结果、最终消息、preflight、agent_end / agent_settled 的时序。
3. 关闭再从同一文件恢复；验证模型、思考等级、标题及上下文，确认不会错误使用 recent session。
4. 验证 setModel、getAvailableThinkingLevels、setThinkingLevel、compact、abortCompaction、steer、abort 和 bindExtensions 的实际签名与语义。
5. 用应用提供的 extension 触发四种表单；核实 headless 模式、项目 trust / loader 行为和禁用自动项目扩展的方法，记录已验证配置。

**验证**：`pnpm verify:S02` 执行无需网络的边界验证；`pnpm test:live -- --suite sdk` 执行真实模型与工具验证。使用受限 bash 脚本输出两行并编辑临时文件，检查真实文件和 session JSONL；模拟 provider 失败验证重试事件，再用真实 provider 完成至少一次流程。

**通过**：AT02、AT03、AT26 都有对应证据；负例包括无模型凭据、不支持的等级和不存在的会话文件。真实请求缺失时阶段不通过，不能只保留一个 mock demo。

## S03 — 公共协议、规范事件与 reducer

**产物**：packages/protocol/src/{http,commands,events,state,reducer}.ts、tests/protocol，消费现有合成 fixture。

**实现**：

1. 将 protocol-v1 的所有请求、响应、错误、内容块、事件和 Snapshot 定义为可运行 schema，导出 DTO。
2. 编写纯函数 reducer：事件序号、消息块、工具快照、Run / command / queue / interaction 状态；不依赖 React、数据库或 SDK。
3. 明确最终消息校准、工具累计替换、工具参数暂存、重复和缺口处理；数据版本错误必须可见。
4. 将合成事件扩展到正常、重试、压缩、等待输入、截断、未知提示和错误状态，给出预期最终状态。

**验证**：`pnpm verify:S03`；AT06。按正常、重复、断批再重放的方式应用同一事件，最终状态相同；把 seq 3 跳到 5 时停止应用而非悄悄成功。工具输出两次累计快照最终只能包含一份第一行。

**通过**：服务端与 App 可共用同一 reducer；不导出 pi 类型。超长输入、错误参数类型、未知核心事件及非法状态都有失败断言。

## S04 — SQLite 迁移、事件与投影

**产物**：apps/server/src/storage/{migrations,repositories,event-store,snapshot}.ts，基于参考 SQL 的初始迁移，tests/storage。

**实现**：

1. 版本化安装 schema，开启连接 PRAGMA，创建 owner；重复启动不重复写初始数据。
2. 实现命令收据、seq 分配、事件 / live_state / timeline / Run 状态的单事务更新，按 epoch + batchNo 去重。
3. 实现 snapshot 读事务、完成历史分页及固定 atSeq 边界；cursor 防篡改并绑定 Session。
4. 实现 artifact 封存元数据、路径校验及失败后的临时文件清理。

**验证**：`pnpm verify:S04`；AT07、AT08。使用真实临时 SQLite 文件而非全内存 stub，注入事务中途异常，确认事件、seq、投影全部回滚。重开数据库重放事件得到同样状态。快照取 S 后完成一个旧 partial，再分页旧历史，验证没有漏项或重复。

**通过**：复合 FK、幂等键、一个活动 Run 约束有实际验证；rollback 不产生已广播事件，正常提交可被再次打开读取。性能测试不放真实项目数据。

## S05 — 设备、项目与 Session API

**产物**：apps/server/src/{auth,routes,services}、配对 CLI、tests/api。

**实现**：

1. 管理 CLI 生成短期配对 token，HTTP 原子消费，设备凭据只存摘要；实现 me、devices、吊销和限流。
2. 项目 realpath、允许根、读写能力、根 identity 和 git common dir 检测；实现注册、列表和默认配置更新。
3. 实现 Session 新建、改名、归档 / 恢复、版本冲突，snapshot / history / events 查询；未加载的 Session 不启动模型。
4. 所有持久变更采用统一幂等收据，验证归属后重放原响应。未实现的执行能力不在 capabilities 中宣称可用。

**验证**：`pnpm verify:S05`；AT09、AT10、AT11、AT12。并发复用配对 token 只能成功一次；跨用户构造测试资源必须 404；同键同内容创建只得一个资源，同键异内容 409。验证 symlink、祖先目录、重复挂载身份、版本冲突和归档后的写入拒绝。

**通过**：curl / 协议测试能完成配对→项目→Session→改名→归档→恢复；重启后状态一致；响应和日志没有秘密。

## S06 — worker、工作区调度与恢复

**产物**：apps/server/src/runtime/{manager,scheduler,recovery,ipc}.ts、packages/agent-pi/src/worker.ts、tests/runtime。

**实现**：

1. 实现 SDK wrapper 的独立 Node 进程入口、指定 cwd、workerEpoch、ready / fatal / stopped、心跳与 IPC ACK。
2. 主进程持单实例锁；按 workspaceKey 和 Session 调度，限制 2 个活动 Run、4 个已加载 worker，空闲回收。
3. 分派前持久化 dispatching；run 结束依据 SDK settle 与真正状态；工具控制不被 await prompt 阻塞。
4. 完成启动恢复、旧 epoch 拒绝、queued 与 unknown 区分，以及停止未确认时工作区 blocked。

**验证**：`pnpm verify:S06`；AT13、AT19、AT25。测试同目录两 Session 串行、不同目录并行、容量满排队、公平性和空闲回收。使用真实子进程 kill worker / 主进程，在分派前后多个窗口重启；没有第二个 writer，也不重复未知命令。

**通过**：确认传统子进程清理，测试停止长运行 bash 及其子进程；无法清理的模拟情形必须 blocked。两个主实例不能同时启动。不得以只修改数据库状态代替停止工具。

## S07 — 命令控制与交互表单

**产物**：command handlers、Session 操作锁、agent-pi UI bridge、tests/commands 与 tests/interactions。

**实现**：

1. 接入 prompt / follow_up 的持久队列；steer / abort / respond 独立控制通道，检查 targetRunId。
2. 实现模型 / 等级配置的 expectedVersion、空闲校验、有效值回传和跨会话隔离；标题版本单向同步。
3. 实现 compact Run、进度 / 结果 / 取消、历史太短与繁忙的错误处理。
4. 四种 UI 请求持久化、等待、回答 CAS、取消、到期、worker 退出及重新连接恢复。

**验证**：`pnpm verify:S07`，以及 `pnpm test:live -- --suite commands`；AT04、AT05、AT14、AT15、AT16。任务运行时发 steer，然后发 targeted abort；用旧 runId 再发 abort 不得停新任务。重复 follow-up / respond 仅生效一次。压缩后原历史可浏览，新 prompt 使用保留上下文；一次设置不能改变别的 Session。

**通过**：SDK 真实模型切换、压缩和取消有证据；四种表单正反例及到期 / 重启有确定结果；归档与繁忙检查在同一操作锁内无竞态。

## S08 — WSS、断线回放与大输出

**产物**：apps/server/src/realtime、ws-ticket 端点、artifacts 下载、tests/realtime，Node 协议客户端。

**实现**：

1. 单次设备绑定 ticket、WSS 首帧认证、超时、吊销断连、每会话授权、心跳和订阅上限。
2. 从数据库 tail 事件，消除历史 / 实时交接竞态；snapshot atSeq 与回放配套。
3. 有界发送缓冲、慢消费者 resync、输出替换与 artifact 封存 / 授权，禁止无界内存增长。
4. GET command 与列表刷新支持丢失 ACK 后恢复；catalog.changed 只作刷新提示。

**验证**：`pnpm verify:S08`；AT17、AT20、AT27。生产事件同时反复断连和 snapshot，重放必须连续且一致；让客户端读取暂停，服务继续执行并关闭慢连接，重连补全。大输出达到边界有截断 / 资源引用，越权读取被拒绝。

**通过**：Node 客户端完成真实 SDK 指令→工具→断网→重连；没有未经提交就发出的事件，设备吊销同时影响 HTTP 与已有 WSS。

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
2. 顶部模型 / 思考等级、压缩 / 新建 / 改名 / 归档菜单、`/` 面板、steer / follow-up / 停止入口。
3. 展示 pending 表单、到期状态及一次性回答；多设备更新可覆盖本地过期操作。
4. 历史阅读不强制滚动、长列表虚拟化、展开工具输出、断网及恢复提示。

**验证**：`pnpm verify:S10`；AT18、AT21、AT22 的执行页面部分。合成 fixture 与真实后端分别验证；模拟 HTTP 响应丢失保持原幂等键。切换模型后等级列表更新，busy 命令不可误发，表单不能因断网自动确认。

**通过**：手机能从真实后端发 prompt 并展示工具、配置与交互。模拟器覆盖和真实设备覆盖分别记录。

## S11 — 弱网与双端故障闭环

**产物**：tests/e2e、Maestro Android / iOS 流程、故障注入 harness 与清洗的设备证据。

**实现**：

1. 完成开始任务→锁屏→切换网络→重新前台→补事件→steer→表单→结束→恢复旧 Session 的路径。
2. 覆盖 HTTP 请求送达但响应丢失、WSS 回放中断、重复 frame、本地缓存丢失、凭据吊销及同时两部设备操作。
3. 注入 worker / 容器退出，与手机展示核对 queued / unknown / interrupted；不以“连接成功”替代正确状态。

**验证**：`pnpm verify:S11` 加 `pnpm test:device -- --platform android` 和 `pnpm test:device -- --platform ios`；AT18、AT19、AT29。在真实 Android 与 iOS 设备各执行一次，记录 OS、构建号、后端 commit、模型及网络切换过程。

**通过**：两端都有真实证据；日志仅保留合成任务内容。任何设备未具备时阶段不能通过，但可继续独立的 S12 部署工作。

## S12 — Linux Docker 与可运维交付

**产物**：deploy/Dockerfile、compose.yaml、TLS 示例、初始化 / doctor / pair / backup / restore CLI、tests/deployment；更新部署文档为实际可用命令。

**实现**：

1. 多阶段构建、非 root、Linux 工具链、init / 停止宽限、restart policy、单实例锁；项目显式挂载，状态卷持久化。
2. 实现 doctor 检查模型配置、路径、文件权限、Git / bash / Node / Python、SQLite 与模型网络；不打印秘密。
3. 实现 TLS / WSS 路径、配对与设备吊销；生产禁用测试注入接口。
4. 完成停止 / 备份 / 恢复流程，验证新卷恢复；明确操作会终止哪些 Run，保留中断结果。

**验证**：`pnpm verify:S12`；AT23、AT24、AT25、AT28。在干净 Linux Docker 主机执行 build→doctor→配对→真实任务→重建容器→继续旧会话→备份→新卷恢复。验证非 root 文件归属、只挂授权目录、不使用 privileged / Docker socket。

**通过**：部署命令能从干净 checkout 重现；app 容器删除重建不丢历史；TERM / 超时 / 并发主实例处理准确；恢复有真实验证，不能只检查备份文件存在。

## S13 — 发布候选验收

**产物**：docs/release-readiness.md、版本固定信息、完整验收报告与用户安装说明。是否上架商店、发布镜像或打正式 release 由后续任务范围决定，不自动执行外部发布。

**实现**：

1. 汇总 AT01–AT30、FR01–FR12 对应证据，重新运行受变更影响的检查。
2. 从干净 Linux 后端和干净移动端安装验证真实闭环，不复用仅在开发环境有效的缓存或手工数据库状态。
3. 列出支持范围、已知限制、故障排查、升级与备份恢复说明；更新 README 为实际产品状态。

**验证**：`pnpm verify:S13` 检查所有必需报告存在且通过，然后运行 `pnpm test:e2e`、必要的 live 回归和双端验收；AT30。缺凭据、缺设备、skip 或只有截图但缺关键步骤证据均不能通过。

**通过**：所有 FR 有实际实现与对应验证，没有未知 writer、自动重复副作用、断线丢消息等未解决问题。记录实际风险和局限，不能声称提供 V1 未实现的多租户隔离或任意 TUI 支持。

## 交给下一位 AI 的启动指令

> 阅读 AGENTS.md 和 docs/progress.md，核对真实文件，从第一个前置条件满足的未完成阶段开始。按本计划实现代码及 verify:Sxx，实际运行验证并记录证据；遇到外部模型或设备条件缺失，记录未运行并继续可独立的阶段，不用模拟结果替代真实验收。保持公共仓库中不包含运行数据与凭据。
