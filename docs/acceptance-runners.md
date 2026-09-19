# Live 与原生对照验收入口

这些入口分别记录自动断言和运营者实际采集的对照证据。报告校验能检查覆盖、版本、文件完整性，不能证明人工观察的真实性；必须保留实际操作和采集内容供复核。合成回归只验证 runner，不代表真实模型或 TUI 通过。

## 范围与执行方式

| 入口 | 自动执行 | 仍需实际操作与采集 |
| --- | --- | --- |
| `pnpm test:live -- --suite sdk` | 两个真实模型、临时 read/write 文件、thinking 与完成状态 | AT26 的真实失败/重试、持续开发与历史恢复 |
| `pnpm test:live -- --suite commands` | 默认：真实工具往返、同键请求、空闲配置；controls：stop/steer/follow-up；compact：原生队列与摘要；compact-cancel：摘要生成前取消 | streaming 配置、compact 完整矩阵、全阶段表单、原生会话/标题、自主与多 Run，以及带附件的 stop 对照 |
| `pnpm test:live -- --suite realtime` | 同上工具往返、生成中断线、完成后从 cursor 回放并与数据库逐项比较 | snapshot 交接竞态、慢连接与 artifact、设备吊销 |
| `pnpm test:bash-parity -- --target TARGET` | 校验实际采集的对照证据 | B01–B08 的原生端及应用端操作 |
| `pnpm test:tui-parity -- --target TARGET` | 校验实际采集的对照证据 | T01–T08 的原生端及应用端操作 |

TARGET 支持 `sdk`、`runtime`、`commands`、`realtime`、`docker`，默认 `sdk`。目前采用保守的完整矩阵：每个 target 都需对应 B01–B08 或 T01–T08；同一环境允许复用真实采集文件，但必须单独说明该 target 的操作与观察，不能拿 SDK smoke 代替后端或 Docker。

`pnpm test:bash-parity -- --target sdk --smoke` 单独运行确定性 SDK/Bash 比较，结果写到 `test-results/parity-bash-sdk-smoke/report.json`。它不覆盖完整 parity 报告，也不会使阶段通过。

## 先生成清单，再运行

在待验收的源码版本上执行以下命令。`--plan` 只输出 JSON 清单，不调用模型，不生成通过报告：

```sh
node scripts/test-live.mjs --suite commands --plan
node scripts/test-parity.mjs tui --target runtime --plan
```

保存清单到仓库外的私有证据目录；清单中有当前 commit、源码 SHA-256 和每项操作说明。不要删除必需项，也不要把未执行项改成 passed。源码包含未提交文件，忽略构建、凭据、会话及 test-results；进度和发布就绪两份结果记录也不参与指纹，以便测试后补记结果。修改其余源码后必须重新生成清单并重新验证相关证据。文件字节及换行也是指纹的一部分，应在同一 Linux checkout 中完成。

自动 live 运行需要 Linux、Node 24.19.0、已构建的生产 server/agent-pi，以及 openssl（后端两类 suite）。在运营者私有环境设置：

| 变量 | 含义 |
| --- | --- |
| `PI_REMOTE_LIVE_TESTS=1` | 显式启用真实模型调用；未设置时只检查已有证据 |
| `PI_REMOTE_LIVE_AGENT_DIR` | 专供测试的 pi 配置/凭据/资源目录，不使用个人项目或个人会话目录 |
| `PI_REMOTE_LIVE_PROVIDER` / `PI_REMOTE_LIVE_MODEL` | 普通模型 |
| `PI_REMOTE_LIVE_THINKING_PROVIDER` / `PI_REMOTE_LIVE_THINKING_MODEL` | 另一个能实际返回 thinking 的模型，必须与普通模型不同 |
| `PI_REMOTE_LIVE_SINGLE_MODEL=1` | 显式允许同一模型做普通 / thinking smoke；结果使用独立 AUTO-SDK-thinking-single 项，不能满足 AT03 的第二模型条件 |
| `PI_REMOTE_LIVE_MAX_OPERATIONS` | 明确允许的顶层模型操作数；sdk 至少 2，commands/realtime 基础场景至少 1，controls 至少 3，configuration 至少 4，三个 compact 场景均至少 8 |
| `PI_REMOTE_LIVE_TIMEOUT_MS` | 每次 SDK 操作或后端测试场景的等待上限，默认 120000，允许 1000–1800000；后端启动另有 90 秒上限 |
| `PI_REMOTE_ACCEPTANCE_EVIDENCE_DIR` | 私有证据目录；文件名如 `live-commands.json`、`parity-tui-runtime.json` |

顶层操作数不是 provider HTTP 请求数或费用硬上限。原生工具循环、扩展和重试可产生更多请求；费用预算须在 provider 侧控制。runner 不改变产品的 Bash 时限、资源发现、模型执行或工具权限。自动测试只用临时项目，生成的 JSONL/SQLite 随夹具清理；不输出凭据、原始 SDK 错误、会话内容或数据库。

```sh
pnpm build:server
pnpm test:live -- --suite sdk
pnpm test:live -- --suite commands
pnpm test:live -- --suite realtime
```

commands/realtime 使用生产 server/worker 和真实 HTTPS/WSS，绑定临时本机端口，客户端显式信任该次临时证书；这不证明手机能访问部署域名，也不替代设备 TLS 验收。所有自动步骤通过后，若完整清单仍缺项，suite 依然 blocked。

定向控制验收使用 `node --env-file=.env scripts/test-live.mjs --suite commands --scenario controls`，要求 `PI_REMOTE_LIVE_MAX_OPERATIONS` 至少为 3（停止的任务、新任务、后续排队任务）。真实模型调用临时 Bash gate，确保有可观察的工具执行窗口；验证重复 steer 与 native followUp 完整草稿取回、持久 follow_up 暂停、旧 target 拒绝、新 Run 正常执行、steer 消费与 follow_up 顺序及幂等。gate 的等待上限仅属于测试脚本，不更改产品 Bash 时限。该场景只记 `CMD-steer-stop-drafts`，不覆盖 compact 或其他控制项。定向运行前应另存此前同 suite 报告；报告不会跨源码指纹自动合并旧结果。

控制场景失败时额外保留脱敏结构：输入的 queued/consumed/returned 状态、原生历史中的合成指令标记、工具名称/错误标记及合成副作用顺序。只有固定允许列表中的标签进入报告，原始用户消息、模型回答、任意工具参数和输出均不复制。该结构用于区分输入交付与模型执行差异，不能把模型正常结束直接判定为所要求的工具执行成功。

`--suite commands --scenario compact` 比较直接 SDK `session.compact()` 与生产后端：双方先建立上下文、在真实 Bash 调用中加入 steer / native followUp，再压缩并继续写文件。至少允许 8 次顶层操作（双方各 seed / gate / compact / 后续 prompt），队列继续执行及工具循环可能产生额外 HTTP 请求。测试将专用 agent 配置复制到临时目录，双方使用相同的 `keepRecentTokens=64` / `reserveTokens=2048` 来验证小上下文压缩；不改动运营者原配置或产品默认值。检查原生输入去向、旧 Run 的真实终态、持久 compaction 和摘要保留的标记。自动结果使用 `AUTO-CMD-compact-native-queue`；它不替代交互式 TUI、压缩取消、所有扩展和应用后续队列的完整对照。无待消费输入和空历史失败恢复另由本地真实进程回归覆盖。

`--suite commands --scenario compact-cancel` 要求至少 8 次顶层操作，双方各执行两轮准备对话 / compact / 后续 prompt。在临时原生 `session_before_compact` 扩展的待答窗口中，分别调用 SDK `abortCompaction()` 和后端定向 abort；检查取消终态、待答关闭、无摘要落盘以及原上下文仍可用于写文件。该场景记为 `AUTO-CMD-compact-cancel-before-summary`，只覆盖摘要生成前的取消，不代表 provider 摘要流中断或交互式 TUI 已验证。

`--suite commands --scenario compact-cancel-stream` 同样至少需要 8 次顶层操作，使用临时本机 HTTP relay 观察已配置 provider 的 OpenAI-compatible 摘要流。双方各在 relay 收到并转发首个非空 content frame 后停止；relay 暂停后续数据交付，形成可重复的取消窗口。检查客户端断开、SDK 取消事件、后端 Run/Command 终态、无摘要落盘及后续对话。这是实际 provider 加受控传输时序的测试，不代表未经延迟的网络时序或交互式 TUI 对照；记为 `AUTO-CMD-compact-cancel-stream`，不替代完整 `CMD-compact-queue`。relay 仅转发到原配置的 provider 地址，拒绝重定向，不落盘请求、响应或凭据；测试结束关闭 relay，生产配置不变。

`--suite commands --scenario configuration` 至少需要 4 次顶层操作（直接 SDK 与后端各 gate / 恢复后 prompt）。真实 Bash 工具等待期间完成模型选择和思考等级修改，与 SDK 实际 clamp 对照；停止 gate 后分别重新打开原生会话、SIGKILL 并重启后端，核对配置、后续 assistant 的实际 model/provider 以及结果文件。所有配置修改均不持久化为默认值，原始 agent 配置先复制到临时目录。单模型模式只证明同模型重新选择及等级配置，不替代两模型切换；本场景亦不覆盖 token 流中的精确时序、persist=true、空历史回收或 model_select hook 错误，使用 `AUTO-CMD-active-config-recovery` 子集标识。

## 采集和导入人工对照

在同一 Linux、SDK、模型、资源与配置下，对原生 pi TUI 和待测 target 分别操作。使用 `script` 等终端记录工具或已有测试 harness 保存实际输出；清洗秘密及私有内容，记录可复核的结果。B03 必须实际运行超过 300 秒；B08 的故障必须施加到测试进程。按 [Bash 对照](bash-compatibility.md) 和 [整体 TUI 对照](tui-experience.md) 完成步骤，不能凭截图或退出码猜结果。

将清单补充为 schemaVersion 1 的证据 manifest：

- `environment`：Linux、Node 24、SDK 0.85.1、实际 modelIds、相同资源/配置的 SHA-256；docker target 还需 `imageDigest`（`sha256:` 加 64 位摘要）。摘要应基于清洗后的资源/配置清单，不能公开 auth.json 的内容。
- 每项 `status` 为 passed / failed / not_run；已执行项必须填写实际 `command`、`observation` 和 `artifacts`。
- artifact 包含 `role`、相对 manifest 目录的 `path`、文件 `sha256`。live 需 application；parity 同时需 native 和 application，不能是相同内容。文件应非空、最多 32 MiB，不接受越目录或符号链接逃逸。
- `recordedAt` 记录实际采集时间。失败证据和缺项都保留；缺项汇总为 blocked，格式错误、摘要不符、过期源码或执行失败为 failed。

例如一个 artifact 引用：

```json
{"role":"native","path":"captures/T01-native.txt","sha256":"实际文件的64位SHA256摘要"}
```

执行导入，不额外调用模型：

```sh
pnpm test:live -- --suite commands --evidence /private/evidence/live-commands.json --evidence-only
pnpm test:tui-parity -- --target runtime --evidence /private/evidence/parity-tui-runtime.json
```

机器报告默认位于 `test-results/SCOPE/report.json`。报告保留逐项状态、人工来源和采集文件摘要，不复制私有路径、观察正文或采集内容。需要隔离 runner 自身测试时可设置 `PI_REMOTE_ACCEPTANCE_REPORT_DIR`；阶段汇总始终读取默认目录。人工证据不替代真实执行，维护者必须复核其真实性。

## 阶段和发布汇总

S02、S06、S07、S08、S12 读取对应完整报告，缺失/失败/过期不会通过。S13 读取三类 live 和五类 target 的两种 parity 报告，检查必需 case、非空 checks、状态及当前源码指纹；不会隐式再调用付费模型。每个 S01–S13 报告现在携带源码指纹，旧版 working-tree 报告不能直接用于新发布验收。

S12 原有 Docker 生命周期验证已通过的历史证据仍有效地描述当时的部署子集，但不包含完整原生对照。因此完整 `pnpm verify:S12` 还需 Docker parity。普通 CI 使用 `pnpm verify:S12 -- --deployment-only`，生成独立的 `S12-deployment-only` 报告；S13 不接受它替代完整 S12。

`pnpm test:acceptance` 验证 runner 的正常/异常报告、缺环境、缺项、重复 ID、过期源码、错误摘要和越目录等边界，不调用 provider。构建后执行 `pnpm test:acceptance-backend`，用本地确定性模型服务验证新 runner 的真实生产进程路径；WSL 挂载目录自动沿用已有的离线 Linux 暂存方式。这些测试不生成真实 live 通过证据。设备脚本及终端 renderer 的产品适配仍属于后续工作。

## 本地环境文件与单模型 smoke

凭据只放 Git 忽略的 `.env`，使用 Node 的 `--env-file=.env` 读取，不把 key 放进命令行、models.json 或日志。专用 agent 目录中的 models.json 用 `$DEEPSEEK_API_KEY` 引用环境变量。运行示例：`node --env-file=.env scripts/test-live.mjs --suite sdk`，commands / realtime 同理。本机网络如依赖额外受信任 CA，须在 Node 启动前设置 `NODE_EXTRA_CA_CERTS`；不能通过关闭 TLS 校验解决。

用户仅指定一个模型时，设置 `PI_REMOTE_LIVE_SINGLE_MODEL=1` 可继续验证工具与 thinking；原 AT03 双模型条件不改为通过。DeepSeek 官方文档当前说明旧名称 `deepseek-v4-flash` 仍被接受，但请求由 DeepSeek-V4.1-Flash 提供服务；需要在实际报告中区分请求名称和供应商声明的版本，不能把它当作验证了已退役 V4-Flash。参考[官方模型说明](https://api-docs.deepseek.com/quick_start/pricing)及[thinking 模式](https://api-docs.deepseek.com/guides/thinking_mode)。
