# V1 验收矩阵

这些是必须实现并运行的验收场景，不是已通过的测试结果。阶段完成情况见 [progress.md](progress.md)，实施入口见 [development-plan.md](development-plan.md)。FR 对应 [产品需求](v1-design.md)。

## 环境与证据

- contract：不依赖模型的协议与 reducer 测试。
- linux：真实 Linux 文件、SQLite、Node 子进程及网络客户端。
- live：固定 pi SDK 与实际可用模型，临时工作区，受限请求预算。
- device：真实 Android / iOS 安装包与手机，不用浏览器或 JS 打包替代。
- docker：干净 Linux Docker 主机及持久卷，覆盖容器重建和恢复。

测试 harness 可注入断网、延迟、写入故障和 worker 退出，注入能力只存在于测试构建或进程内依赖注入中，生产不得暴露远程 kill / SQL / 任意调试端点。

## 场景定义

| ID | 需求 | 阶段 | 环境 | 动作与通过条件 |
| --- | --- | --- | --- | --- |
| AT01 | FR11 | S01 | linux | 干净 checkout 安装锁文件、构建所有包、启动 healthz，并输出 Android / iOS JS bundle；版本固定，SDK 依赖只在 agent-pi |
| AT02 | FR03, FR04, FR05 | S02 | live + linux | 真实 prompt 读取临时文件、调用工具并写结果；关闭再恢复指定 JSONL 能引用唯一测试标记。另验证空 Session 配置后未必有文件、首次 assistant 写入时机、open 缺失 / 空文件会初始化的 SDK 行为，作为应用拦截依据；合法 header-only / 非 assistant fork / import 文件可恢复，不能因缺少 assistant 被拒绝 |
| AT03 | FR05, FR06 | S02 | live + contract | 至少一个模型实际返回 thinking 并显示；另测不支持或 redacted 时诚实呈现；没有原始内容时不能伪造或把签名当文本 |
| AT04 | FR06 | S07 | live | 两模型在空闲 / streaming 时按 SDK 行为切换并回传有效等级，原生 clamp 不变成应用拒绝；恢复后配置一致。空 Session 配置后主动回收仍保持确认值；默认只改当前 Session，persist=true 等待 SettingsManager.flush 后保存默认值，其他已加载 Session 不追溯改变。model_select hook 错误从 runner 监听上报，即使 setModel 未 reject 也展示实际配置与关联扩展错误，不假称回滚 |
| AT05 | FR07 | S07 | live + linux | 足够历史上手动 compact，显示开始 / 完成、旧历史和摘要；活动时按原生先 abort 后 compact，旧 Run 封存 / 终态后再开始 compact Run，不能把新任务误算成旧任务；另加入未消费输入对照原生 compact 时序，不套用 stop 的 clearQueue，也不预设全部旧输入已取消。取消、历史过短及真实 SDK 错误准确，不以全局 busy 拒绝 |
| AT06 | FR05, FR09 | S03 | contract | 正常 / failed / aborted / interrupted 流包含多块、未完整工具参数、累计输出；异常封存 partial、清空该 Run 的 liveItems，工具 outcome=unknown 且无虚构退出码。重复去重、缺口暂停；重放 / snapshot 等价。无 Run 的 operation / interaction 可独立开始、等待、结束，不被其他 Run 终态误关闭；有旧项才暂停，空队列 ready；custom / 用户 Bash 可无 Run，operationId 必填，延迟交付子操作不归已终态父操作；独立封存、恢复输入含附件与 snapshot 一致 |
| AT07 | FR09, FR10 | S04 | linux | 各写入边界注入失败，事件 / seq / Run / Operation 投影同时回滚；异常封存、对应交互关闭、终态和条件队列暂停原子化。验证 pi 持久状态、队列字段、partial 及 run_id FK；initialize / configure 交互允许 null Run，operation_id 必填，origin=run 必须有关联 Run，Run 与事件 / 回答 / targeted 控制保持同 Session；因果 Command 可跨同 owner Session，应用事务拒绝跨 owner；自主 Run 可无 Command，同一 Command 可产生多个 Run，Run.operation_id 必填且唯一；相同 IPC batch 只提交一次，同号异内容失败，重开状态相同；无 Run 时间线及输入 / metadataSync 投影可持久化，标题回声、A→B→A、并发及崩溃窗口均覆盖 |
| AT08 | FR09 | S04 | linux | snapshot 截取 S 后持续产生事件，历史分页固定 atSeq；S 时未完成消息 / 工具稍后正常完成或异常封存，旧分页不重复或遗漏，接续事件与新 snapshot 一致；封存 partial 不残留 liveItems |
| AT09 | FR01 | S05 | linux | 并发消费配对 token 仅一个成功；过期失败；凭据摘要存储；跨 owner 资源均 404；吊销后 HTTP 失效，WSS 吊销续接到 AT17 |
| AT10 | FR02, FR10 | S05 | linux | 注册真实目录，允许父子目录分别建项目；不存在、越过允许根或 symlink 越界准确拒绝，同一真实目录 / 重复挂载身份返回已有项目。workspaceKey / git common dir 正确记录但不默认强制串行；项目路径校验不成为工具沙箱 |
| AT11 | FR02, FR03 | S05, S07 | linux | 新建独立 Session、改名、版本冲突、归档及恢复；重启后持久，旧上下文和项目文件保留。运行 / 排队 / 待答状态都允许归档；S05 用状态夹具验证仅改列表元数据，实际执行 / 答复继续由 S07 / AT32 验证；S07 验证原生扩展改名、A→B→A、手机并发 rename 及落盘后事件提交前重启，不覆盖后来的原生标题 |
| AT12 | FR04, FR10 | S05, S07 | linux | 响应丢失同键重试只创建一次；用屏障使并发相同请求都 miss 快查，锁内返回同状态码 / 同收据，不能变 busy / version conflict / SQL 错误。同键异 payload 仅一方成功，另一方 IDEMPOTENCY_CONFLICT；S05 覆盖资源 / PATCH，S07 覆盖 prompt / follow_up / respond；GET command 显示当前进度及完整 runs 列表；一条扩展命令先 compact 再 prompt，两次执行可追踪，跨同 owner 目标 Session 时来源仍正确 |
| AT13 | FR10 | S06 | linux | 同工作区不同 Session 默认并行，同 Session 一个生成 Run；没有额外默认 Run / worker 上限或空闲回收。100 个历史 Session 列表不启动 100 个进程，已加载扩展内存默认保留；单独配置容量 / 队列限额 / 回收 / 工作区串行后准确生效。可选回收不影响活动调用 / 待答操作或已返回的后台服务 |
| AT14 | FR04 | S07 | live + linux | 当前 Run 接收 steer，随后 targeted abort；当前 SDK 长调用按原生语义停止；不额外清扫已正常返回的后台服务，旧 runId 不会终止新任务；控制通道不被 prompt Promise 阻塞。用阻塞流加入重复文本 / 附件输入，stop / ctx.abort 先 clearQueue，再 abort，未消费项完整取回且不自动执行；停止窗口不明项保留 unknown |
| AT15 | FR04, FR10 | S07 | linux | follow-up 持久化、可取消、去重；ready 队列前一 Run completed 后继续，异常时有旧项才暂停，空队列保持 ready。暂停期间新 prompt / 配置 / respond 可用，新任务完成不恢复旧项；取消最后一项清空 pause 并变 ready。重启 / 归档不自动恢复非空旧队列；过期 queueVersion / 暂停 runId 拒绝，明确 resume_queue 才继续旧项，不重投未知命令。SDK pendingInputs 与应用后续 Run 队列分开；returned 草稿需用户新命令才发送，不能文本去重或丢附件 |
| AT16 | FR08, FR09 | S07 | live + linux | initialize / configure / run / bash / extension 各覆盖四种表单等待、回答及取消；session_start / model_select 的 null Run 请求产生 Operation / pending 行，initialize 未 ready 仍接收 respond，回答后 hook 继续。断线重现、双设备仅一次交付；原生到期、旧 epoch / 重启关闭失效回调，Run 结束不误关独立配置表单。没有默认取消或跨等待锁死；thinking_level_select 的方法已返回但表单仍有效，异步子 Operation 独立结束；runner 错误监听可见且保留实际配置 |
| AT17 | FR01, FR09 | S08 | linux | 独立于 Docker 的 Node 测试 HTTPS / WSS 入口可复现，提供设备信任配置。回放期间写事件并反复断开无缺口，重复去重；过高 cursor 拒绝，缓存丢失用 snapshot；吊销使未用 ticket 与已有 WSS 都失效 |
| AT18 | FR09, FR12 | S10, S11 | device | 两平台分别锁屏 60 秒、断网并切换 Wi-Fi / 蜂窝网络；任务继续；恢复后文本、工具、表单和命令收据与服务器一致 |
| AT19 | FR03, FR09, FR10 | S06, S11, S12 | linux + device + docker | S06 在 dispatch / ACK / 事件提交窗口 kill worker / 主进程：unknown / interrupted、partial 封存、旧 Operation 结束、失效控制取消，仅非空旧队列暂停；不自动重投旧命令，新明确操作可继续。另测空 Session 配置后主动回收、首次 assistant 前 crash、文件写后 / marker 前 crash、删除 / 清空 / 换掉 persisted 文件，禁止静默丢历史。活动 prompt 入库后 IPC 前崩溃，先按 target_run_id 取消为 stale_runtime，不建 queued Run / 后续成员；无 Run partial 封存、交付不明输入保留 unknown。原生替换文件已写 / 映射未确认时保留可认领文件及源历史，不重做 fork；合法 header-only / 非 assistant 历史成功恢复。S11 核对双端显示与重连；S12 核对实际容器退出及恢复，无强制清理证明 |
| AT20 | FR05, FR09 | S08 | linux | 高吞吐长输出加暂停读取客户端；发送缓冲有 4 MiB 上限，慢连接 resync，其他连接和任务继续；重复负载内存不持续增长，重连补全已提交事件 |
| AT21 | FR01, FR02, FR03, FR12 | S09, S10 | device | Android 真机配对、列表、历史、新建、改名、归档 / 恢复、命令与表单完整操作；凭据仅在安全存储，长列表可用且读历史不被强制滚动 |
| AT22 | FR01, FR02, FR03, FR12 | S09, S10 | device | iOS 真机完成与 Android 相同流程，覆盖后台恢复和 Keychain；仅 JS export、浏览器预览或模拟器不能通过此最终项 |
| AT23 | FR11 | S12 | docker | 非 root 镜像内真实 Git / bash / Node / Python、读写项目与测试成功；宿主机可正常修改生成文件；无 privileged、无默认 Docker socket 或全盘挂载 |
| AT24 | FR03, FR11 | S12 | docker | 重建 app 容器仍有项目 / Session / 配置；执行一致备份并恢复到新状态卷，继续旧会话、读取旧事件和 artifact；不只验证备份文件存在 |
| AT25 | FR10, FR11 | S06, S12 | linux + docker | 正常 TERM / abort 对当前未完成 Bash 使用 SDK 原生停止；未返回时 SIGKILL worker，独立 PGID 可存活，记录 unknown，旧命令不自动重投，不能把 worker 退出当作工具已停止。S06 验证实例锁 / PID 复用及新明确操作可继续；S12 验证普通 compose 启动不需登记 / 清理证明，实际容器停止 / 重启与故障状态恢复、停止超时如实报告。仅针对实际问题处理残留，已正常返回服务按 AT31 继续运行 |
| AT26 | FR05, FR07, FR08, FR10 | S02 | live + contract + linux | provider 重试 / 自动压缩真实阶段，早期 agent_end 不报完成，最终错误 / aborted 不报成功。验证 Run 内及无 Run hook 表单真正等待和回答、活动时切配置 / 扩展命令的原生路径；观察默认 Bash detached 进程组、正常 abort 与 worker SIGKILL 差异。合成故障与至少一次真实正常生命周期都覆盖 |
| AT27 | FR05, FR09 | S08 | linux | 大输出按快照替换并有截断 / artifact 标记；原始内容没保留时明确说明；下载有归属检查、路径校验和 Range，不能读取任意服务器文件 |
| AT28 | FR01, FR11 | S12 | docker + CI | 生产没有测试注入接口；日志与公开提交无真实 token / auth.json / 会话 / 数据库 / 私有代码；HTTPS 与 WSS 可用，错误不泄漏秘密 |
| AT29 | FR04, FR08, FR09, FR12 | S11 | live + device | 两台手机连接同一 Linux 后端：开始真实任务→另一台观察→回答表单→锁屏 / 换网→steer→完成→重启后继续；状态、文本和文件结果一致 |
| AT30 | FR01, FR02, FR03, FR04, FR05, FR06, FR07, FR08, FR09, FR10, FR11, FR12, FR13, FR14 | S13 | 全部 | AT01–AT29、AT31 及 AT32 的必需子集 / 环境全部通过，干净安装可复现；无 skip / not_run 冒充通过；整体 TUI / Bash 兼容、安装、升级及恢复说明和实际行为一致 |
| AT31 | FR04, FR05, FR10, FR11, FR12, FR13 | S02, S06, S08, S10, S12 | linux + live + device + docker | 按 [Bash 兼容矩阵](bash-compatibility.md) B01–B08 对照同版本原生 SDK / TUI：复杂命令、网络 / 依赖、无默认超时、后台服务、定向停止、非零退出后修复、模型原生输出及故障区分。S02 建基线；S06 验跨 Run / 可选回收；S08 验展示配额不影响模型结果；S10 验 Android / iOS 实际观察与控制；S12 同镜像复验。不以命令过滤、审批、杀后台服务或无依据的项目冻结取得通过 |
| AT32 | FR14 | S02, S06, S07, S10, S12 | linux + live + device + docker | 按 [整体 TUI 矩阵](tui-experience.md) T01–T08 对照原生资源、输入、模型 / 压缩、全阶段交互、会话并发与归档、连续使用、能力适配清单及限制依据。S02 建清单 / 基线；S06 验运行与恢复；S07 验控制 / 标准交互 / 归档时继续；S10 验双端入口；S12 复验普通 Linux 部署。补充验证无 Run custom / 用户 Bash、延迟交付、自主和一命令多 Run、stop 草稿与 compact 差异、原生标题 / 异步 hook、合法历史与 new / switch / fork / import 的目标归属；基础能力完成适配，未完成项有具体步骤，不能用默认关闭 / 自动取消 / 永久 needs_adapter 绕过要求 |

## 通过标准与报告

跨多个阶段的验收项按明确子集执行：AT12 的资源幂等竞态由 S05、执行命令竞态由 S07 验证；AT19 的 Linux 崩溃与历史恢复由 S06、手机展示由 S11、容器退出由 S12 验证；AT25 的进程状态逻辑在 S06、实际 Docker 故障处理在 S12。S11 使用 S08 已交付的测试 TLS 入口，不以 S12 镜像为隐含前置；S13 再汇总 Docker + 双端组合闭环。

AT31 / AT32 各阶段按表中子集交付，复用 B01–B08 / T01–T08 的任务与证据。AT30 是最终汇总项，完成它必须包括两套对照，不能因 AT01–AT29 已通过就跳过原生体验验收。测试 harness 的配额、总时限和进程清理不成为产品默认限制。

阶段报告必须注明已覆盖的子断言；整项通过要求全部子集及环境完成。AT21 / AT22 的组件或模拟器子集不能替代真机；SDK mock 也不能替代真实模型与工具调用。

每次执行报告至少包含以下结构，具体 schema 在 S01 建立：

```json
{
  "stage":"Sxx",
  "commit":"IMPLEMENTATION_COMMIT",
  "environment":{"os":"LINUX_VERSION","node":"NODE_VERSION","sdk":"0.85.1","device":"DEVICE_OR_NULL"},
  "checks":[{"id":"AT01","status":"not_run","command":"ACTUAL_COMMAND","evidence":[],"reason":"尚未实现"}],
  "limitations":[]
}
```

状态只能是 passed、failed、not_run；缺少运行条件不算通过。每个 passed 项必须能回溯命令、实际输出 / 断言或设备证据。公共报告删除 token、provider 认证、私人路径和真实代码内容；保留模型 ID、版本及必要行为结论。

S13 检查所有 required IDs 和平台，遇到 missing / failed / not_run 非零退出。一次绿色的普通 CI 不自动代表发布验收通过。
