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
| AT02 | FR03, FR04, FR05 | S02 | live + linux | 真实 prompt 读取临时文件、调用工具并写结果；关闭再恢复指定 JSONL 能引用唯一测试标记。另验证空 Session 配置后未必有文件、首次 assistant 写入时机、open 缺失 / 空文件会初始化的 SDK 行为，作为应用拦截依据 |
| AT03 | FR05, FR06 | S02 | live + contract | 至少一个模型实际返回 thinking 并显示；另测不支持或 redacted 时诚实呈现；没有原始内容时不能伪造或把签名当文本 |
| AT04 | FR06 | S07 | live | 两模型切换并更新有效等级，恢复后配置一致；空 Session 配置后回收仍保持已确认值，另一 Session 及全局默认不变；unsupported / busy 清晰。model_select hook 抛错时返回实际配置并发 session.updated，不假称回滚 |
| AT05 | FR07 | S07 | live + linux | 足够历史上手动 compact，显示开始 / 完成，旧历史仍可见，后续会话使用摘要保留信息；取消、历史过短、忙时调用分别正确，不能误停活跃任务 |
| AT06 | FR05, FR09 | S03 | contract | 正常 / failed / aborted / interrupted 流包含多块、未完整工具参数、累计输出；异常 run.content_sealed 保留 partial 历史、清空该 Run 的 liveItems、工具 outcome=unknown 且无虚构退出码。重复去重、缺口暂停；重放 / snapshot 等价，终态后内容和跨 Run 引用拒绝 |
| AT07 | FR09, FR10 | S04 | linux | 各写入边界注入失败，事件 / seq / Run / 投影同时回滚；异常封存、交互关闭、终态和队列暂停原子化。验证 pi 持久状态、队列暂停字段、partial 封存及 run_id FK 约束；相同 IPC batch 只提交一次，同号异内容失败，重开状态相同 |
| AT08 | FR09 | S04 | linux | snapshot 截取 S 后持续产生事件，历史分页固定 atSeq；S 时未完成消息 / 工具稍后正常完成或异常封存，旧分页不重复或遗漏，接续事件与新 snapshot 一致；封存 partial 不残留 liveItems |
| AT09 | FR01 | S05 | linux | 并发消费配对 token 仅一个成功；过期失败；凭据摘要存储；跨 owner 资源均 404；吊销后 HTTP 失效，WSS 吊销续接到 AT17 |
| AT10 | FR02, FR10 | S05 | linux | 注册真实目录；拒绝不存在、越过允许根、重复、祖先 / 后代重叠与 symlink 绕过；挂载别名和共享 git common dir 的并发边界正确 |
| AT11 | FR02, FR03 | S05 | linux | 新建独立 Session、改名、版本冲突、归档及恢复；重启后持久；旧会话上下文和项目文件保留；运行 / 排队 / 待答时不能归档 |
| AT12 | FR04, FR10 | S05, S07 | linux | 响应丢失同键重试只创建一次；用屏障使并发相同请求都 miss 快查，锁内返回同状态码 / 同收据，不能变 busy / version conflict / SQL 错误。同键异 payload 仅一方成功，另一方 IDEMPOTENCY_CONFLICT；S05 覆盖资源 / PATCH，S07 覆盖 prompt / follow_up / respond；GET command 显示当前进度 |
| AT13 | FR10 | S06 | linux | 同工作区两个前台 agent Run 串行，跨工作区在 2 Run 上限内并行；正常后台服务可与后续 Run 并存。队列公平、满队列拒绝，只回收无活动调用的 worker；100 个历史 Session 不启动 100 个进程 |
| AT14 | FR04 | S07 | live + linux | 当前 Run 接收 steer，随后 targeted abort；当前 SDK 长调用按原生语义停止；不额外清扫已正常返回的后台服务，旧 runId 不会终止新任务；控制通道不被 prompt Promise 阻塞 |
| AT15 | FR04, FR10 | S07 | linux | follow-up 持久化、可取消、去重及公平排队；前一 Run completed 后继续，failed / aborted / interrupted 后都暂停。重启、取消所有项或归档恢复不自动解暂停；过期 queueVersion / 暂停 runId 拒绝，清理 / 历史阻塞拒绝恢复；明确 resume_queue 后才继续，未知命令不重跑 |
| AT16 | FR08, FR09 | S07 | live + linux | 活动 Run 内四种表单回答 / 取消，断线重现 pending，双设备仅一次交付；到期 / 旧 epoch / 重启关闭。initialize / configure 的 session_start / model_select 请求四种 UI 都立即返回取消值与 notice，无 pending 行、无等待手机的 Promise；hook 失败显示真实错误 |
| AT17 | FR01, FR09 | S08 | linux | 独立于 Docker 的 Node 测试 HTTPS / WSS 入口可复现，提供设备信任配置。回放期间写事件并反复断开无缺口，重复去重；过高 cursor 拒绝，缓存丢失用 snapshot；吊销使未用 ticket 与已有 WSS 都失效 |
| AT18 | FR09, FR12 | S10, S11 | device | 两平台分别锁屏 60 秒、断网并切换 Wi-Fi / 蜂窝网络；任务继续；恢复后文本、工具、表单和命令收据与服务器一致 |
| AT19 | FR03, FR09, FR10 | S06, S11, S12 | linux + device + docker | S06 在 dispatch / ACK / 事件提交窗口 kill worker / 主进程：unknown / interrupted、partial 封存、队列暂停、旧 queued steer / abort / respond 取消，副作用不重复。另测空 Session 配置后回收、首次 assistant 前 crash、文件写后 / marker 前 crash、删除 / 清空 / 换掉 persisted 文件，禁止静默丢历史。S11 核对双端显示与重连；S12 核对实际容器退出及恢复证明 |
| AT20 | FR05, FR09 | S08 | linux | 高吞吐长输出加暂停读取客户端；发送缓冲有 4 MiB 上限，慢连接 resync，其他连接和任务继续；重复负载内存不持续增长，重连补全已提交事件 |
| AT21 | FR01, FR02, FR03, FR12 | S09, S10 | device | Android 真机配对、列表、历史、新建、改名、归档 / 恢复、命令与表单完整操作；凭据仅在安全存储，长列表可用且读历史不被强制滚动 |
| AT22 | FR01, FR02, FR03, FR12 | S09, S10 | device | iOS 真机完成与 Android 相同流程，覆盖后台恢复和 Keychain；仅 JS export、浏览器预览或模拟器不能通过此最终项 |
| AT23 | FR11 | S12 | docker | 非 root 镜像内真实 Git / bash / Node / Python、读写项目与测试成功；宿主机可正常修改生成文件；无 privileged、无默认 Docker socket 或全盘挂载 |
| AT24 | FR03, FR11 | S12 | docker | 重建 app 容器仍有项目 / Session / 配置；执行一致备份并恢复到新状态卷，继续旧会话、读取旧事件和 artifact；不只验证备份文件存在 |
| AT25 | FR10, FR11 | S06, S12 | linux + docker | 正常 TERM / abort 对当前未完成 Bash 使用 SDK 原生停止；它尚未返回时 SIGKILL worker，独立 PGID 可存活，必须保持恢复门槛且不自动分派下一 Run，同 scope 的 Node 重启不解锁。S06 验证实例锁 / PID 复用；S12 验证第二容器 / 错误证据拒绝、正确 stop / wait / inspect 才解除门槛且队列仍暂停；stop 超时 / 半写证据 / helper 崩溃不解锁。已正常返回的后台服务与此故障用例分开，按 AT31 验证继续运行 |
| AT26 | FR05, FR07, FR08, FR10 | S02 | live + contract + linux | provider 重试 / 自动压缩真实阶段，早期 agent_end 不报完成，最终错误 / aborted 不报成功。验证 Run 内表单及无 Run hook 立即取消；观察默认 Bash detached 进程组、正常 abort 与 worker SIGKILL 差异。合成故障与至少一次真实正常生命周期都覆盖 |
| AT27 | FR05, FR09 | S08 | linux | 大输出按快照替换并有截断 / artifact 标记；原始内容没保留时明确说明；下载有归属检查、路径校验和 Range，不能读取任意服务器文件 |
| AT28 | FR01, FR11 | S12 | docker + CI | 生产没有测试注入接口；日志与公开提交无真实 token / auth.json / 会话 / 数据库 / 私有代码；HTTPS 与 WSS 可用，错误不泄漏秘密 |
| AT29 | FR04, FR08, FR09, FR12 | S11 | live + device | 两台手机连接同一 Linux 后端：开始真实任务→另一台观察→回答表单→锁屏 / 换网→steer→完成→重启后继续；状态、文本和文件结果一致 |
| AT30 | FR01, FR02, FR03, FR04, FR05, FR06, FR07, FR08, FR09, FR10, FR11, FR12, FR13 | S13 | 全部 | AT01–AT29 及 AT31 的必需子集 / 环境全部通过，干净安装可复现；无 skip / not_run 冒充通过；Bash 对照兼容、安装、升级及恢复说明和实际行为一致 |
| AT31 | FR04, FR05, FR10, FR11, FR12, FR13 | S02, S06, S08, S10, S12 | linux + live + device + docker | 按 [Bash 兼容矩阵](bash-compatibility.md) B01–B08 对照同版本原生 SDK / TUI：复杂命令、网络 / 依赖、无默认超时、后台服务、定向停止、非零退出后修复、模型原生输出及故障区分。S02 建基线；S06 验跨 Run / 空闲回收；S08 验展示配额不影响模型结果；S10 验 Android / iOS 实际观察与控制；S12 在同一 Linux 镜像复验。不允许以禁用命令、加审批或杀后台服务取得通过 |

## 通过标准与报告

跨多个阶段的验收项按明确子集执行：AT12 的资源幂等竞态由 S05、执行命令竞态由 S07 验证；AT19 的 Linux 崩溃与历史恢复由 S06、手机展示由 S11、容器退出由 S12 验证；AT25 的进程状态逻辑在 S06、实际 Docker 清理证明在 S12。S11 使用 S08 已交付的测试 TLS 入口，不以 S12 镜像为隐含前置；S13 再汇总 Docker + 双端组合闭环。

AT31 各阶段按表中子集交付，以 B01–B08 的实际证据复用而非重复编写不同的 Bash 实现。AT30 是最终汇总项，完成它必须包括 AT31，不能因 AT01–AT29 已通过就跳过 Bash / TUI 对照。

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
