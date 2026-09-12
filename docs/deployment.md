# 统一 Linux 与 Docker 部署约定

状态：默认部署方案，S12 实现。下列文件、CLI 和命令是未来交付契约，当前仓库没有可启动的镜像或 Compose 文件。实施后必须把示例替换为已验证的真实入口。

## 1. 拓扑

一台 Linux 主机，一个 app 容器运行主服务和 session workers。SQLite、pi 配置 / 会话和大输出在本地持久卷；项目显式挂载。手机通过域名 HTTPS / WSS 或已建立的私有网络访问。可用 Caddy 终止 TLS，不新增业务数据库或消息中间件。

```text
手机 → HTTPS / WSS → TLS 入口 → app:8080
                                ├─ Node 主进程
                                ├─ pi SDK workers
                                ├─ /state/app.sqlite
                                ├─ /state/pi
                                ├─ /state/outputs
                                └─ /workspaces/<project>
```

模型服务在网络另一端，SDK 在容器内调用它。项目编辑、Git、bash、构建和测试都在 Linux 容器里执行，不继承宿主机的软件环境。Android / iOS App 的发布构建是另一条流水线；Linux 后端容器不负责运行 Xcode。

这里的容器是用户的 Linux 开发环境，Bash 按[原生 TUI 兼容要求](bash-compatibility.md)运行。普通 Bash、后台服务、网络请求、安装依赖和构建测试没有应用级命令过滤或逐条批准；运行环境的工具链、网络与权限应按项目配置齐全。

## 2. 镜像与目录

多阶段构建：构建阶段用固定 Node 24 LTS Debian slim 与 pnpm / lockfile；运行阶段只带编译产物、生产依赖、Node、Git、bash、Python 3、CA 证书、openssh-client、tini 和 flock 所需工具。编译器按首批项目工具链需要加入，版本在 S12 固定并记录镜像 digest。

运行用户为非 root，默认 UID/GID 1000；部署变量 `PI_REMOTE_UID / PI_REMOTE_GID` 可对应宿主机目录。不要使用宿主机 root 身份运行 agent 来规避权限问题。首次创建卷由管理员或专门初始化步骤设置所有权；常驻服务不反复递归 chown 项目目录。

| 路径 | 行为 |
| --- | --- |
| `/app` | 应用编译产物，运行时不修改 |
| `/state/app.sqlite` | SQLite 与同目录 WAL / SHM，主进程统一写入 |
| `/state/pi` | 指定 SDK agentDir / session 存储，凭据受限 |
| `/state/outputs` | artifact 临时写入与封存，默认总量限制 |
| `/state/runtime` | 持久 instanceId、宿主机验证的容器 / executionScopeKey 绑定与清理证据；不通过手机 artifact API 暴露 |
| `/state/home` | 工具需要的可写用户目录 / cache，不能暴露给手机文件 API |
| `/workspaces` | 允许注册项目的根；每个实际挂载都应明确来源 |
| `/tmp` | 临时文件，可用有容量上限的 tmpfs |

SQLite 放本机 ext4 / xfs 等支持正确文件锁的持久卷，不用 NFS / SMB / 同步网盘。项目源文件可 bind mount，但若来自网络文件系统，要另行验证 Git、文件锁和延迟；不把它当作 V1 默认运行环境。

初始镜像支持一套统一 Linux 工具链。不同项目需要不同系统依赖时，运营者扩展镜像并配置权限；用户目录内的包管理、虚拟环境、依赖下载和项目安装脚本可以直接通过 Bash 执行，不经过额外审批。系统软件安装遵循同 UID/GID 的 Linux 权限。V1 不把每个 Bash 命令放入缺少项目环境的一次性沙箱。

## 3. 配置契约

| 配置 | 默认 / 要求 |
| --- | --- |
| PI_REMOTE_HOST / PORT | 0.0.0.0 / 8080，TLS 代理访问内部端口 |
| PI_REMOTE_STATE_DIR | `/state` |
| PI_REMOTE_PI_DIR | `/state/pi`；显式传入 SDK，不依赖某个默认宿主机 HOME |
| PI_REMOTE_WORKSPACE_ROOT | `/workspaces` |
| PI_REMOTE_MAX_ACTIVE_RUNS | 2 |
| PI_REMOTE_MAX_LOADED_WORKERS | 4，不得小于 active Run 限制 |
| PI_REMOTE_WORKER_IDLE_SECONDS | 300 |
| PI_REMOTE_ALLOWED_ORIGINS | 如有浏览器客户端则显式允许；原生 App 仍必须鉴权 |
| PI_REMOTE_DEFAULT_PROVIDER / MODEL | 运营者选择已配置模型；缺失时 UI 可选模型，运行前必须解析成功 |
| PI_REMOTE_MODEL_TIMEOUT_MS | 15000，用于 catalog / 鉴权初始化网络请求，不限制整次 agent 任务 |
| PI_REMOTE_LOAD_PROJECT_EXTENSIONS | 默认 false；仅对运营者明确配置的可信资源启用 |

默认模型、工具链、项目挂载及实例配置在后端部署时设置。模型 API key / OAuth 配置放专用 pi 目录或运行时秘密注入，不写进镜像层、Compose 提交、命令行示例或 Git。

OAuth 可能需要刷新并写入状态；只读挂载 auth.json 时不能假设 SDK 可以在原地刷新。用受限可写凭据卷并验证多 worker 刷新行为；S02 若发现共享凭据竞争，要实现串行刷新或由统一配置层协调，再完成部署。

## 4. Compose 必须具备的行为

- `init: true` 或等效 init；优雅 TERM，`stop_grace_period` 至少 30 秒，覆盖 15 秒 worker 停止窗口。
- `restart: unless-stopped`，服务 crash 后可重启；重启不重放不明副作用，也不把新进程或新容器当成已确认工具清理的证据。
- app 容器只挂必要项目和 state，不开启 privileged，不默认挂 Docker socket。
- 普通 Docker 模式下合理 drop capabilities、no-new-privileges，验证同用户子进程及工具仍可工作；不能只凭配置宣称有多租户沙箱。
- 单实例锁 `/state/instance.lock`，第二个 app 不能同时对同一状态卷运行。不要设置两个副本共享 SQLite。
- readiness 只有迁移、恢复、单实例锁及当前 Docker 执行作用域登记完成后成功。存在单个工作区的清理阻塞时可服务其他工作区，但不能绕过该阻塞。模型未配置可明确报告待配置，不把秘密放进 healthz。
- 设置运行日志轮转、可配置的容器资源和手机展示上限；展示配额不得裁剪 SDK 的模型结果或终止 Bash。日志不记录 Authorization、WS ticket、pairing token 或模型凭据。没有应用级 Bash 默认时限。
- 开发 HTTP 入口只用于明确的本地测试。真实手机接入验收使用有效 HTTPS / WSS；不长期依赖放宽 Android cleartext 或 iOS ATS。

Linux 容器中的 localhost 指向自己。项目需要外部数据库、宿主机服务、VPN 或私有 Git 时，部署者明确配置网络与凭据。若项目需要 Docker / Compose，单独设计该执行能力，不把宿主机 daemon socket 作为默认依赖。

## 5. S12 应实现的操作入口

以下是命令契约，尚未实现：

```sh
docker compose --env-file .env -f deploy/compose.yaml build
bash deploy/host-control.sh up --env-file .env
docker compose --env-file .env -f deploy/compose.yaml exec app node apps/server/dist/cli.js doctor
docker compose --env-file .env -f deploy/compose.yaml exec app node apps/server/dist/cli.js pair --ttl 600
```

host-control 在宿主机调用 Docker CLI 启动 / 登记当前运行实例；应用不挂 Docker socket。直接 compose up 可以启动 API，但在有效登记前不能执行 Run。登记是部署时的自动归属校验，不检查命令内容、不向用户请求逐条审批；每个普通命令和每次 Run 结束都不需要调用 helper。自动重启后 helper 可重新登记当前作用域；登记本身不解除历史上的清理阻塞。

doctor 检查：目录真实路径、读写及文件归属、Git / bash / Node / Python、SQLite 外键 / WAL / 迁移、默认模型可用性、模型网络、pi 历史错误、队列暂停、当前作用域登记及清理阻塞。它应返回结构化成功 / 失败和非零退出码，不打印密钥。

pair 在管理终端生成高熵单次 token 或包含它的 QR，10 分钟过期；手机交换设备 token，服务端只留摘要。重新配对不复用旧秘密；设备可从 API / CLI 吊销。

镜像构建和初始化不能偷偷读取开发者的个人 pi 或 SSH 目录。明确的项目配置、凭据和宿主机路径只在部署时注入。

### 5.1 未完成调用的故障恢复

SDK 0.85.1 的默认 Bash 在 Linux 用 `detached:true`，shell 的进程组通常不同于 worker。正常停止使用 SDK abort 并等待当前调用返回，不额外清扫已正常返回的后台服务；杀 worker 的 PGID 不能替代 SDK 的停止结果。只有活动执行中 SIGKILL、停止超时或主进程崩溃且未完成调用状态未知时，才对受影响 workspace_key 保存 `blocked_reason=PROCESS_CLEANUP_UNCONFIRMED` 和旧 `blocked_scope_key`，阻止应用自动分派下一 Run。该门槛不保证整个目录只有一个 OS writer。

正常 Bash 返回后留下的 nohup、setsid、开发服务器或 watcher 属于正常运行环境：不把它们当成未知残留，不等待它们退出才完成 Run，不因归档、切换 Session 或空闲 worker 回收额外清理。用户可在后续 Bash 中访问、观察和停止服务。若 SDK 本身因未重定向的输出句柄仍在等待，按原生行为继续运行，不伪造 tool.finished。

V1 使用以下恢复契约，不增加独立 runner 或容器内 Docker 权限：

1. app 为状态卷创建持久 instanceId。执行作用域由 Linux `/proc/sys/kernel/random/boot_id`、`/proc/self/ns/pid` 的 namespace inode 和 `/proc/1/stat` 的 PID 1 start ticks 组成，规范编码为 executionScopeKey。分派前写到 Run。它识别一次容器执行边界，不独自证明旧进程已退出。
2. 宿主 helper 在第一次允许执行前，取得 Docker 的完整不可变 container ID 及 `inspect.State.Pid`；读取对应宿主 `/proc/<pid>/ns/pid`、start ticks 和 boot ID，核对 app 报告的 scope / instanceId，再原子保存绑定。不能用容器名称、hostname、Compose service 名或主进程自己生成的随机 UUID 代替此校验。Docker PID 模式必须是独立 namespace，不共享 host / 其他容器 PID 空间。
3. `bash deploy/host-control.sh restart-clean --env-file .env` 在宿主串行维护锁内操作已登记的原完整 container ID：正常 stop 抑制自动重启 → wait → inspect 确认不运行且没有重启竞争。helper 停止 API 接收新执行，记录所有受影响 Run；不能只停止一个 worker。stop 超时、Docker 不可用、错误 Docker context、绑定不符或只有“找不到旧容器”都不能生成成功证据。
4. 退出确认后，通过仅挂 state 的维护步骤写小型 JSON 证据 `{formatVersion:1,instanceId,previousScopeKey,containerId,verificationId,verifiedAt}`，先临时写后原子替换。证据中的 containerId 必须来自预先核验的作用域绑定，不能随便选择一个已停止容器并抄入旧 scope。helper 与常驻 app 不同时写 SQLite；证据放 runtime 目录，由 app 恢复入口消费。此时再启动 app 并登记新作用域。
5. app 同时验证证据匹配 instanceId / 原作用域 / 原容器绑定、当前 scope 已变化，才解除对应的 PROCESS_CLEANUP_UNCONFIRMED。重复消费证据幂等；半写入或不匹配保持阻塞。原 Run 仍 interrupted、原 command 仍 unknown、Session 队列仍 paused。历史文件损坏等其他阻塞不能一并清除。

完整重启会影响 app 容器内其他项目的活动 Run 及后台服务，执行运维入口时需显示该影响；活动 Run 保留中断记录并暂停队列。它只用于无法确认未知调用状态的故障处理。普通完成、服务启动命令正常返回和空闲 worker 回收无需此操作，后台服务继续运行。

同 scope 内重启 Node 不能解锁；换一个容器、换 boot ID 或复制状态卷也不能凭作用域不同自行解锁。第二个容器的新 PID namespace 不能证明旧容器已退出。旧绑定无法核实时停止自动恢复，按已停机的一致备份恢复流程处理；V1 不实现跨主机接管推断。证据只是单 owner 的受控运维记录，不增加签名系统或声称它是多租户安全隔离。

S06 在 Linux harness 验证阻塞 / 证据状态逻辑；S12 在真实 Docker 中对**尚未返回**的长 Bash SIGKILL worker，确认其结果未知时，同容器 Node 重启和第二容器均不能自动分派后续 Run。正确 helper 停止后核对旧进程退出、标记停止增长、新作用域及队列仍暂停；再注入错误证据、helper 崩溃、stop 超时和半写证据。另以 AT31 对照**已正常返回**的后台服务：它应跨 Run 和空闲回收继续运行，不需要 helper，也不触发 blocked。

## 6. 停止、备份与恢复

S12 提供 `maintenance enter / exit`、`backup --destination <path>`、`restore --source <path>`，并将其真实使用方式写入发布安装说明。

一致备份顺序：进入维护模式，拒绝新变更请求但允许状态查询与停止 → 等待 Run 结束或明确中止 → 确认当前 SDK 调用已结束（未知执行先按故障流程处理）→ 停写 → SQLite checkpoint / backup → 拷贝对应 pi / outputs / 必要配置及 runtime 归属记录 → 记录 manifest 与 hash → 恢复服务。后台服务存活本身不阻塞 app 状态备份；若服务也修改备份范围内的数据，由运维流程先停止该写入。项目代码 / 服务数据的一致备份另按项目执行，不能通过每次 Run 后杀服务来实现。

backup 目的地必须显式指定且不在项目目录。备份包含凭据时应有受限权限及运营者选定的加密存储；不能上传到公开仓库。工具 cache 无需纳入会话备份。

恢复在停止的实例或新状态卷执行，运营者先确认原实例已退出：验证 manifest / hash 与 schema 版本 → 恢复数据库和 pi / outputs / 必要配置 → 修复受控目录映射 → 按 pi 持久状态校验历史并登记新的执行作用域 → 配对设备或确认原设备吊销策略 → 用户明确恢复暂停队列后继续指定会话并校验文件与历史。不能用新卷 / 新 instanceId 绕过原有的清理或历史阻塞。

备份测试必须在新卷实际恢复，不能只判断命令退出 0 或压缩包存在。普通升级先备份，迁移失败不接受任务；回滚使用兼容镜像与备份恢复，不承诺任意新 schema 可直接被旧代码读取。

## 7. 故障处理边界

| 现象 | 检查与行为 |
| --- | --- |
| 无法写项目文件 | doctor 校验 UID/GID、挂载及 owner；修正授权目录，不全局 chmod 777 |
| 手机连上但无事件 | 区分 ticket 认证、Session 授权、cursor / 缺口和 proxy upgrade；不能重新执行 prompt 来“刷新” |
| 模型不可用 | 显示可修正的鉴权 / 模型错误；不输出配置内容 |
| 未完成调用崩溃且状态不明 | workspace blocked，确需整环境恢复时使用 host-control restart-clean；原命令不重跑，队列不自动恢复 |
| 命令返回后服务还在运行 | 正常行为，允许后续 Run 继续使用；通过 Bash 管理服务，不触发清理门槛 |
| pi 历史缺失 / 损坏 | HISTORY_UNAVAILABLE，保护原文件；恢复匹配备份并校验，不直接 SDK open 创建空会话 |
| 空会话没有 JSONL | uninitialized / unflushed 时可正常重建，重放 SQLite 已确认配置；不是默认的损坏告警 |
| SQLite 写失败 / 磁盘满 | 停止接收新任务，停止继续生成无法保存的输出，告知恢复需求 |
| 主机重启 | 恢复已保存状态，活动 Run 中断、相关队列暂停；重新核验运行归属和清理证明、项目挂载后才允许执行 |

参考：[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)、[容器运行与权限](https://docs.docker.com/engine/containers/run/)、[SQLite WAL](https://sqlite.org/wal.html)。
