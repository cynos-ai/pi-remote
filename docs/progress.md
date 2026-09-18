# 开发进度与验证证据

最后更新：2026-09-17。

## 当前状态

S01–S12 已有实际工程实现。S01 的干净 Linux checkout 验证通过；S02 的真实 SDK contract smoke 通过，但真实模型、thinking、原生 TUI 和完整 parity 仍缺外部条件，因此保持 `blocked`；S03 的公共 schema、S04 的 SQLite 存储 contract 及 S05 的鉴权 / 资源 API 均已通过验证。S06 的 worker、调度与恢复已实现，但原生 TUI / live provider 对照仍待真实条件；S07 的命令控制与全阶段交互桥接已实现并完成可重复契约测试，真实 provider / 原生 TUI 对照仍待外部条件，因此保持 `blocked`。S08 的 WSS / HTTPS 回放、S09 的移动端本地验证和 S10 的移动端实时/执行页面合同验证已完成；S11 的双设备和弱网合同测试已完成；2026-09-15 另补实际 server / worker 进程故障集成测试；S12 的 Docker 交付也已通过完整 WSL 生命周期验证。S13 的发布就绪检查入口已补齐，但真实 provider、原生 TUI 和 Android / iOS 实机尚未运行，因此保持 `blocked`。参考 SQL 和尚未接入的示例事件不代表已经部署的业务功能。

已完成一轮[独立设计评审与修订](reviews/2026-09-12-design-review.md)：当时的 7 项发现已修订；后续用户要求已替换其中的预先限制，历史审核结论不能代替当前版本的验证。

随后增加 [Bash 兼容约束](bash-compatibility.md)，本轮再扩展为[整体 TUI 体验原则](tui-experience.md)：覆盖工具、资源、扩展、控制、会话和全阶段交互，只有实际问题或用户配置才增加局部限制。当前共 FR01–FR14、AT01–AT32 及两套各 8 项对照场景；S07 已进入实现完成、真实对照阻塞状态。

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| S01 | passed | Linux 冻结安装、lint、typecheck、单测、构建、Android / iOS JS bundle、healthz |
| S02 | blocked | SDK contract smoke 与能力清单通过；真实模型、thinking、原生 TUI / 完整 parity 未运行 |
| S03 | passed | 公共 DTO/schema、正常/异常/无 Run/native fixture reducer 与序号边界测试 |
| S04 | passed | SQLite 迁移、事件事务、live projection、快照和历史分页 |
| S05 | passed | 鉴权、项目和会话 API |
| S06 | blocked | worker、调度与恢复合同测试通过；原生 TUI / live provider 对照未运行 |
| S07 | blocked | 命令和交互桥接合同已实现并测试；live provider / 原生 TUI 对照未运行 |
| S08 | blocked | WSS、快照及断线回放合同与 HTTPS smoke 通过；live provider / 原生 TUI 未运行 |
| S09 | blocked | 移动端配对、资源列表、归档、历史与本地缓存实现；真实 Android / iOS 设备未运行 |
| S10 | blocked | 移动端实时、时间线、命令与表单已实现；真实 Android / iOS 流程未运行 |
| S11 | blocked | 双设备/弱网合同与实际 server/worker 进程故障集成通过；真实 Android / iOS 设备未运行 |
| S12 | passed | WSL Docker 镜像、非 root 开发环境、项目挂载、HTTPS/WSS、配对、重建持久化、备份与新卷恢复 |
| S13 | blocked | 发布就绪检查已实现；真实 provider、原生 TUI、Android / iOS 实机及完整验收未运行 |

## 2026-09-15 代码审核修复

基于 `12994b3cafacb06b0cdd30339987db942305e10c` 的既有未提交实现，修复 R01–R16 并补真实 SDK/进程回归；没有提交或推送。逐项实现、测试与保留边界见[修复记录](reviews/2026-09-15-code-review-fixes.md)。

环境为 WSL/Linux、Node 24.19.0、pnpm 10.28.0、pi SDK 0.85.1。包含并发替换与跨目录切换补充修复的最终全量单元测试：24 文件 / 170 测试通过。全量 typecheck、lint、server 构建、Android/iOS/web JS export、文档检查全部通过，详细命令与证据统一记录在修复记录中。

`node scripts/test-real-process-e2e.mjs --no-build` 在所有补充修复后的最终构建复验 9 passed、0 failed、0 skipped，80.06 秒。使用实际生产 server/worker、SQLite/JSONL、HTTPS/WSS、原生 SDK 工具与 Bash，通过本地 HTTP 模型端点提供确定性响应，从进程外部 SIGKILL 并重启。证据在 `test-results/code-review/r16-final-real-process.log` 与 `r16-runtime-manifest.json`；旧失败日志仅作修复过程记录。这些测试补齐本地可完成的真实进程覆盖，不替代真实运营者 provider、原生 TUI、Docker 或设备验收。

修复保持原生工具、Bash、扩展、无命令自主活动和会话操作；没有增加命令过滤、审批、默认执行超时或路径执行沙箱。阶段 blocked / not_started 的外部条件未因此移除。

## S01–S12 应用实现证据

### S01

在干净 Linux checkout 使用 Node `v24.19.0`、pnpm `10.28.0`、SDK `0.85.1` 运行 `pnpm verify:S01`，冻结安装、lint、typecheck、9 个单测、server / package build、Android / iOS JS bundle 及 `/healthz` 均通过。该阶段不包含 Android / iOS 真机验收。清洗后的机器报告为 `test-results/s01/report.json`（详细运行数据不提交）。

### S02

在 WSL Linux 使用同一 Node / pnpm / SDK 运行 `pnpm verify:S02`：S02-01 至 S02-05、能力清单和 SDK 包构建通过；`pnpm test:bash-parity -- --target sdk` 的确定性 SDK 与 `/bin/bash` smoke 通过。`pnpm test:tui-parity -- --target sdk` 以及 `pnpm test:live -- --suite sdk` 因没有真实 TUI / 运营者模型配置未运行，阶段保持 `blocked`。完整清洗说明见 [sdk-verification.md](sdk-verification.md) 和 [native-capabilities.md](native-capabilities.md)。

### S03

实现 `packages/protocol/src/{http,commands,events,state,reducer}.ts`，协议包直接依赖 `zod@4.6.2`，不依赖 pi SDK。`pnpm verify:S03` 与全仓 `pnpm run lint`、`pnpm run typecheck`、`pnpm run test:unit` 均通过；当前 S03 共 9 个单测，覆盖正常流、异常封存、无 Run 初始化、跨 Session 原生事件、累计工具快照、重复事件和序号缺口。S03 只验证公共契约与合成 fixture，不代表 SQLite / API / worker 已实现。

本轮约定的 npm、Docker 镜像及 CI 国内源记录在 [.npmrc](../.npmrc)、[engineering-baseline.md](engineering-baseline.md)、[deployment.md](deployment.md) 和 [.github/workflows/ci.yml](../.github/workflows/ci.yml)；后续阶段沿用，不把源地址写入凭据或运行数据。

### S04

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0` 和 Node 内置 `node:sqlite` 运行 `pnpm verify:S04`，迁移脚本、server build、15 个单测、lint、typecheck、文档检查及构建产物迁移文件均通过。`tests/storage/storage.test.ts` 使用真实临时 SQLite 文件覆盖 WAL / foreign key / synchronous / busy timeout、重复启动、按 Session 分配连续 seq、`workerEpoch + batchNo` 幂等及冲突、迟写失败全事务回滚、正常与 partial 封存、无 Run interaction / custom / Bash、SDK 输入附件恢复、固定 `atSeq` 历史分页与 cursor 防篡改、同 owner 跨 Session 因果及跨 owner 拒绝、Session live projection 和 artifact 相对路径校验。报告写入 `test-results/s04/report.json`（该目录不提交）。

S04 的标题同步已先落下 durable metadataSync 水位；source/echo intent 的真实手机与 SDK hook 交错路径由 S07 接续验证。artifact 本阶段验证元数据和路径安全，原子大文件封存与下载授权由后续 artifact API 阶段完成。

### S05

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0` 和固定 SDK `0.85.1` 运行 `pnpm verify:S05`，S05 文件检查、server build、18 个单测、lint、全量 typecheck 和文档检查均通过。`apps/server/src/auth.ts` 提供单 owner 配对 token 原子消费、设备摘要凭据、Bearer 鉴权、设备列表 / 吊销和内存限流；`routes.ts` 接入 `/v1/pair`、me、devices、capabilities、models、projects、sessions、snapshot、history、events 和 command 查询。项目注册使用 realpath、允许根、读写权限、dev/inode identity、Git common dir 和 keyset cursor；父子目录可分别注册，symlink 越界被拒绝。项目 / Session 资源变更写入统一 command 收据，事务内再次检查幂等键，PATCH 使用 expectedVersion，Session 元数据更新通过 `session.updated` 事件持久化；归档只改元数据，重开 SQLite 后状态保持一致。报告写入 `test-results/s05/report.json`（该目录不提交）。

S05 的覆盖范围是临时真实 SQLite 文件和 Fastify 注入 API；已验证单次配对、吊销失效、跨 owner 404、路径边界、重复真实目录、父子目录、分页、CAS、归档 / snapshot / history / events、重启恢复及并发同键创建。真实 HTTPS / WSS、worker 执行、模型、设备和 artifact 下载仍由后续阶段验证；未实现的执行命令没有在 capabilities 中宣称可用。

### S06

实现 `apps/server/src/runtime/{ipc,scheduler,recovery,manager}.ts` 与 `packages/agent-pi/src/worker.ts`：worker 使用独立 Node 进程、固定 cwd、workerEpoch、映射 ACK、ready / fatal / stopped、心跳、事件 batch ACK；主进程提供同 Session 单 Run、不同 Session 默认并行、可选工作区串行 / 容量 / 空闲回收、单实例锁和旧 epoch 防写。恢复先检查 `target_run_id`，区分 IPC 前的 `STALE_RUNTIME` 与分派后的 `UNKNOWN_RUNTIME`，封存活动 Run、关闭失效交互并暂停已有后续项，不自动重投未知命令；同时覆盖首次映射的 `uninitialized` / `unflushed` / `persisted` 状态和合法 header-only / 非 assistant 历史。

在 WSL 2 Linux 使用 Node `v24.19.0`、pnpm `10.28.0`、固定 SDK `0.85.1`，并将 npm / Docker 配置分别设为 `https://registry.npmmirror.com` / `docker.m.daocloud.io`，运行 `pnpm verify:S06`：6 个文件检查、server build、15 个 runtime 测试、lint、全量 typecheck 和文档检查均通过，报告为 `test-results/s06/report.json`（默认不提交）。测试覆盖 IPC framing / ACK、映射边界、同目录 Session 并行、调度选项、活动调用与待答保护、worker 崩溃恢复、旧 target prompt stale、未知分派结果、旧 epoch、陈旧锁及单实例锁。

S06 报告状态为 `blocked`：AT31 / AT32 的真实 provider、原生 pi TUI 和真实 SIGKILL / Bash 进程组对照尚未提供，不能用合成测试替代。为保持 WSL 工具链可复现，本次 Node 与 pnpm Linux 二进制均从 npmmirror 获取；验收脚本同时修正了 Windows Node interop 下的 Python 命令选择。下一步是 S07 命令与交互桥接，并继续保留这些真实对照为未运行。

### S07

实现 `apps/server/src/services/commands.ts`、`apps/server/src/runtime/manager.ts` 与 `packages/agent-pi/src/worker.ts` 的命令 / 控制 / 交互桥接：空闲 prompt、steer / follow-up、持久 follow-up 队列、targeted abort / respond、配置 CAS 与实际配置回传、原生扩展命令、Bash / user_bash、compact 的先停止路径，以及 initialize / configure / run / bash / extension 五类 Operation 的 select / confirm / input / editor 表单。worker 用 `AsyncLocalStorage` 保留 operationId、runId、origin 和 workerEpoch 归属；异步 thinking hook 不会因方法返回而提前结束 configure Operation。命令终态投影和后续 `command_result` 幂等合并，控制命令不会误结束目标模型 Run；排队 Run 与当前执行 Run 可并存。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0`、固定 SDK `0.85.1`，并沿用 npm `https://registry.npmmirror.com`、Docker 镜像前缀 `docker.m.daocloud.io`，运行 `pnpm verify:S07`：S07 文件检查、server build、命令合同测试、交互合同测试、lint、全量 typecheck 和文档检查均记录到 `test-results/s07/report.json`（默认不提交）。当前合同测试覆盖 4 个命令场景与 23 个交互场景；全仓单测结果为 7 个测试文件、60 个测试通过。测试包含重复 prompt / follow-up / form answer、配置版本和实际 clamp、旧 targetRun 控制、队列取消 / pump、四种表单、空 Run Operation、取消 / 超时 / 重复回答及 setThinkingLevel 异步 hook。

S07 报告状态为 `blocked`：可重复测试使用 fake SDK handle / worker transport，只证明应用契约与归属边界，不等于真实模型 streaming、原生 pi TUI、真实 compact / extension / abort 对照。`pnpm test:live -- --suite commands` 与 `pnpm test:tui-parity -- --target commands` 因缺少运营者模型配置和真实 Linux TUI baseline 保持 `not_run`，不能伪造为通过；真实 Bash / 进程组故障对照仍由 S06 / S12 继续完成。下一步是 S08 WSS、断线回放与大输出。

### S08

实现 `apps/server/src/realtime/{hub,tickets,artifacts}.ts` 与 `scripts/test-serve.mjs`：HTTPS / WSS 入口使用一次性 HTTP ticket 和 `pi-remote.v1` 子协议，订阅按 Session 校验，基于已提交 seq 回放并继续 tail；断线从 cursor 补读，过高 cursor、设备吊销、慢消费者和 4 MiB 缓冲上限都有明确处理。大输出保留有界展示副本并支持 artifact Range 下载，不能借展示配额修改 SDK 原始输出。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0`，并沿用 npm `https://registry.npmmirror.com`、Docker 镜像前缀 `docker.m.daocloud.io`，运行 `pnpm verify:S08`：WSS 合同测试、HTTPS 自签名 TLS `/healthz` smoke、server / mobile 全构建、lint、全仓 typecheck 和文档检查通过，报告写入 `test-results/s08/report.json`（默认不提交）。HTTPS smoke 在 WSL 冷启动时会等待 SDK ESM 导入完成；验证脚本已将启动窗口设为 60 秒并直接管理实际 server 子进程，避免 pnpm wrapper 留下孤儿进程。

S08 报告状态为 `blocked`：确定性 WSS / artifact 测试不替代真实 provider streaming；`pnpm test:live -- --suite realtime` 和 `pnpm test:tui-parity -- --target realtime` 为 `not_run`，因为没有运营者模型凭据和真实 Linux pi TUI baseline。设备吊销、cursor 回放和 HTTPS 入口已具备 S09/S11 使用的基础，但真实手机链路留在后续设备阶段。

### S09

实现 `apps/mobile/App.tsx` 及 `apps/mobile/src/{api,storage,app-model}`：配对页严格要求 HTTPS，设备凭据通过 Expo SecureStore 进入 Keychain / Keystore；项目与 Session 页面使用真实协议 DTO，支持分页、去重、新建、改名、归档 / 恢复；历史页先读取 snapshot，再按 cursor 加载历史。Expo SQLite 使用 WAL 和 `(account_key, resource_key)` 复合隔离键，在同一事务中保存 payload 与 cursor，断网时只展示已有缓存，不伪造运行状态。补充 `tests/mobile`、Expo SQLite web WASM Metro 配置和 `.maestro/s09-resources.yaml`。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0`，运行 `pnpm verify:S09`：13 个移动端合同 / view-model / SQLite 测试、协议构建、Android / iOS JS bundle、lint、全仓 typecheck 和文档检查通过，报告写入 `test-results/s09/report.json`（默认不提交）。另验证 `pnpm run build:mobile` 的 Android / iOS / web export；web 导出包含 Expo SQLite WASM 资产。

S09 报告状态为 `blocked`：当前 WSL 没有 `adb`、Android 模拟器、Maestro 或 Xcode / iOS 模拟器，因此真实资源 API 的配对→列表→改名→归档 / 恢复流程为 `not_run`。JS bundle 与 fake fetch 测试不能替代 AT21 / AT22 的真实设备证据；下一步应在可用 Android 模拟器或真机上运行 Maestro 流程，再补 iOS Keychain / 后台恢复。

### S10

实现 `apps/mobile/src/realtime.ts`、`apps/mobile/src/session-model.ts` 及执行页面：移动端通过 HTTPS 换取一次性 WSS ticket，使用 `pi-remote.v1` 订阅指定 Session；按持久 cursor 去重，缺口或 `resync_required` 先刷新快照，断线采用 1–30 秒有界抖动退避，AppState 回到前台立即重连。事件只有在 reducer / 本地快照缓存回调完成后才推进 cursor，缓存继续以账号隔离并原子保存 payload/cursor。

执行页接入共享 reducer，合并历史、snapshot 与 liveItems，分块显示文本 / thinking、累计工具输出、工具参数、partial / unknown / 截断状态和 Operation / Run 归属；提供模型 / thinking 配置、compact、新建 / 改名 / 归档、prompt / steer / follow-up、用户 Bash、扩展 slash、模型停止、Bash 停止、队列逐项取消 / 恢复和 initialize / configure / run / bash / extension 的 select / confirm / input / editor 表单。HTTP 命令响应丢失时用同一幂等键自动重试；恢复输入只填回草稿，不自动重放。附件现在通过 Expo 系统文件选择器选择图片，经 `POST /v1/sessions/:id/artifacts` 上传并绑定当前 Session 后再提交；已有 artifact ID 的兼容入口仍保留。真机仍需验证权限、弱网和后台恢复。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0` 运行 `pnpm verify:S10`：18 个移动端测试、协议构建、Android / iOS JS bundle、lint、全量 typecheck 和文档检查通过；报告为 `test-results/s10/report.json`（默认不提交）。报告中 S10 Android / iOS 设备检查为 `not_run`，因为当前 WSL 没有可用的 Android 设备 / 模拟器或 Xcode / iOS 模拟器；fake WebSocket、JS export 和合同测试不替代真实 provider 或设备证据，因此阶段保持 `blocked`。下一步是 S11 的真实双端弱网、后台恢复与 Linux 进程故障闭环；S12 Docker 工作可独立推进。

### S11

实现 `tests/e2e/{harness,s11-weak-network,s11-recovery,s11-dual-device}`、`scripts/test-device.mjs`、`scripts/verify-s11.mjs` 及 `.maestro/s11-recovery-{android,ios}.yaml`。最初夹具使用临时真实 SQLite、Fastify/WSS、确定性移动 WebSocket 和 Linux timer 替身进程 `SIGKILL`，恢复状态由测试构造；该版本只能证明恢复投影合同，不能证明实际应用进程恢复。2026-09-15 已移除 timer 替身，另外增加实际 server/worker 集成，见下方修复记录；生产服务没有增加远程 kill 或调试清理接口。覆盖重复 frame、seq 缺口 snapshot resync、缓存丢失、AppState 前后台重连、worker / 主进程故障后的 interrupted / partial / unknown、待答关闭、草稿保留、旧队列暂停、新操作继续、HTTP 响应丢失幂等、双设备事件流、CAS 改名、WSS 回放和设备吊销。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0`，并沿用 npm `https://registry.npmmirror.com`、Docker 镜像前缀 `docker.m.daocloud.io`，运行 `pnpm verify:S11`：文件检查、协议 / server build、4 个 E2E 测试、Android / iOS JavaScript bundle、lint、全量 typecheck 和文档检查通过。`pnpm test:device -- --platform android` 与 `pnpm test:device -- --platform ios` 均诚实记录为 `not_run`：当前没有真实设备流程配置，且 WSL 没有可用 Android / iOS 设备；不会把缺失设备转换成通过。清洗报告写入 `test-results/s11/report.json`（默认不提交）。

设备 runner 仅在检测到 Maestro、已授权在线 Android 设备或已启动 iOS Simulator、设备可访问的 HTTPS 后端、一次性配对令牌和合成 prompt / steer 后执行对应 Maestro 流程；网络切换、锁屏和 Linux 故障注入保留为真实设备流程中的人工观察点，失败或前置条件不足均保留原状态。该阶段原始报告的“Linux 进程”结果应按上述合同范围理解；真实应用进程证据由 2026-09-15 补充，真实双端证据仍待具备设备后补充；下一步为 S12 Docker 与可运维交付。

### S12

实现 `deploy/Dockerfile`、`deploy/compose.yaml`、TLS Caddy 入口、非 root Linux 工具链、部署初始化 / doctor / pair / maintenance / backup / restore CLI，以及状态卷和项目挂载的权限约定。服务的单实例锁由 `/state/instance.lock.sqlite` 上持有的 SQLite `BEGIN EXCLUSIVE` 事务保证，`/state/instance.lock` 仅保留 PID / 启动时间诊断信息，因此跨 Docker PID namespace 的备份也能可靠拒绝运行中的 app；空恢复卷不会被锁检查提前创建 sidecar。宿主机 bind-mounted 状态根目录不由启动初始化强制 `chmod`，避免 Docker Desktop / WSL 的挂载权限错误，权限仍由部署者设置并可由 doctor 检查。

在 WSL 2 Linux 使用 Node `v24.19.0`、pnpm `10.28.0`，npm registry 为 `https://registry.npmmirror.com`、Docker Hub 镜像前缀为 `docker.m.daocloud.io`，运行 `pnpm verify:S12`：30/30 检查通过。覆盖 server build、部署单测、lint、全量 typecheck、文档检查、Docker Compose 配置、实际镜像构建、HTTP health、Caddy HTTPS/WSS 入口、非 root / init / stop timeout / restart 策略、Git/bash/Node/Python/sqlite3 工具链、容器写入宿主项目、HTTP 配对、Session 持久化、app 重建、运行中备份拒绝、停机备份 manifest + SHA-256、空状态 bind mount 恢复，以及恢复服务读取旧设备凭据和旧 Session。详细清洗报告为 `test-results/s12/report.json`（不提交）。

首次 Docker 回归发现并修复两项真实问题：PID-only 锁无法跨容器识别运行实例；恢复到宿主机 bind-mounted 状态根目录时 `chmod` 被 Docker Desktop 拒绝。修复后完整 S12 报告为 `passed`。现有其他项目容器未被操作；S13 仍需真实 provider、Android / iOS 实机、完整原生 TUI 对照和最终发布验收。

## 2026-09-17 持续运行与 Docker 复核

本轮完成事件可靠性收尾：worker 的磁盘 backlog 使用 ACK lease，事件批次在父进程完成 EventStore / reducer 提交并成功写回 `batch_ack` 前不删除；未确认批次在 worker 重启后可恢复。大于 IPC 帧上限的 transport spool 文件也延迟到事件 ACK 后清理；服务启动只清理超过 60 秒的 `.tmp` 原子写临时文件，未确认的 JSON 输出保留，避免用 TTL 造成数据丢失。回归覆盖 ACK 前保留、ACK 后清理、未确认恢复、manager 级大帧提交和临时文件清理。

新增 R15 有界长运行测试：8 个 Session 连续 120 轮、共提交 960 个事件；最新一次 WSL 运行 event-loop turn p95 为 6.01 ms，RSS 增长约 61.2 MiB，所有 Session 的 live projection 与 seq 均一致。全量测试当前为 25 个文件 / 180 个测试通过。

重新核对 Docker：`exciting_blackburn` 与 `dreamy_perlman` 使用 `pi-remote:s12-debug` 正在运行且 `/healthz` 返回 200，但两者均没有宿主机端口、项目挂载或状态卷，`docker compose -f deploy/compose.yaml ps --all` 也为空。因此它们不能作为手机可访问的持久化 Compose 部署证据；S12 的可连接入口仍以独立命名的 Compose 生命周期验证为准，不能把现有手工容器冒充为该证据。现有容器未停止、删除或改动。

最终汇总 `pnpm verify:S13`：19 项检查中 8 项通过、11 项因真实 provider / 原生 TUI / Android / iOS 前置条件缺失而 `not_run`，阶段保持 `blocked`；本地真实 server/worker E2E 9/9 和确定性 Bash smoke 已通过。下一步只剩运营者环境中的实际模型、原生 TUI 对照及两平台实机验收，完成后再组合验收 S13。

用户反馈后再次核对实际 Docker 状态：Docker Desktop / WSL 引擎中确有一套 `deploy-api/web/postgres` 正在运行，但其 Compose 标签指向另一份旧 `lingjian` 项目，不是本仓库的 `pi-remote`；该套旧容器保持未操作。随后使用当前仓库的 `docker compose --env-file .env.example --file deploy/compose.yaml build app` 与 `up -d` 启动正式 Compose，镜像构建使用 `docker.m.daocloud.io`、`registry.npmmirror.com`，`pi-remote-app-1` 健康、`pi-remote-gateway-1` 运行，HTTP `:8080/healthz` 和 HTTPS `:8443/healthz` 均返回 200。实际 inspect 确认 app 为 `1000:1000` 非 root、`unless-stopped`、init、45 秒停止宽限，挂载持久 `/state` 卷和 `.local/workspaces`；app 内 `doctor` 为 `passed`，仅因当前未注入真实模型目录 / 凭据而给出 warning / not_run。此次使用 `.env.example` 的开发默认值，仅证明当前仓库 Compose 可启动，不替代有效域名证书、真实 provider 或手机验收。

## 本次设计交付的检查

初稿 [29e8026](https://github.com/cynos-ai/pi-remote/commit/29e80269e47fe2a8e93f722ab7184b439580af68) 的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34687052151)。

2026-09-12 评审修订轮，在 Windows、Python 3.12.8、SQLite 3.45.3 上执行 `python scripts/check_docs.py` 与 `git diff --check`，均通过：10 份 Markdown 及链接 / 表格，13 个阶段，12 条需求，30 个验收场景及双向阶段归属，47 个合成事件，12 张 SQLite 参考表及完整性约束，MIT 许可证。

独立代理针对修订后的 R1–R7 复核，未发现剩余阻断项；非阻断的最终命令结果存储建议也已补入 result_json。应用实现与实际 SDK / Docker / 设备验证仍未运行，不能把这次文档复核当作运行时验收。

GitHub Actions 中同一脚本在 Linux 上运行，实际结果以仓库的 Documentation checks 为准。该检查不加载 pi、不调用模型、不启动 Docker、不构建手机 App；这段历史记录对应当时尚未开始应用阶段的状态，当前 S07 已有单独运行证据。

## Bash 兼容要求修订（历史轮次）

2026-09-12，用户明确要求服务器 pi 保留与本地 TUI 相似的 Bash 使用体验。基于[上轮提交 c306439](https://github.com/cynos-ai/pi-remote/commit/c3064390322281f17cf7af1c606c2f84dd24ddcc)修订；上轮的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34688951963)。本次不沿用独立代理对旧版本的复核结论。

设计变化：默认原生 Bash、无额外命令过滤 / 审批 / 默认超时，正常后台服务可跨 Run、归档与空闲 worker 回收；前台调度串行不再被表述为整个目录只有一个 OS writer。工具错误交由 pi 继续处理，手机展示配额不改变模型结果或原生输出文件。整容器恢复只用于未完成调用结果不明的故障。

已核对固定 SDK 的 Bash、waitForChildProcess、shell 环境及活动 PID 跟踪源码；未执行 SDK / TUI / Docker / 真机兼容测试。新增 AT31 在 S02、S06、S08、S10、S12 分别验基线、生命周期、输出、手机与部署，S13 必须纳入最终验收。

Windows 本地 `python scripts/check_docs.py` 与 `git diff --check` 通过：11 份 Markdown，13 个阶段，13 条需求，31 个验收场景，8 个 Bash/TUI 对照场景，47 个合成事件及 12 张 SQLite 参考表。设计数据结构和核心事件类型未改变，沿用现有 SQL / 合成事件检查；这些结果不代表 FR13 已实现。

## 整体 TUI 体验修订

2026-09-12，用户进一步明确 Bash 只是例子，整个产品应接近本地 TUI，后续遇到真实问题再考虑限制。本轮基于 [65d5b4d](https://github.com/cynos-ai/pi-remote/commit/65d5b4df50cab9b43eaa1974aae8adbe36742797)；该基线的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34690428411)，不是本轮的测试结果。

本轮恢复原生资源默认加载、streaming 中配置 / 扩展命令、先停止再压缩、全阶段可答表单；归档仅改列表，多 Session 默认并行，无额外容量上限及默认空闲回收。旧后续队列暂停不锁新操作，空队列 ready。删除强制 host-control / restart-clean、blocked_scope_key 及容器清理证明，撤回额外 Docker 权限收紧；未知旧命令不自动重投，实际故障按具体问题处理。此前历史评审中的 R4 / R5 / R7 处置按本轮原则替换。

新增 Operation 事件投影与可空 Run 的 Interaction、初始化表单合成示例；同步 SQL 关联约束、协议、开发步骤、FR14 / AT32 和 T01–T08。Operation 保存在现有事件和 live_state 投影中，不增加数据库服务或新表。S02 建立原生能力清单并安排缺失的适配，S06 / S07 / S10 / S12 分别验运行、控制、手机及部署，S13 纳入整体对照。

已核对固定 SDK 的 prompt 扩展命令路径、setModel / setThinkingLevel、compact 及 DefaultResourceLoader / AgentSessionRuntime / SettingsManager 文档；源码核对不等于 SDK 实测。本轮独立设计评审未重新运行；应用、真实 SDK、Docker 和设备验证仍未运行。

Windows 本地使用 Python 3.12.8 / SQLite 3.45.3 执行 `python scripts/check_docs.py` 与 `git diff --check`，均通过：12 份 Markdown，13 个阶段，14 条需求，32 个验收场景及双向阶段映射，8 项 Bash + 8 项整体 TUI 对照，59 个合成事件及 12 张 SQLite 参考表。检查包含 Run / Operation 生命周期、无 Run 初始化表单、非空 / 空队列差异、同项目 Session 并行及交互的同 Session 外键；这些结果不代表应用运行时验收通过。本轮提交的 Linux 结果以对应 GitHub Actions 为准。

## 按新宗旨的独立审核与修订

2026-09-12，按用户要求重新独立审核，基线为 [cf02e91](https://github.com/cynos-ai/pi-remote/commit/cf02e916a148b8125144f6408ccbd81d58b71a8d)，其 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34692163097)。本次新代理不继承旧审核上下文，发现 3 项 P1 和 3 项 P2；详见[独立审核记录](reviews/2026-09-12-tui-principle-review.md)。

修订支持 Operation 归属的无 Run 内容、custom / 用户 Bash、自主 Run 及一命令多 Run、stop 清取完整未消费草稿、旧 target_run_id 优先恢复分类、双向标题和合法 header-only / 非 assistant 历史。补上同 owner 跨 Session 因果、原生 fork / import 先写文件窗口、延迟消息及异步 hook 的独立生命周期，没有增加工具过滤或默认禁用。

Windows 本地 Python 3.12.8 / SQLite 3.45.3 的 `python scripts/check_docs.py` 与 `git diff --check` 已通过：14 份 Markdown、13 个阶段、14 条需求、32 个验收项、8 项 Bash + 8 项整体 TUI 对照、135 条合成事件及 12 张参考表。检查覆盖允许的 Run 因果形状、无 Run 时间线、唯一 Operation、保留的定向 FK 以及合成内容 / 输入恢复；不等于真实 SDK 队列、标题算法或跨 owner 业务校验已实现。

独立代理已复查实际工作树，确认 N1–N6 均已在契约层面修订，未发现剩余阻断项；包括三处衔接问题及异步 hook。最终结论见本轮审核记录，本轮提交的 Linux 检查以对应 Documentation checks 为准。该段为 2026-09-12 审核时的历史状态；此后 S06 已实现，S07 的当前状态见上方表格与 S07 报告。live SDK、Linux 进程、Docker 或手机验证仍按各阶段记录为未运行。

## 后续阶段证据模板

```text
stage: Sxx
status: in_progress | passed | blocked
commit: <实现提交>
environment: <OS / Node / SDK / 设备 / 镜像版本>
commands: <实际运行命令，删除凭据>
results: <通过 / 失败 / not_run 数量与说明>
evidence: <清洗后的报告、日志摘要、截图路径或 CI 链接>
remaining: <尚未验证的内容及原因>
decisions: <对既有设计的必要修正及依据>
next: <下一阶段>
```

本地运行生成的详细报告放 `test-results/`（默认不提交）；只将清洗后的摘要、必要截图和可公开访问的 CI 证据纳入交接。
