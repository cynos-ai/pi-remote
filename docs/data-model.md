# 数据模型与事务约定

状态：待实现规范。可执行的设计附件为 [schema-v1.sql](schema-v1.sql)，S04 将其纳入迁移，不能仅在启动时无条件执行整份 SQL。首次迁移、重复启动、备份恢复和升级都需要测试。[原生运行补充契约](native-runtime-contract.md)规定无 Run 内容、原生输入、标题及会话替换的同步边界。

## 1. 存储所有权

| 内容 | 权威来源 |
| --- | --- |
| 用户、设备、项目、标题、归档、命令状态 | SQLite |
| 已提交的手机事件、待答交互、历史显示 | SQLite |
| 模型对话上下文、树节点、压缩摘要 | 已落盘的 pi JSONL；未落盘时没有可恢复的模型上下文 |
| 模型 / 等级 | 首次落盘前为 SQLite 已确认配置；落盘后以校验过的 pi 文件中实际配置校准 |
| 源代码与工具创建的项目文件 | `/workspaces` 挂载 |
| 已保留的大输出 | `/state/outputs` 文件 + artifacts 元数据 |

标题变更可来自手机 rename 或 pi 的 session_info_changed，SQLite 保存确认值与 version；应用写入回声去重，扩展主动改名按顺序提交并广播。live_state.metadataSync 保存待同步意图、水位和来源，不只比较字符串，覆盖 A→B→A、并发及重启。恢复时有明确未同步手机意图才重放，否则从有效 pi session info 校准；归档始终由应用维护。具体规则见补充契约第 4 节。

模型与等级在首次 JSONL 落盘前保存在 SQLite，每次重建空 worker 重放确认配置；持久恢复时读取 pi 的实际值。配置 API 失败或扩展错误监听上报时都读取实际配置，写 session.updated 及可关联的 command.result.actualConfig，不假称回滚。setModel 的 hook 错误不保证 reject；setThinkingLevel 返回也不表示其异步 hook 完成，子 Operation 和表单可继续有效。

pi_session_file 必须来自 SDK 创建结果并位于配置的会话存储目录；恢复按应用 sessionId 找指定文件，不使用 continueRecent，也不接收手机传入的 JSONL 路径。

手机历史找回将服务管理目录内、经过完整校验且 cwd 匹配项目的既有 JSONL 认领为新的 persisted Session。沿用 sessions 的 pi_session_id / pi_session_file 映射与 commands 的幂等收据，在同一 SQLite 事务内核对既有映射、创建 Session 和 history_import 内部收据。无需新增表或数据库迁移；model / thinking 初始为空，worker 加载原历史后发布实际配置，不用项目默认值覆盖原上下文。认领不写 JSONL、不重放旧 Command，也不把旧 JSONL 合成为既有手机事件。列表与导入之间发生删除或损坏会重新校验失败；导入后再被外部改坏仍由正常 worker 持久校验保护。

### 空 Session 与持久历史

固定 SDK 的 `SessionManager.create()` 会分配 ID / 路径，但通常等第一条 assistant 消息才写文件；改名、切模型或等级不保证写文件。`SessionManager.open()` 对缺失或空文件可能初始化新会话，因此应用必须先检查，不能把 open 当成存在性验证。

| pi_persistence_state | 不变量及加载动作 |
| --- | --- |
| uninitialized | 尚无 SDK 映射。创建 manager 后先把 ID / 路径及 unflushed 标记提交 SQLite，收到持久化 ACK 后 worker 才可执行 prompt 或修改 SDK 配置 |
| unflushed | 已分配 SDK 映射，但尚未确认首次落盘。文件不存在是合法状态；确认旧 worker 已停止后可创建新的 manager / 映射，再应用 SQLite 的模型、等级与标题；不调用 open(缺失路径) |
| persisted | 已确认指定 JSONL 含有效 header、匹配 ID / cwd、可解析且符合原生格式的 entry 关系；合法 header-only / 非 assistant 历史也成立。只能从该文件恢复；不自动降级为 unflushed 或换 ID |

首次落盘通知通过 IPC 由主进程确认并持久化标记。应用初次创建 manager 时先确认映射再执行；原生 fork / import 可能先写文件再返回 manager，因此先持久化替换意图，取得目标后校验并认领映射，再绑定会产生新执行的回调。失败时保留可识别的未认领文件，不盲目重做 fork。new / switch / fork / import 的旧、新 Session 时间线不混用；runtime factory / setRebindSession 交接见补充契约第 5 节。

启动或重新加载时，即使标记仍是 unflushed，也先检查原路径：有效且匹配的文件认领为 persisted，覆盖“文件已写、标记未提交”的窗口，然后恢复真实配置。首次 assistant 触发自动落盘的观察不能用作所有合法文件的必要条件。

任何状态下已有文件为空、损坏、身份不符或仅有首次写入残片，都设置 `history_error_code=HISTORY_UNAVAILABLE` 并阻止 SDK open 与执行，保留原文件等待运维恢复。persisted 文件缺失同样阻断；只有 uninitialized / unflushed 且文件确实不存在才允许空初始化。数据库标记不是授权覆盖损坏文件的理由。S02 / S06 分别验证 SDK 行为与应用恢复策略。

首次 assistant 落盘前崩溃，手机的已提交部分输出仍保留为中断历史，但不代表它已进入可恢复模型上下文；产生明确的 context_not_persisted notice。未知命令不自动重跑。恢复备份后重新校验原映射才可清除 history_error_code。SQLite 与 JSONL 不承诺跨文件原子提交。

## 2. 表与字段

业务核心是 projects / sessions，其余表支撑可靠执行与连接。它们共享一个 SQLite 文件，不新增数据库服务。

| 表 | 用途与关键约束 |
| --- | --- |
| users | V1 初始化唯一 owner，保留数据归属 |
| devices | 一个设备一个高熵凭据，数据库只存摘要，可吊销 |
| pairing_tokens | 短期单次配对 token，原值不持久化 |
| projects | Linux root_path / root_identity 归一重复目录；workspace_key 表达路径关系，默认不强制串行；blocked_reason 仅报告真实路径不可用等错误 |
| sessions | 项目 FK、标题 version、pi 映射及持久状态、历史错误、queue_state / queue_version / 暂停原因、last_event_seq、当前未完成内容投影 |
| commands | 所有持久变更的初始收据 response_json 与独立最终结果 result_json；非空 scope 防止创建资源时空 sessionId 导致幂等失效 |
| runs | 每次 prompt / compact，唯一 operation_id；source 为 command / extension / runtime，command_id 可空且非唯一；一个 Session 最多一个 active Run，queued 可有多个；分派前保存 execution_scope_key |
| events | PK(session_id,seq)，operation_id 与可空 run_id 记录执行归属；Run 复合 FK 保证同 Session，Operation 关系由事件事务校验 |
| ipc_batches | workerEpoch + batchNo 去重，提交后返回相同 ACK |
| timeline_items | 封存消息 / 工具结果不可变，包括中断 partial；必带 operation_id、可空同 Session run_id、completeness / end_reason，保留开始及封存 seq |
| interactions | operation_id、origin、可空 run_id / command_id、workerEpoch、pending / 到期及一次性回答 CAS |
| artifacts | 服务端生成的相对路径、大小、摘要，下载时检查会话归属 |

ID 使用服务端 UUID，客户端幂等键使用 UUID；引用对客户端是不透明字符串。数据库时间使用 UTC epoch 毫秒，网络时间使用 RFC3339 UTC。JSON 在数据库为经过 schema 验证的文本。不要依赖隐式 rowid、混合时间格式或浮点 seq。

Session 的 version 仅随配置与元数据变化递增，不随每个 token 变化。客户端改名 / 归档及配置命令带 expectedVersion；并发修改失败为 VERSION_CONFLICT。事件序号与 metadata version 含义不同。

queue_version 独立于 Session version：队列增删、暂停、恢复均递增。ready 时暂停字段为空；paused 时指向同 Session 的异常终态 Run 和原因，且必须仍有待处理后续项。空队列 / 取消最后一项时清空 pause 并变 ready；新 prompt 和配置操作不受旧队列暂停限制。

后续队列成员由 queue.updated.items 投影到 sessions.live_state_json，与 queue_state / queue_version 同事务保存；不能把所有 queued 命令都当成暂停队列成员。新主动 prompt / compact 走直接调度，控制命令不进入后续队列；崩溃恢复将受中断影响且从未分派的旧执行项归入暂停成员。SQL CHECK 约束状态字段形状；成员存在、命令仍 queued 及空队列变 ready 由事务 / reducer 校验，S04 / S07 验证。

撤回 PROCESS_CLEANUP_UNCONFIRMED / blocked_scope_key 的默认封锁及容器清理证明协议。Run 的 scope / PID 仅作诊断，unknown 只表示旧命令结果未知，不成为整个项目的新操作禁令。已提交的 tool.finished 不因后续 worker 退出被改写；不同 Session 和正常后台服务默认可并行。

Operation 覆盖 initialize / configure / run / bash / extension；持久事件维护 activeOperations，不另设操作调度表。无模型内容和表单可以独立存在；延迟 custom 交付由独立子 Operation 承载，父操作结束不取消子操作。interactions.operation_id 非空、origin 明确；origin=run 必须关联同 Session Run，应用层校验操作、epoch 和 Run 对应关系。

custom UI 工厂使用独立 extension 子 Operation 跨多次 select/input 控件存活，done/明确取消/异常后封存其生命周期。画面保存在既有 runtime.notice 与 snapshot.notices，按 Operation 投影；原始 done 对象和组件只留在 worker 内存，不建表、不迁移数据库。重启照常取消旧交互，客户端不单独展示失去待答控件的旧画面。

overlay 复用上述画面和表单；其 handle、几何、焦点和输入监听仅存在于该 custom 的虚拟 TUI 内存，不持久化 SDK 对象，不因重放旧画面重新创建组件。

Run / Interaction 的 command_id 是因果来源，允许多个 Run 共用一条 Command，也允许没有外部 Command。原生替换后 S1 的 Command 可产生 S2 的执行；存储事务必须沿 projects.user_id 验证同 owner，不要求来源同 Session。target_run_id 与 response_command_id 是定向控制，仍由复合 FK 要求同执行 Session。参考 SQL 不独立保证跨表 owner 校验，S04 必须测试允许的同 owner 路径和被拒绝的跨 owner 路径。

SDK 内输入按 inputId 保存到 live_state 的 pendingInputs / recoveredInputs，完整内容含附件引用。input.updated 区分 queued / consumed / returned / unknown；stop 返回未消费草稿，不自动重发。该投影与应用 queue.updated 后续 Run 队列分开；clearQueue 仅返回文本，不能据此丢掉附件。compact 的原生队列行为单独验证。

## 3. 命令接收事务

所有持久业务变更携带 `Idempotency-Key`。scope 为规范化的 `METHOD:/v1/资源路径`，包含真实资源 ID、不包含 query 或凭据；例如 `POST:/v1/projects`、`POST:/v1/sessions/<id>/commands`。唯一键为 user_id + scope + client_command_id，不能只按消息文本去重。配对和短期 WS ticket 遵守协议规定的单次规则，不进入此命令表。

处理顺序：鉴权、JSON schema 校验和 payload 规范化 → 在事务外查幂等键作为快路径 → 进入 session / project mutex（资源创建使用 owner / scope 锁）并开始短写事务 → **再次查幂等键，再检查 busy、version、队列容量等可变条件** → 原子预留操作权并写入。两次查询都遵循同键同 payload 返回原 HTTP 状态及收据，同键异 payload 返回 IDEMPOTENCY_CONFLICT。事务外 miss 不代表本请求是首个请求。

唯一键冲突作为最后保护：回滚失败事务后读取胜出的已提交收据，再比较 payload_hash，返回原收据或 IDEMPOTENCY_CONFLICT；不能泄漏 SQL 异常或改成 SESSION_BUSY / VERSION_CONFLICT。哈希对 schema 规范化后的请求求值，不能混入随时间变化的当前默认模型等状态。S05 必须用屏障让两个完全相同请求同时错过快路径，验证此竞态。

- 资源创建 / PATCH 在同一个事务写资源、完成的 command 及相应 session 事件，返回 201 / 200。
- 空闲 prompt / 后续独立执行 / compact 在同一事务写 queued command、queued Run、事件及 live_state，返回 202。活动 Run 的 steer / followUp 型输入固定 commands.target_run_id，不创建第二个生成 Run；分派前重新核实原目标，终止后不误投新 Run。
- steer / abort / respond / 配置命令不创建新 Run，写 command 及事件，提交后通过控制通道分派。
- extension_command 先建立 Command / Operation，按实际生命周期关联零到多个 Run；自主扩展执行允许没有 Command。用户 bash 建独立 Operation，不创建模型 Run。资源配置遵循 pi 默认发现与显式覆盖，persist=true 的默认写入以 SettingsManager.flush 为持久边界。
- cancel_queued / resume_queue 在接收短事务内完成应用队列变更和 completed command，返回 200；不排入 worker 控制队列。
- 保存 schema 校验后的标准化 payload，并对稳定的规范 JSON 求 SHA256；对象字段顺序不同不视为内容不同。
- 重试保留初次接收的 response_status / response_json，后续不可覆盖。最终结果（包括 result.actualConfig）在 command.updated 的同一事务写入独立 result_json，GET command 读取当前 state / error_code / result_json；旧收据不伪装成新一轮接收。

首次 pairing 不使用此幂等表。token 在 SQLite 事务内只消费一次，响应丢失后在管理 CLI 重新生成配对 token，不重复返回设备秘密。

## 4. 事件与投影事务

单主进程串行写库，开启 WAL、foreign_keys、busy_timeout=5000、synchronous=FULL。文件必须在本机磁盘；WAL 不用于跨主机共享数据库。

一次 worker 批次的事务：

1. 核对 sessionId / workerEpoch，查 ipc_batches。已提交的同批次返回原 seq 范围；同号异内容报错。
2. 读取 last_event_seq，给本批规范事件分配连续 seq。
3. 插入 events，同时更新 runs / commands / interactions，使用同一 reducer 更新 live_state（包括 activeOperations、输入和 metadataSync）；封存项写入 timeline_items。Run 异常封存及对应交互关闭 / 终态 / 队列变化同事务；无 Run 内容用 operation.content_sealed 与操作终态原子封存。操作结束只关闭直属 pending 表单，不误关独立子操作或另一 Run。
4. 更新 Session / Project 活动摘要和 last_event_seq，插入 ipc_batches，提交。
5. 提交后 ACK worker，并唤醒 WSS 订阅者读取已提交记录。

事务中不等待模型、工具、网络、手机响应或磁盘大文件流。主服务自身产生的资源 / 状态事件使用同一写入入口，确保同一 Session 只有一个序号分配源。

序号可以在批内先计算，但事务回滚后不能提前广播。SQLite 写入失败时不要向手机报告成功；停止该会话继续执行，保留明确故障状态，避免无限生成未保存输出。

## 5. 快照、历史及无缝回放

`GET snapshot` 在一个 SQLite 读事务里读取 Session、当前 Run / activeOperations / 两类队列 / recoveredInputs / pending interactions、live_state 和最后 50 个封存 timeline_items，捕获 `S=last_event_seq`。返回状态代表 exactly-through-S，手机从 S+1 接续；无 Run 内容及初始化表单也可读取。

快照包含所有仍打开的内容项，封存历史项不可变。历史分页 cursor 包含 `sessionId, atSeq=S, beforeOrdinalSeq, beforeItemId` 并防篡改；查询使用 `finalized_seq <= S` 和 `(ordinal_seq,item_id)` 的确定排序。消息或工具在 S 之后正常完成或被 run.content_sealed 封存时，通过后续事件从 live 状态转入历史；不会混入旧快照的历史页。异常封存保留已经接收的内容，不能捏造完整参数、工具结果或退出码。

live_state 仅保存未完成内容及必要状态，已完成大历史由 timeline_items 分页加载。不为每个 token 复制完整历史。单个未完成工具快照保留有界尾部，完整保留内容转 artifacts。

客户端同时原子保存 reducer 状态和最后连续应用的 seq；恢复时不能只保留 cursor 而丢掉其对应状态。数据坏了或协议不兼容时重新获取 snapshot。

## 6. 运行与交互恢复

分派前先把 command 标为 dispatching，记录 epoch 和 Run 的 execution_scope_key，再发送 IPC。worker 接受后变 accepted。acceptance ACK 丢失不自动重发 prompt；不能仅凭 worker PGID 退出假称工具已结束，也不因此封锁未来所有新请求。实际故障处理见[部署约定](deployment.md)。

同 Session 仍由一个 AgentSession worker 管理其 JSONL；epoch 只隔离 IPC，不阻止旧 SDK 实例写文件。主进程恢复时若确认旧 worker 仍在退出流程，新请求等待该实例完成正常交接后加载原会话；不能同时打开两个 SDK 实例写同一会话文件。这里核对的是该 worker，不要求所有 Bash 后代退出或提供容器清理证明；不同 Session 可继续并行。

启动恢复在允许新运行前完成：

- 识别旧 epoch / 作用域并记录诊断，不要求宿主清理凭据作为启动条件。
- dispatching / accepted 的不明命令 → unknown；其原始执行 Run 或 target_run_id 指向的非终态 Run → interrupted。关联已终态 Run 不改写历史结果。
- 旧 activeOperations → interrupted；先封存其无 Run partial，未确认交付的输入 / custom 保留 unknown。失去内存回调的 pending interaction → cancelled，保存原因 restart，不把旧回答送给新初始化。
- 异常 Run 封存打开内容并写终态；仅有旧后续项时暂停这些项，空队列 ready。
- 按下表分类尚未分派命令，写状态事件；按持久状态校验 JSONL 并恢复，不补造未保存事件。
- 不自动重放未知命令，允许用户主动新操作。历史文件实际损坏只影响依赖该上下文的操作；读取历史、组织列表和其他 Session 仍可用。若需清理已定位进程，校验 PID 启动标识，不误杀复用 PID。

| queued 命令种类 | 重启行为 |
| --- | --- |
| 首先检查 target_run_id 非空的旧控制，包括 kind=prompt；其次旧 steer / abort / abort_bash / respond | cancelled，reason=stale_runtime；旧目标 prompt 不创建新的 queued Run 或后续队列成员。abort_bash 是 Session 级旧运行控制，不要求 target_run_id |
| 无旧目标的独立 prompt / follow_up / compact，且 dispatched_at 为空 | 保留；被中断执行影响的旧后续项暂停等待处理，未受影响的 ready 队列按 SDK 状态运行。新 prompt 不被旧暂停队列拒绝 |
| set_model / set_thinking | cancelled，reason=restart_before_dispatch；重新读取有效配置后由用户发新请求，不重放旧 version |
| bash / extension_command | 已分派且结果不明仍 unknown；未分派的旧上下文命令 cancelled 并提示可重新提交，不静默套入新 worker |
| cancel_queued / resume_queue、资源创建与元数据 PATCH | 应已在接收事务内 completed；若持久数据出现 queued 属于不变量损坏，报告恢复错误，不猜测重放 |

正常 completed Run 继续 ready 队列；paused 旧项不因新的主动任务完成而恢复。用户可取消旧项或以 queueVersion / 暂停 runId 明确恢复；最后一项取消后原子 ready。归档不停止执行、不改变队列；SDK / 历史错误按具体操作呈现，不增加全局空闲门槛。

回答交互时，事务 CAS `status=pending`、未过期且匹配 operationId / epoch，保存响应 commandId。第二个不同请求再回答返回 INTERACTION_CLOSED。保存后投递回调存在不明窗口；worker 退出后标记中断，不把旧回答应用到新 worker。操作等待不持有 respond 所需的 mutex。

initialize / configure / run / bash / extension 的标准表单都可持久化、等待和重连回答。先保存 operation.updated，再保存表单；无 Run 时 run_id=null。异步 hook 有自己的子 Operation；父配置返回不等于 hook 结束。仅在用户取消、原生到期或所属操作 / worker 确实结束时返回取消值，不因初始化阶段主动禁用 UI。

## 7. 大输出与备份

artifact 文件名由服务生成，路径只在 `/state/outputs` 下；先写临时文件并完成大小 / hash 校验，再原子改名，提交元数据和引用事件。下载只接受 artifactId，经 Session 归属校验后解析受控相对路径，不接受服务器任意路径。

默认单 artifact 上限 20 MiB、单 Session 保留展示输出总量 100 MiB，可配置；达到限制产生 output_truncated notice。这是手机展示副本的配额，不限制 SDK Bash 执行、原生结果或原生 fullOutputPath 文件，不因为展示配额用尽删除 SDK 文件或停止命令。SDK 保留的文件仍可由后续 Bash 读取；手机无法完整下载时明确说明。SDK 自身未保留全量时，同样不伪造完整输出。

V1 不自动裁剪 events。后续有保留策略时必须增加 cursor 过期与基线快照，不允许静默跳过旧事件。

一致备份的默认流程是暂停新命令、等待 Run 结束或明确停止、停写、检查 WAL、备份 SQLite 与 pi / outputs；恢复到新状态卷验证。运行中单独复制 app.sqlite 可能遗漏 WAL，不能作为备份方式。具体命令在 S12 实现。

## 8. 将来迁移 PostgreSQL 的条件

多个 API 实例跨机器共享状态、独立写入竞争明显或需要数据库高可用时再评估 PG。迁移包含 schema / 数据转换、所有权与任务租约，不只是更换连接字符串。V1 保留数据访问模块和迁移版本，先实现一套 SQLite 后端。


## 2026-09-15 实现校准

事件写入只加载活动投影，不扫描已封存 timeline 正文；批内 reducer 共用一次可变投影副本，SQL 仅更新受影响的 Command、Run、Interaction。Snapshot 从 SQLite 读取最后 50 条历史并包含持久 notices。现阶段 live_state_json 仍保留部分终态实体投影，不把短基准描述成无限历史的容量保证。

unflushed 且原路径不存在时，使用原 pi ID 重新分配文件路径，允许同 ID 的未落盘映射更新；persisted 的缺失/空/错误身份文件一律在 SDK open 前报错，保留原文件。落盘状态以实际 JSONL 为准。原生替换的 intent/bound 信息作为来源 Session 的持久 runtime.notice 保存，目标 Session 独立认领映射，旧历史不重绑；多 Session 恢复使用不同批次命名空间。

原生标题/config 的无版本事件在事务内比较有效值并分配版本；手机标题同步意图带唯一标识，匹配 ACK 才清除。移动端 SQLite 保存 prepared/unknown 的原请求、幂等键和 Session，确认收据之后才能删除。spool 和 artifacts 与 SDK 历史职责不同：它们保存展示/IPC 内容，不提供 shell 副作用的恰好一次执行保证。
