# 数据模型与事务约定

状态：待实现规范。可执行的设计附件为 [schema-v1.sql](schema-v1.sql)，S04 将其纳入迁移，不能仅在启动时无条件执行整份 SQL。首次迁移、重复启动、备份恢复和升级都需要测试。

## 1. 存储所有权

| 内容 | 权威来源 |
| --- | --- |
| 用户、设备、项目、标题、归档、命令状态 | SQLite |
| 已提交的手机事件、待答交互、历史显示 | SQLite |
| 模型对话上下文、树节点、压缩摘要、SDK 已接受的模型 / 等级 | pi JSONL |
| 源代码与工具创建的项目文件 | `/workspaces` 挂载 |
| 已保留的大输出 | `/state/outputs` 文件 + artifacts 元数据 |

title 从应用同步到 pi 的显示名，携带 Session version，旧版本回调不能覆盖新标题。模型与等级首次加载前保存在 Session 初始配置；SDK 接受后以实际值更新数据库。重启时读 pi 文件校准，但不覆盖应用标题 / 归档。

pi_session_file 必须来自 SDK 创建结果并位于配置的会话存储目录；恢复按应用 sessionId 找指定文件，不使用 continueRecent，也不接收手机传入的 JSONL 路径。

## 2. 表与字段

业务核心是 projects / sessions，其余表支撑可靠执行与连接。它们共享一个 SQLite 文件，不新增数据库服务。

| 表 | 用途与关键约束 |
| --- | --- |
| users | V1 初始化唯一 owner，保留数据归属 |
| devices | 一个设备一个高熵凭据，数据库只存摘要，可吊销 |
| pairing_tokens | 短期单次配对 token，原值不持久化 |
| projects | Linux root_path 唯一，root_identity 为 device:inode；workspace_key 决定串行范围 |
| sessions | 项目 FK、标题 version、pi 映射、last_event_seq、当前未完成内容投影 |
| commands | 所有持久化变更请求的收据；非空 scope 防止创建资源时空 sessionId 导致幂等失效 |
| runs | 每次 prompt / compact；一个 Session 最多一个 active Run，queued 可有多个 |
| events | PK(session_id,seq)，属于 Run 的事件通过复合 FK 保证同 Session |
| ipc_batches | workerEpoch + batchNo 去重，提交后返回相同 ACK |
| timeline_items | 完成的消息 / 工具结果不可变；按开始顺序分页，保留完成时的 seq |
| interactions | pending 请求、到期时间、workerEpoch、一次性回答 CAS |
| artifacts | 服务端生成的相对路径、大小、摘要，下载时检查会话归属 |

ID 使用服务端 UUID，客户端幂等键使用 UUID；引用对客户端是不透明字符串。数据库时间使用 UTC epoch 毫秒，网络时间使用 RFC3339 UTC。JSON 在数据库为经过 schema 验证的文本。不要依赖隐式 rowid、混合时间格式或浮点 seq。

Session 的 version 仅随配置与元数据变化递增，不随每个 token 变化。客户端改名 / 归档及配置命令带 expectedVersion；并发修改失败为 VERSION_CONFLICT。事件序号与 metadata version 含义不同。

## 3. 命令接收事务

所有持久业务变更携带 `Idempotency-Key`。scope 为规范化的 `METHOD:/v1/资源路径`，包含真实资源 ID、不包含 query 或凭据；例如 `POST:/v1/projects`、`POST:/v1/sessions/<id>/commands`。唯一键为 user_id + scope + client_command_id，不能只按消息文本去重。配对和短期 WS ticket 遵守协议规定的单次规则，不进入此命令表。

处理顺序：鉴权和 JSON schema 校验 → 查现有幂等键 → 同键同 payload 返回原 HTTP 状态及收据，同键异 payload 返回冲突 → 在 session / project mutex 中检查状态 → 开始短事务。

- 资源创建 / PATCH 在同一个事务写资源、完成的 command 及相应 session 事件，返回 201 / 200。
- prompt / follow_up / compact 在同一个事务写 queued command、queued Run、事件及 live_state，提交后返回 202。
- steer / abort / respond / 配置命令不创建新 Run，写 command 及事件，提交后通过控制通道分派。
- 保存 schema 校验后的标准化 payload，并对稳定的规范 JSON 求 SHA256；对象字段顺序不同不视为内容不同。
- 重试保留初次接收的 response_json；当前执行进度另外通过 GET command 与事件读取。旧收据不伪装成新一轮接收。

首次 pairing 不使用此幂等表。token 在 SQLite 事务内只消费一次，响应丢失后在管理 CLI 重新生成配对 token，不重复返回设备秘密。

## 4. 事件与投影事务

单主进程串行写库，开启 WAL、foreign_keys、busy_timeout=5000、synchronous=FULL。文件必须在本机磁盘；WAL 不用于跨主机共享数据库。

一次 worker 批次的事务：

1. 核对 sessionId / workerEpoch，查 ipc_batches。已提交的同批次返回原 seq 范围；同号异内容报错。
2. 读取 last_event_seq，给本批规范事件分配连续 seq。
3. 插入 events，同时更新 runs / commands / interactions，使用同一 reducer 更新 sessions.live_state_json；最终项写入 timeline_items。
4. 更新 Session / Project 活动摘要和 last_event_seq，插入 ipc_batches，提交。
5. 提交后 ACK worker，并唤醒 WSS 订阅者读取已提交记录。

事务中不等待模型、工具、网络、手机响应或磁盘大文件流。主服务自身产生的资源 / 状态事件使用同一写入入口，确保同一 Session 只有一个序号分配源。

序号可以在批内先计算，但事务回滚后不能提前广播。SQLite 写入失败时不要向手机报告成功；停止该会话继续执行，保留明确故障状态，避免无限生成未保存输出。

## 5. 快照、历史及无缝回放

`GET snapshot` 在一个 SQLite 读事务里读取 Session、当前 Run / 队列 / pending interactions、live_state 和最后 50 个已完成 timeline_items，捕获 `S=last_event_seq`。返回状态代表 exactly-through-S，手机从 S+1 接续。

快照包含所有未完成内容项，完成历史项不可变。历史分页 cursor 包含 `sessionId, atSeq=S, beforeOrdinalSeq, beforeItemId` 并防篡改；查询使用 `finalized_seq <= S` 和 `(ordinal_seq,item_id)` 的确定排序。部分消息在 S 之后才完成时，通过后续事件从 live 状态转入完成项；不会混入旧快照的历史页。

live_state 仅保存未完成内容及必要状态，已完成大历史由 timeline_items 分页加载。不为每个 token 复制完整历史。单个未完成工具快照保留有界尾部，完整保留内容转 artifacts。

客户端同时原子保存 reducer 状态和最后连续应用的 seq；恢复时不能只保留 cursor 而丢掉其对应状态。数据坏了或协议不兼容时重新获取 snapshot。

## 6. 运行与交互恢复

分派前先把 command 标为 dispatching 并记录 epoch，再发送 IPC。worker 的接受事件将其变为 accepted。acceptance ACK 丢失不能自动重发 prompt；它属于未知副作用窗口。

启动恢复在允许新运行前完成：

- 保留确定仍为 queued 且从未分派的命令。
- dispatching / accepted 的不明命令 → unknown；关联非终态 Run → interrupted。
- pending interaction 的内存回调已丢失 → cancelled，保存原因 restart。
- 写入上述状态事件；读取对应 JSONL 校准上下文索引与已知配置，不补造未保存事件。
- 确认旧受管理进程已终止才解除工作区阻塞；PID 校验包含启动标识，不能误杀复用 PID 的其他进程。

回答交互时，事务 CAS `status=pending`、未过期且匹配 epoch / runId，保存响应 commandId。第二个不同请求再回答返回 INTERACTION_CLOSED。保存后向 worker 投递回调也存在不明窗口；worker 退出后标记中断，不能把回答应用到新 worker。

## 7. 大输出与备份

artifact 文件名由服务生成，路径只在 `/state/outputs` 下；先写临时文件并完成大小 / hash 校验，再原子改名，提交元数据和引用事件。下载只接受 artifactId，经 Session 归属校验后解析受控相对路径，不接受服务器任意路径。

默认单 artifact 上限 20 MiB、单 Session 保留输出总量 100 MiB，可配置；达到限制产生 output_truncated notice。SDK 自身已截断且未留全量时，明确标记无法提供完整输出。

V1 不自动裁剪 events。后续有保留策略时必须增加 cursor 过期与基线快照，不允许静默跳过旧事件。

一致备份的默认流程是暂停新命令、等待 Run 结束或明确停止、停写、检查 WAL、备份 SQLite 与 pi / outputs；恢复到新状态卷验证。运行中单独复制 app.sqlite 可能遗漏 WAL，不能作为备份方式。具体命令在 S12 实现。

## 8. 将来迁移 PostgreSQL 的条件

多个 API 实例跨机器共享状态、独立写入竞争明显或需要数据库高可用时再评估 PG。迁移包含 schema / 数据转换、所有权与任务租约，不只是更换连接字符串。V1 保留数据访问模块和迁移版本，先实现一套 SQLite 后端。
