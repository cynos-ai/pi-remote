# 数据模型与事务约定

状态：待实现规范。可执行的设计附件为 [schema-v1.sql](schema-v1.sql)，S04 将其纳入迁移，不能仅在启动时无条件执行整份 SQL。首次迁移、重复启动、备份恢复和升级都需要测试。

## 1. 存储所有权

| 内容 | 权威来源 |
| --- | --- |
| 用户、设备、项目、标题、归档、命令状态 | SQLite |
| 已提交的手机事件、待答交互、历史显示 | SQLite |
| 模型对话上下文、树节点、压缩摘要 | 已落盘的 pi JSONL；未落盘时没有可恢复的模型上下文 |
| 模型 / 等级 | 首次落盘前为 SQLite 已确认配置；落盘后以校验过的 pi 文件中实际配置校准 |
| 源代码与工具创建的项目文件 | `/workspaces` 挂载 |
| 已保留的大输出 | `/state/outputs` 文件 + artifacts 元数据 |

title 从应用同步到 pi 的显示名，携带 Session version，旧版本回调不能覆盖新标题。模型与等级在首次 JSONL 落盘前必须保存在 SQLite；每次重建空 worker 都重放这些已确认配置。恢复持久会话时读 pi 文件校准，但不覆盖应用标题 / 归档。配置调用抛错也要读取 SDK 的实际值：例如 setModel 先修改模型再等待扩展 hook，不能假称失败已回滚；仍存活时写 session.updated 及 command.result.actualConfig，崩溃时按下述持久状态恢复。

pi_session_file 必须来自 SDK 创建结果并位于配置的会话存储目录；恢复按应用 sessionId 找指定文件，不使用 continueRecent，也不接收手机传入的 JSONL 路径。

### 空 Session 与持久历史

固定 SDK 的 `SessionManager.create()` 会分配 ID / 路径，但通常等第一条 assistant 消息才写文件；改名、切模型或等级不保证写文件。`SessionManager.open()` 对缺失或空文件可能初始化新会话，因此应用必须先检查，不能把 open 当成存在性验证。

| pi_persistence_state | 不变量及加载动作 |
| --- | --- |
| uninitialized | 尚无 SDK 映射。创建 manager 后先把 ID / 路径及 unflushed 标记提交 SQLite，收到持久化 ACK 后 worker 才可执行 prompt 或修改 SDK 配置 |
| unflushed | 已分配 SDK 映射，但尚未确认首次落盘。文件不存在是合法状态；确认旧 worker 已停止后可创建新的 manager / 映射，再应用 SQLite 的模型、等级与标题；不调用 open(缺失路径) |
| persisted | 已确认指定 JSONL 含有效 header、匹配 ID / cwd、可解析的 entry 关系及至少一条 assistant 消息。只能从该文件恢复；不自动降级为 unflushed 或换 ID |

首次落盘通知通过 IPC 由主进程确认并持久化标记。worker 的 ID / 文件映射必须在任何可能落盘的 SDK 操作之前已获 ACK，避免产生无法归属的历史。启动或重新加载时，即使标记仍是 unflushed，也必须先检查原路径：有效且匹配的已落盘文件要认领为 persisted，覆盖“文件已写、标记未提交”的崩溃窗口，然后从中恢复真实配置。

任何状态下已有文件为空、损坏、身份不符或仅有首次写入残片，都设置 `history_error_code=HISTORY_UNAVAILABLE` 并阻止 SDK open 与执行，保留原文件等待运维恢复。persisted 文件缺失同样阻断；只有 uninitialized / unflushed 且文件确实不存在才允许空初始化。数据库标记不是授权覆盖损坏文件的理由。S02 / S06 分别验证 SDK 行为与应用恢复策略。

首次 assistant 落盘前崩溃，手机的已提交部分输出仍保留为中断历史，但不代表它已进入可恢复模型上下文；产生明确的 context_not_persisted notice。未知命令不自动重跑。恢复备份后重新校验原映射才可清除 history_error_code。SQLite 与 JSONL 不承诺跨文件原子提交。

## 2. 表与字段

业务核心是 projects / sessions，其余表支撑可靠执行与连接。它们共享一个 SQLite 文件，不新增数据库服务。

| 表 | 用途与关键约束 |
| --- | --- |
| users | V1 初始化唯一 owner，保留数据归属 |
| devices | 一个设备一个高熵凭据，数据库只存摘要，可吊销 |
| pairing_tokens | 短期单次配对 token，原值不持久化 |
| projects | Linux root_path 唯一，root_identity 为 device:inode；workspace_key 决定串行范围；blocked_reason / blocked_scope_key 保存清理阻塞 |
| sessions | 项目 FK、标题 version、pi 映射及持久状态、历史错误、queue_state / queue_version / 暂停原因、last_event_seq、当前未完成内容投影 |
| commands | 所有持久变更的初始收据 response_json 与独立最终结果 result_json；非空 scope 防止创建资源时空 sessionId 导致幂等失效 |
| runs | 每次 prompt / compact；一个 Session 最多一个 active Run，queued 可有多个；分派前保存 execution_scope_key |
| events | PK(session_id,seq)，属于 Run 的事件通过复合 FK 保证同 Session |
| ipc_batches | workerEpoch + batchNo 去重，提交后返回相同 ACK |
| timeline_items | 封存消息 / 工具结果不可变，包括中断的 partial；必带同 Session 的 run_id、completeness / end_reason，保留开始及封存 seq |
| interactions | pending 请求、到期时间、workerEpoch、一次性回答 CAS |
| artifacts | 服务端生成的相对路径、大小、摘要，下载时检查会话归属 |

ID 使用服务端 UUID，客户端幂等键使用 UUID；引用对客户端是不透明字符串。数据库时间使用 UTC epoch 毫秒，网络时间使用 RFC3339 UTC。JSON 在数据库为经过 schema 验证的文本。不要依赖隐式 rowid、混合时间格式或浮点 seq。

Session 的 version 仅随配置与元数据变化递增，不随每个 token 变化。客户端改名 / 归档及配置命令带 expectedVersion；并发修改失败为 VERSION_CONFLICT。事件序号与 metadata version 含义不同。

queue_version 独立于 Session version：队列增删、暂停、恢复均递增。ready 时暂停字段必须为空；paused 时必须指向同 Session 的异常终态 Run 和原因。共享 workspace_key 的项目一起设置进程清理阻塞；Session 队列暂停不会代替工作区锁。

## 3. 命令接收事务

所有持久业务变更携带 `Idempotency-Key`。scope 为规范化的 `METHOD:/v1/资源路径`，包含真实资源 ID、不包含 query 或凭据；例如 `POST:/v1/projects`、`POST:/v1/sessions/<id>/commands`。唯一键为 user_id + scope + client_command_id，不能只按消息文本去重。配对和短期 WS ticket 遵守协议规定的单次规则，不进入此命令表。

处理顺序：鉴权、JSON schema 校验和 payload 规范化 → 在事务外查幂等键作为快路径 → 进入 session / project mutex（资源创建使用 owner / scope 锁）并开始短写事务 → **再次查幂等键，再检查 busy、version、队列容量等可变条件** → 原子预留操作权并写入。两次查询都遵循同键同 payload 返回原 HTTP 状态及收据，同键异 payload 返回 IDEMPOTENCY_CONFLICT。事务外 miss 不代表本请求是首个请求。

唯一键冲突作为最后保护：回滚失败事务后读取胜出的已提交收据，再比较 payload_hash，返回原收据或 IDEMPOTENCY_CONFLICT；不能泄漏 SQL 异常或改成 SESSION_BUSY / VERSION_CONFLICT。哈希对 schema 规范化后的请求求值，不能混入随时间变化的当前默认模型等状态。S05 必须用屏障让两个完全相同请求同时错过快路径，验证此竞态。

- 资源创建 / PATCH 在同一个事务写资源、完成的 command 及相应 session 事件，返回 201 / 200。
- prompt / follow_up / compact 在同一个事务写 queued command、queued Run、事件及 live_state，提交后返回 202。
- steer / abort / respond / 配置命令不创建新 Run，写 command 及事件，提交后通过控制通道分派。
- cancel_queued / resume_queue 在接收短事务内完成应用队列变更和 completed command，返回 200；不排入 worker 控制队列。
- 保存 schema 校验后的标准化 payload，并对稳定的规范 JSON 求 SHA256；对象字段顺序不同不视为内容不同。
- 重试保留初次接收的 response_status / response_json，后续不可覆盖。最终结果（包括 result.actualConfig）在 command.updated 的同一事务写入独立 result_json，GET command 读取当前 state / error_code / result_json；旧收据不伪装成新一轮接收。

首次 pairing 不使用此幂等表。token 在 SQLite 事务内只消费一次，响应丢失后在管理 CLI 重新生成配对 token，不重复返回设备秘密。

## 4. 事件与投影事务

单主进程串行写库，开启 WAL、foreign_keys、busy_timeout=5000、synchronous=FULL。文件必须在本机磁盘；WAL 不用于跨主机共享数据库。

一次 worker 批次的事务：

1. 核对 sessionId / workerEpoch，查 ipc_batches。已提交的同批次返回原 seq 范围；同号异内容报错。
2. 读取 last_event_seq，给本批规范事件分配连续 seq。
3. 插入 events，同时更新 runs / commands / interactions，使用同一 reducer 更新 sessions.live_state_json；封存项写入 timeline_items。异常终态的 run.content_sealed、交互关闭、Run 终态及队列暂停事件在同一事务内提交。
4. 更新 Session / Project 活动摘要和 last_event_seq，插入 ipc_batches，提交。
5. 提交后 ACK worker，并唤醒 WSS 订阅者读取已提交记录。

事务中不等待模型、工具、网络、手机响应或磁盘大文件流。主服务自身产生的资源 / 状态事件使用同一写入入口，确保同一 Session 只有一个序号分配源。

序号可以在批内先计算，但事务回滚后不能提前广播。SQLite 写入失败时不要向手机报告成功；停止该会话继续执行，保留明确故障状态，避免无限生成未保存输出。

## 5. 快照、历史及无缝回放

`GET snapshot` 在一个 SQLite 读事务里读取 Session、当前 Run / 队列及暂停状态 / pending interactions、live_state 和最后 50 个已封存 timeline_items，捕获 `S=last_event_seq`。返回状态代表 exactly-through-S，手机从 S+1 接续。

快照包含所有仍打开的内容项，封存历史项不可变。历史分页 cursor 包含 `sessionId, atSeq=S, beforeOrdinalSeq, beforeItemId` 并防篡改；查询使用 `finalized_seq <= S` 和 `(ordinal_seq,item_id)` 的确定排序。消息或工具在 S 之后正常完成或被 run.content_sealed 封存时，通过后续事件从 live 状态转入历史；不会混入旧快照的历史页。异常封存保留已经接收的内容，不能捏造完整参数、工具结果或退出码。

live_state 仅保存未完成内容及必要状态，已完成大历史由 timeline_items 分页加载。不为每个 token 复制完整历史。单个未完成工具快照保留有界尾部，完整保留内容转 artifacts。

客户端同时原子保存 reducer 状态和最后连续应用的 seq；恢复时不能只保留 cursor 而丢掉其对应状态。数据坏了或协议不兼容时重新获取 snapshot。

## 6. 运行与交互恢复

分派前先把 command 标为 dispatching，记录 epoch 和 Run 的 execution_scope_key，再发送 IPC。worker 的接受事件将其变为 accepted。acceptance ACK 丢失不能自动重发 prompt；它属于未知副作用窗口。作用域与清理证明按 [部署约定](deployment.md) 执行，不能只凭 worker PID / PGID 判断 Bash 已停止。

启动恢复在允许新运行前完成：

- 先识别旧执行作用域和 worker 清理状态；同一作用域重启主进程不能清除进程清理阻塞。
- dispatching / accepted 的不明命令 → unknown；其原始执行 Run 或 target_run_id 指向的非终态 Run → interrupted。关联已终态 Run 不改写历史结果。
- pending interaction 的内存回调已丢失 → cancelled，保存原因 restart。
- 对每个新进入 failed / aborted / interrupted 的 Run，先封存仍打开的消息 / 工具，再写终态并暂停该 Session 队列，即使队列目前为空也暂停。
- 按下表分类尚未分派命令，写状态事件；按持久状态校验 JSONL 并恢复，不补造未保存事件。
- 清理证明成立才解除对应工作区的进程阻塞；历史损坏等其他阻塞不能一起清除。PID 校验包含启动标识，不能误杀复用 PID 的其他进程。

| queued 命令种类 | 重启行为 |
| --- | --- |
| prompt / follow_up / compact，且 dispatched_at 为空 | 保留；只有 queue_state=ready、历史可恢复且工作区无阻塞才调度。被异常 Run 影响的同 Session 队列保持 paused |
| steer / abort / respond | cancelled，reason=stale_runtime；不把旧目标控制或旧回调送入新 worker / Run |
| set_model / set_thinking | cancelled，reason=restart_before_dispatch；重新读取有效配置后由用户发新请求，不重放旧 version |
| cancel_queued / resume_queue、资源创建与元数据 PATCH | 应已在接收事务内 completed；若持久数据出现 queued 属于不变量损坏，报告恢复错误，不猜测重放 |

正常 completed Run 允许调度后续队列；failed / aborted / interrupted 一律暂停；取消尚未开始的 queued Run 不新增暂停，也不清除已有暂停。用户可逐条 cancel_queued，然后以当前 queueVersion 和暂停 runId 调用 resume_queue（空队列也需明确恢复）。resume_queue 与校验、事件同事务完成；进程清理或历史阻塞未解除时拒绝。App 重连、归档 / 恢复和后端重启都不隐式恢复暂停队列。

回答交互时，事务 CAS `status=pending`、未过期且匹配 epoch / runId，保存响应 commandId。第二个不同请求再回答返回 INTERACTION_CLOSED。保存后向 worker 投递回调也存在不明窗口；worker 退出后标记中断，不能把回答应用到新 worker。

只有活动 prompt / compact Run 内的受支持对话框能进入 interactions。initialize / configure 等无 Run 阶段立即返回 SDK 取消值并记录 extension_ui_unavailable notice，不插 pending 行；run_id 的非空约束据此保留。

## 7. 大输出与备份

artifact 文件名由服务生成，路径只在 `/state/outputs` 下；先写临时文件并完成大小 / hash 校验，再原子改名，提交元数据和引用事件。下载只接受 artifactId，经 Session 归属校验后解析受控相对路径，不接受服务器任意路径。

默认单 artifact 上限 20 MiB、单 Session 保留输出总量 100 MiB，可配置；达到限制产生 output_truncated notice。SDK 自身已截断且未留全量时，明确标记无法提供完整输出。

V1 不自动裁剪 events。后续有保留策略时必须增加 cursor 过期与基线快照，不允许静默跳过旧事件。

一致备份的默认流程是暂停新命令、等待 Run 结束或明确停止、停写、检查 WAL、备份 SQLite 与 pi / outputs；恢复到新状态卷验证。运行中单独复制 app.sqlite 可能遗漏 WAL，不能作为备份方式。具体命令在 S12 实现。

## 8. 将来迁移 PostgreSQL 的条件

多个 API 实例跨机器共享状态、独立写入竞争明显或需要数据库高可用时再评估 PG。迁移包含 schema / 数据转换、所有权与任务租约，不只是更换连接字符串。V1 保留数据访问模块和迁移版本，先实现一套 SQLite 后端。
