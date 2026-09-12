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

这里的容器是用户的 Linux 开发环境，所有 pi 能力遵循[整体 TUI 体验原则](tui-experience.md)，Bash 另有[逐项对照](bash-compatibility.md)。原生资源、扩展、开发工具和网络按相同配置加载，工具链、网络与权限应按项目配置齐全。

## 2. 镜像与目录

多阶段构建：构建阶段用固定 Node 24 LTS Debian slim 与 pnpm / lockfile；运行阶段只带编译产物、生产依赖、Node、Git、bash、Python 3、CA 证书、openssh-client、tini 和 flock 所需工具。编译器按首批项目工具链需要加入，版本在 S12 固定并记录镜像 digest。

运行用户为非 root，默认 UID/GID 1000；部署变量 `PI_REMOTE_UID / PI_REMOTE_GID` 可对应宿主机目录。不要使用宿主机 root 身份运行 agent 来规避权限问题。首次创建卷由管理员或专门初始化步骤设置所有权；常驻服务不反复递归 chown 项目目录。

| 路径 | 行为 |
| --- | --- |
| `/app` | 应用编译产物，运行时不修改 |
| `/state/app.sqlite` | SQLite 与同目录 WAL / SHM，主进程统一写入 |
| `/state/pi` | 指定 SDK agentDir / session 存储，凭据受限 |
| `/state/outputs` | artifact 临时写入与封存，默认总量限制 |
| `/state/runtime` | 可选的当前进程 / epoch 诊断信息，不是启动许可或清理证明库 |
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
| PI_REMOTE_MAX_ACTIVE_RUNS | 未设置时不额外限制；运营者可按实际资源设置正整数 |
| PI_REMOTE_MAX_LOADED_WORKERS | 未设置时不额外限制；设置后与已配置的活动 Run 上限共同决定可调度容量 |
| PI_REMOTE_MAX_QUEUED_COMMANDS | 未设置时不额外限制；设置后作为实例待执行命令容量，不阻挡 respond / abort 等控制 |
| PI_REMOTE_WORKER_IDLE_SECONDS | 0，默认不自动回收已加载 Session；正值为运营者开启的空闲回收策略 |
| PI_REMOTE_SERIALIZE_WORKSPACE | false；有实际需要时可配置同工作区串行 |
| PI_REMOTE_ALLOWED_ORIGINS | 如有浏览器客户端则显式允许；原生 App 仍必须鉴权 |
| PI_REMOTE_DEFAULT_PROVIDER / MODEL | 运营者选择已配置模型；缺失时 UI 可选模型，运行前必须解析成功 |
| PI_REMOTE_MODEL_TIMEOUT_MS | 15000，仅用于 catalog / 鉴权的单次网络请求，不用于整个初始化、资源加载、UI 等待或 agent 任务 |
| pi 资源 / 扩展设置 | 使用原生 DefaultResourceLoader、SettingsManager 与信任流程，不设置应用级默认关闭开关 |

默认模型、工具链、项目挂载及实例配置在后端部署时设置。模型 API key / OAuth 配置放专用 pi 目录或运行时秘密注入，不写进镜像层、Compose 提交、命令行示例或 Git。

OAuth 可能需要刷新并写入状态；只读挂载 auth.json 时不能假设 SDK 可以在原地刷新。用受限可写凭据卷并验证多 worker 刷新行为；S02 若发现共享凭据竞争，要实现串行刷新或由统一配置层协调，再完成部署。

## 4. Compose 必须具备的行为

- `init: true` 或等效 init；优雅 TERM，`stop_grace_period` 至少 30 秒，覆盖 15 秒 worker 停止窗口。
- `restart: unless-stopped`，服务 crash 后可重启；准确记录中断，不自动重跑旧未知命令。
- app 容器只挂必要项目和 state，不开启 privileged，不默认挂 Docker socket。
- 沿用普通 Docker 权限基线；不额外默认叠加 capability 裁剪、no-new-privileges 或只读 HOME。运营者主动收紧时验证所需开发工具，并记录实际影响；不能只凭容器配置宣称有多租户沙箱。
- 单实例锁 `/state/instance.lock`，第二个 app 不能同时对同一状态卷运行。不要设置两个副本共享 SQLite。
- readiness 在迁移、数据库状态恢复和单实例锁完成后成功；不依赖宿主进程登记或清理证明。模型待配置、项目路径错误等按相关操作报告，不妨碍其他项目与列表操作。
- 设置运行日志轮转、可配置的容器资源和手机展示上限；展示配额不得裁剪 SDK 的模型结果或终止 Bash。日志不记录 Authorization、WS ticket、pairing token 或模型凭据。没有应用级 Bash 默认时限。
- 开发 HTTP 入口只用于明确的本地测试。真实手机接入验收使用有效 HTTPS / WSS；不长期依赖放宽 Android cleartext 或 iOS ATS。

Linux 容器中的 localhost 指向自己。项目需要外部数据库、宿主机服务、VPN 或私有 Git 时，部署者明确配置网络与凭据。若项目需要 Docker / Compose，单独设计该执行能力，不把宿主机 daemon socket 作为默认依赖。

## 5. S12 应实现的操作入口

以下是命令契约，尚未实现：

```sh
docker compose --env-file .env -f deploy/compose.yaml build
docker compose --env-file .env -f deploy/compose.yaml up -d
docker compose --env-file .env -f deploy/compose.yaml exec app node apps/server/dist/cli.js doctor
docker compose --env-file .env -f deploy/compose.yaml exec app node apps/server/dist/cli.js pair --ttl 600
```

直接 compose up 即可启动完整服务。撤回 host-control / restart-clean 及“登记后才可运行”的必需流程；不为预计的残留进程问题增加正常部署前置。需要的工具链、资源目录和用户配置一次配置后按原生 pi 使用。

doctor 检查目录 / 权限、工具链、SQLite、模型网络、原生资源加载、具体历史错误、当前运行及旧队列状态。它报告实际问题，不要求清理凭证、不把所有诊断变成执行门槛；不打印密钥。

pair 在管理终端生成高熵单次 token 或包含它的 QR，10 分钟过期；手机交换设备 token，服务端只留摘要。重新配对不复用旧秘密；设备可从 API / CLI 吊销。

镜像构建和初始化不能偷偷读取开发者的个人 pi 或 SSH 目录。明确的项目配置、凭据和宿主机路径只在部署时注入。

### 5.1 根据实际故障恢复

默认用 SDK 的 abort / dispose 和正常容器信号处理。Bash detached 进程组与 worker 不同是已知事实，因此不能仅凭 worker PID 消失就伪造工具成功或退出；这也不构成预先禁止命令或永久锁项目的依据。

异常时封存已知内容、标明 interrupted / unknown、停止自动重复旧命令。仅有旧后续项时暂停它们；用户仍可主动新对话、检查进程或改模型，其他 Session 不受全局封锁。若确实发现残留，再按 PID / 启动标识定向处理；明确需要重启整个环境时使用普通 Compose 操作，并说明会终止哪些运行及后台服务。

正常 nohup、setsid、开发服务器和 watcher 可跨 Run、归档及页面切换继续。默认不自动回收已加载 Session；运营者启用回收时也不能额外杀已正常返回的后台服务。SDK 若仍等待输出则保留运行状态，不伪造完成。

executionScopeKey 可由 boot ID、PID namespace 和启动标识记录，仅作诊断，不提供跨容器 / 跨主机唯一 writer 保证。单实例锁保护同一 SQLite，不把共享工作区包装成多租户沙箱。S06 / S12 验证真实中断、无自动重跑及后续主动操作可用；若测试暴露具体问题，再记录并修复相关适配。

## 6. 停止、备份与恢复

S12 提供 `maintenance enter / exit`、`backup --destination <path>`、`restore --source <path>`，并将其真实使用方式写入发布安装说明。

一致备份顺序：进入维护模式 → 等待当前 SDK 调用结束或明确停止 → 停写 → SQLite checkpoint / backup → 拷贝 pi / outputs / 必要配置 → 记录 manifest 与 hash → 恢复服务。后台服务存活本身不阻塞 app 状态备份；若服务修改备份范围内数据，再停止对应写入。不能通过每次 Run 后杀服务来实现备份。

backup 目的地必须显式指定且不在项目目录。备份包含凭据时应有受限权限及运营者选定的加密存储；不能上传到公开仓库。工具 cache 无需纳入会话备份。

恢复在停止的实例或新状态卷执行：验证 manifest / hash 与 schema → 恢复数据库和 pi / outputs / 配置 → 校验目录与指定历史 → 配对设备或确认原设备吊销策略 → 主动继续指定会话并校验结果。旧待处理后续项可选择恢复或取消，空队列无需额外解锁。

备份测试必须在新卷实际恢复，不能只判断命令退出 0 或压缩包存在。普通升级先备份，迁移失败不接受任务；回滚使用兼容镜像与备份恢复，不承诺任意新 schema 可直接被旧代码读取。

## 7. 故障处理边界

| 现象 | 检查与行为 |
| --- | --- |
| 无法写项目文件 | doctor 校验 UID/GID、挂载及 owner；修正授权目录，不全局 chmod 777 |
| 手机连上但无事件 | 区分 ticket 认证、Session 授权、cursor / 缺口和 proxy upgrade；不能重新执行 prompt 来“刷新” |
| 模型不可用 | 显示可修正的鉴权 / 模型错误；不输出配置内容 |
| 未完成调用崩溃且状态不明 | 显示 interrupted / unknown，不重跑旧命令；主动新操作可用，实际发现残留再定向处理 |
| 命令返回后服务还在运行 | 正常行为，允许后续 Run 继续使用；通过 Bash 管理服务，不触发清理门槛 |
| pi 历史缺失 / 损坏 | HISTORY_UNAVAILABLE，保护原文件；恢复匹配备份并校验，不直接 SDK open 创建空会话 |
| 空会话没有 JSONL | uninitialized / unflushed 时可正常重建，重放 SQLite 已确认配置；不是默认的损坏告警 |
| SQLite 写失败 / 磁盘满 | 停止接收新任务，停止继续生成无法保存的输出，告知恢复需求 |
| 主机重启 | 恢复已保存状态，活动 Run 中断、有旧后续项才暂停；校验挂载和历史后正常接受新操作，无宿主清理证明前置 |

参考：[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)、[容器运行与权限](https://docs.docker.com/engine/containers/run/)、[SQLite WAL](https://sqlite.org/wal.html)。
