# V1 HTTP、事件与 IPC 契约

状态：待实现规范，S03 落为 packages/protocol 的 Zod schema、TypeScript 类型及纯 reducer。手机不得直接消费 pi 内部类型。合成事件见[正常流](examples/stream.json)与[中断流](examples/interrupted.json)，状态与存储见 [data-model.md](data-model.md)。当前尚无发布客户端，本轮直接修订 V1 草案；实现发布后同类变更必须升级版本。

## 1. 通用约定

- 前缀 `/v1`；JSON UTF-8；字段 camelCase。Project / Session / Run / Command / Interaction / Artifact ID 使用服务端 UUID；messageId、blockId、toolCallId 为最长 128 字符的不透明引用，可来自 SDK 或适配器映射。
- 时间为 UTC RFC3339；seq 为 JSON 安全整数，Session 内从 1 连续增长。
- 鉴权使用 `Authorization: Bearer <deviceToken>`。token 不出现在 URL、日志或事件中。
- 所有持久业务变更携带 `Idempotency-Key: <UUID>`。`/pair` 和短期 `/ws-tickets` 有各自的一次性规则，不使用业务命令幂等。
- 普通列表默认 50、最多 200 条；使用稳定 cursor，不用 offset 追读活动列表。名称 1–120 字符、用户文本 1–32768 UTF-8 字节、输入请求体最大 64 KiB。
- path、URL、token、secret 等字段不得自动回显到错误详情。资源不属于当前用户时统一 404。
- 对精确定义的请求拒绝未知字段，响应允许增加非破坏字段；新增影响 reducer 正确性的事件语义必须升级协议，不得仅靠客户端忽略未知事件。

错误：

```json
{"error":{"code":"SESSION_BUSY","message":"当前会话正在执行任务","requestId":"request-id","details":{"runId":"run-id"}}}
```

| HTTP | code 示例 | 行为 |
| --- | --- | --- |
| 400 | INVALID_REQUEST、INVALID_CURSOR | 修正请求，不自动重复发送 |
| 401 | UNAUTHENTICATED、DEVICE_REVOKED | 重新配对或使用有效设备 |
| 404 | NOT_FOUND | 不泄漏归属信息 |
| 409 | IDEMPOTENCY_CONFLICT、VERSION_CONFLICT、SESSION_BUSY、SESSION_ARCHIVED、STALE_RUN、INTERACTION_CLOSED、WORKSPACE_CONFLICT、QUEUE_PAUSED | 客户端刷新状态后由用户决定 |
| 413 | PAYLOAD_TOO_LARGE | 缩小输入 |
| 422 | MODEL_UNAVAILABLE、THINKING_UNSUPPORTED、NOTHING_TO_COMPACT、INVALID_PROJECT_PATH | 展示具体可修正原因 |
| 429 | RATE_LIMITED、QUEUE_FULL | 返回 Retry-After；重试业务命令保留原幂等键 |
| 503 | STORAGE_UNAVAILABLE、INSTANCE_RECOVERING、WORKSPACE_BLOCKED、HISTORY_UNAVAILABLE | 展示不可用状态，不盲目创建新请求 ID；历史不可用时仍允许读取 SQLite 时间线 |

SDK 接受之后发生的错误通过 command / run 事件及 GET command 报告，不能在已经返回 202 后再假装给同一 HTTP 请求返回错误。

## 2. HTTP 路由与 DTO

模型引用 `ModelRef={provider:string,id:string}`；ThinkingLevel 使用后端返回的支持值，不在 App 固定假设所有模型等级相同。

| 路由 | 输入 | 输出 / 约束 |
| --- | --- | --- |
| GET `/healthz` | 无鉴权 | 200 `{status:"ok",version}`，不返回路径或配置 |
| GET `/readyz` | 无鉴权 | 已取得单实例锁、迁移及恢复结束才 200，否则 503 |
| POST `/v1/pair` | `{pairingToken,deviceName}` | 201 `{deviceId,deviceToken,user:{id,displayName}}`；原秘密只返回一次 |
| GET `/v1/me` | 鉴权 | `{user,device}`，不回显 token |
| GET `/v1/devices` | 鉴权 | 当前 owner 的设备与吊销状态 |
| DELETE `/v1/devices/:id` | 幂等键 | 200 `{id,revokedAt}`；立即关闭该设备的 WSS |
| GET `/v1/capabilities` | 鉴权 | `{protocolVersion:1,commands,limits,features}` |
| GET `/v1/models` | 鉴权 | `{items:[{model:ModelRef,name,thinkingLevels,contextWindow}]}`；仅已配置模型，无凭据 |
| GET `/v1/projects` | `cursor?,limit?` | `{items:ProjectSummary[],nextCursor}` |
| POST `/v1/projects` | `{name,rootPath,defaultModel?,defaultThinkingLevel?}` | 201 `{project,commandId}`；rootPath 是容器内允许根下的已存在目录 |
| PATCH `/v1/projects/:id` | `{expectedVersion,name?,defaultModel?,defaultThinkingLevel?}` | 200 `{project,commandId}`；V1 不改变 rootPath |
| GET `/v1/projects/:id/sessions` | `archived=exclude\|only\|all,cursor?,limit?` | `{items:SessionSummary[],nextCursor}` |
| POST `/v1/projects/:id/sessions` | `{title?,model?,thinkingLevel?}` | 201 `{session,commandId}`；空标题由服务生成，不复制历史 |
| PATCH `/v1/sessions/:id` | `{expectedVersion,title?,archived?}` | 200 `{session,commandId}`；归档前核实无活动、排队或待答交互 |
| GET `/v1/sessions/:id/snapshot` | 鉴权 | Snapshot，见下文 |
| GET `/v1/sessions/:id/history` | `cursor,limit?` | `{items:TimelineItem[],nextCursor,atSeq}`，固定读边界 |
| GET `/v1/sessions/:id/events` | `afterSeq,limit?` | `{events,throughSeq,hasMore}`；最多 500 条，按 seq 正序 |
| POST `/v1/sessions/:id/commands` | CommandRequest | 异步命令 202；cancel_queued / resume_queue 事务内完成返回 200；幂等重放使用原收据 |
| GET `/v1/commands/:id` | 鉴权 | `{commandId,kind,state,runId?,error?,result?}`，当前真实状态 |
| POST `/v1/ws-tickets` | 鉴权，无正文 | 201 `{ticket,expiresAt}`；60 秒单次、绑定设备，内存保存摘要 |
| GET `/v1/artifacts/:id` | 鉴权 | 已封存资源，支持 Range；目录由服务器确定 |

ProjectSummary：`{id,name,version,lastActivityAt,runningCount,waitingInputCount,blockedReason?}`。项目详情的 rootPath 只对已鉴权 owner 展示。

SessionSummary：`{id,projectId,title,version,model,thinkingLevel,status,phase,activeRunId?,queuedCount,queueState,queueVersion,queuePause,piPersistenceState,historyErrorCode?,lastActivityAt,lastMessagePreview,archivedAt}`。status 取 idle / queued / running / waiting_input / busy / interrupted / failed；它描述活动或最近执行结果。queueState 为 ready / paused，单独决定能否调度，不能从 status 猜测。queuePause 为 null 或 `{runId,reason:"failed"|"aborted"|"interrupted"}`。piPersistenceState 为 uninitialized / unflushed / persisted，不暴露文件路径。暂停时先恢复队列才可发送新 prompt。

Snapshot：

```json
{
  "session":{"id":"session-id","projectId":"project-id","title":"修复登录","version":1,"status":"idle","model":null,"thinkingLevel":null,"archivedAt":null,"queueState":"ready","queueVersion":0,"queuePause":null,"piPersistenceState":"uninitialized"},
  "snapshotSeq":0,
  "activeRun":null,
  "queue":[],
  "pendingInteractions":[],
  "items":[],
  "liveItems":[],
  "historyCursor":null,
  "availableThinkingLevels":[],
  "allowedCommands":["prompt","follow_up"]
}
```

items 为最近至多 50 个封存项，包括异常结束的 partial；liveItems 只包含仍打开的内容。大量历史通过 historyCursor 读取。实现给快照设置响应体预算，大项使用 artifact 引用。session 中未在示例列出的 Summary 字段按 DTO 返回；此例表达结构，不替代 S03 的完整 schema。

## 3. 命令

请求形状为 `{kind,payload}`。异步收据为 `{commandId,state:"queued",runId?}`；cancel_queued / resume_queue 为 `{commandId,state:"completed",result}`。同一键重试返回同一初始 HTTP 状态及收据，当前状态用 GET 查询。并发同键请求也必须返回同一收据：进入操作锁及短事务后先重查幂等键，再检查 busy / version，见数据文档。

| kind | payload | 语义 / 前置条件 |
| --- | --- | --- |
| prompt | `{text}` | Session 无活动或排队操作；建立 prompt Run，工作区忙时可排队 |
| follow_up | `{text}` | 追加 prompt Run，允许当前有任务；空闲时也可进入队列 |
| steer | `{targetRunId,text}` | 当前 running 的 prompt Run；非同一 runId 返回 STALE_RUN |
| abort | `{targetRunId}` | 停止当前 running / waiting_input Run，包含 compact；phase 先变 stopping |
| cancel_queued | `{targetCommandId}` | 仅 queued，原 command / Run cancelled |
| resume_queue | `{expectedQueueVersion,afterRunId}` | paused 且对应暂停 Run；无活动操作、历史可恢复、工作区无清理阻塞时原子恢复 ready；返回当前 queueVersion |
| set_model | `{expectedVersion,model:ModelRef}` | 当前 Session 空闲；SDK 校验鉴权并返回有效配置 |
| set_thinking | `{expectedVersion,level}` | 当前 Session 空闲；按实际模型支持值校验 |
| compact | `{expectedVersion,instructions?}` | Session 无活动或排队操作，建立 compact Run；工作区忙可排队 |
| respond | `{interactionId,runId,response}` | pending、同 epoch、未过期；response 类型见交互 |

所有命令都拒绝 archived 会话。元数据改名可在运行中执行。set_model / set_thinking / compact 的空闲检查与占用操作权是原子的；compact Run 在接受后排队时，该 Session 不再被视为空闲。

### 队列暂停与恢复

| Run 结果 | 队列策略 |
| --- | --- |
| completed | 按公平调度继续后续项 |
| failed / aborted / interrupted | 在写终态的同一事务暂停该 Session 队列，即使为空；保存 pause.runId / reason 并递增 queueVersion |
| cancelled（尚未分派） | 移除该项；既不新增暂停，也不自动清除已有暂停 |

暂停时 prompt / follow_up / compact / set_model / set_thinking 返回 QUEUE_PAUSED。手机显示异常原因、待执行内容，以及“恢复队列”和逐条“取消”入口；用户可先取消不再适用的 follow-up，再明确恢复。取消全部项也不自动恢复。resume_queue 的 version 不符返回 VERSION_CONFLICT，afterRunId 不符或未暂停返回 STALE_RUN；清理 / 历史阻塞分别返回 WORKSPACE_BLOCKED / HISTORY_UNAVAILABLE。队列每次增删、暂停或恢复都更新 queueVersion，旧手机操作不能越过较新的暂停。归档 / 取消归档不清除暂停状态。

重启时只有从未分派的 prompt / follow_up / compact 可保留，并服从暂停规则；queued steer / abort / respond 一律取消为 stale_runtime，不能迁移到新 Run。尚未分派的配置命令取消为 restart_before_dispatch。dispatching / accepted 不明结果标记 unknown，不自动重发。

abort 是异步停止请求，202 不表示工具已退出。只有 SDK 空闲且常规受管理工具清理已确认，才把 Run 标为 aborted。停止超时按 interrupted 封存并暂停队列，未能确认结果的 abort command 标为 unknown，产生 WORKSPACE_BLOCKED；工作区仍不释放，不能让新 writer 进入。

模型 hook 失败可能发生在 SDK 已变更配置之后；command.updated(state="failed") 必须在可读取时带 result.actualConfig，同时发 session.updated 校准实际值，不能声称自动回滚。若 worker 已退出，使用持久化恢复规则并展示未知结果。

最终 result 单独持久化并由 GET command 返回，不覆盖初始 HTTP response_json。

队列上限默认每 Session 20 条、实例 100 条；达到上限不写入新命令，返回 QUEUE_FULL。已有幂等收据仍可读取。重复回复同一个待答请求只交付一次。

## 4. 事件封装与内容块

```json
{
  "schemaVersion":1,
  "sessionId":"session-id",
  "seq":42,
  "runId":"run-id",
  "type":"content.delta",
  "timestamp":"2026-09-12T08:00:00.000Z",
  "payload":{"messageId":"message-id","blockId":"block-0","delta":"已找到入口。"}
}
```

runId 可为 null，例如单独改名。关联性检查由服务端完成；同一 frame 只含一个事件或一个明确的控制消息。服务端事件不可携带原始 provider 凭据或私有签名字段。

所有 message / content / tool / interaction 事件及 run.content_sealed 必须带非空 runId。适配器生成的内容引用在 Session 内不可复用，并在 started 时绑定 runId；后续更新不允许跨 Run 引用旧项。

内容块：

```text
TextBlock     {id, index, kind:"text", text}
ThinkingBlock {id, index, kind:"thinking", text, redacted?:boolean}
ToolCallBlock {id, index, kind:"tool_call", toolCallId, toolName, arguments:object}
```

| type | payload 的必需字段 / reducer 行为 |
| --- | --- |
| command.updated | `{commandId,kind,state,runId?,error?,result?}`，更新对应收据 |
| run.updated | `{kind,status,phase,error?}`，以 envelope.runId 关联，不隐式标记其他 Run 结束 |
| run.content_sealed | `{reason}`，reason 为 failed / aborted / interrupted；将该 runId 的全部仍打开内容封存为 partial 并从 liveItems 移除 |
| message.started | `{messageId,role:"user"\|"assistant"}`，建立未完成消息 |
| content.started | `{messageId,blockId,index,kind,toolCallId?,toolName?}`，按 index 创建块 |
| content.delta | `{messageId,blockId,delta}`，只对该块追加文本或暂存参数 JSON 字符串 |
| content.ended | `{messageId,block:ContentBlock}`，完整块替换暂存值；参数只能在完成时解析为权威值 |
| message.completed | `{messageId,role,blocks,stopReason?,usage?}`，完整消息校准未完成内容并写最终项 |
| tool.started | `{toolCallId,messageId,toolName,args}`，建立工具卡片 |
| tool.updated | `{toolCallId,output:{text,truncated,artifactId?}}`，累计输出快照替换，不能追加 |
| tool.finished | `{toolCallId,output,isError,exitCode?,durationMs?,patch?}`，校准最终工具项 |
| interaction.requested | `{interactionId,kind,title,options?,message?,placeholder?,prefill?,expiresAt?}`，保存待答表单 |
| interaction.resolved | `{interactionId,status,response?,reason?}`，结束表单；status 为 resolved / cancelled / expired |
| queue.updated | `{state,version,pause,items:[{commandId,runId,kind,position}]}`，替换队列及暂停状态；pause 形状同 queuePause |
| session.updated | `{changes}`，更新标题、version、有效配置或归档等已验证字段 |
| runtime.notice | `{kind,message,details?}`，展示 compaction / retry / output_truncated / extension_notify / interrupted 等附加过程 |

tool.args 和 completed blocks 的 arguments 都是通过 schema 验证的 JSON 对象。大型或非文本工具内容转换为类型明确的 artifact 引用，UI 不执行其 HTML 或脚本。V1 不传图片二进制；遇到不支持内容保留说明，不能静默宣称完全兼容 TUI。

### TimelineItem 与异常封存

共同字段为 `{itemId,runId,kind,ordinalSeq,finalizedSeq,completeness,endReason?,data}`。kind 为 message / tool；completeness 为 complete / partial。ordinalSeq 来自 started，finalizedSeq 来自完成或封存事件；完整项无 endReason，partial 必须有 failed / aborted / interrupted 原因。

- message.completed 生成 complete 消息，data 为完整 payload；tool.finished 生成 complete 工具，data 合并 started 元数据与最终 payload，另带 outcome=succeeded / failed（按 isError 映射）。完整仅表示收到了最终结果，不能据此推断整个 Run 成功。
- run.content_sealed 对该 Run 的打开项做确定性封存：保留现有文本、thinking、工具参数片段和最近累计输出。partial 消息没有虚构的 stopReason / usage；尚未结束的 tool_call 块使用 `{id,index,kind:"tool_call",toolCallId,toolName,argumentsText,argumentsIncomplete:true}`，不把未完成 JSON 强行解析为 arguments。
- partial 工具保留名称、参数和 output，outcome 必须是 unknown，不填 isError 或 exitCode。卡片显示“执行结果未知”，不能把没收到结果当成工具成功或普通失败。已有 tool.finished 的工具项保持原结果。
- 服务端先输出 run.content_sealed，再输出异常 run.updated、interaction 关闭和 queue.updated；这些在同一事务提交。completed Run 必须没有打开项；若出现残留则属于适配器错误，应失败并封存，不能报成功。终态后的内容事件拒绝，重复 seq 仍按通用去重处理。

快照及历史分页包含 partial 封存项；重放必须得到与直接 snapshot 相同的状态。异常结束后该 Run 不再有 liveItems 或 pending interaction，手机不能永远显示工具正在运行；工作区清理状态单独显示，不把时间线封存当成子进程已经停止的证据。

`runtime.notice` 可添加不影响业务状态的 kind。未知的纯提示可显示 generic notice；未知的核心事件或 schemaVersion 不兼容时停止应用并重新协商，不能一边跳过关键事件一边声称已经同步。

## 5. WSS 认证、订阅和重连

入口 `/v1/ws`，WebSocket subprotocol 为 `pi-remote.v1`。在 HTTP 中换取 ticket 后升级连接，5 秒内发送第一帧：

```json
{"type":"authenticate","ticket":"TICKET_FROM_API"}
```

服务端验证单次 ticket，回应 `{type:"authenticated",protocolVersion:1}`。未认证前不能订阅或收到事件；失败关闭 4401。ticket 不放 query string、持久化存储或日志。设备吊销同时使未用 ticket 失效并关闭已有连接。

订阅 / 取消：

```json
{"type":"subscribe","sessionId":"session-id","afterSeq":42}
```

```json
{"type":"unsubscribe","sessionId":"session-id"}
```

每个连接最多 4 个 Session 订阅；每次校验归属。afterSeq 不得大于当前 high-water，负数或错误类型拒绝。服务端回放至某一时刻的 high-water 后发 `{type:"subscription.ready",sessionId,throughSeq}`；之后继续实时事件。

无缝接续算法：建立数据库提交唤醒监听 → 读取 high-water H → 按 seq 从 afterSeq+1 分页追读 → 到 H 后再次检查最新 high-water → 继续追读或等待已注册的唤醒。唤醒只是提示，数据库是来源；实现周期性校准以覆盖丢失唤醒。不能先读完历史再注册监听。

客户端用持久 cursor C 接收事件：seq <= C 丢弃；seq == C+1 应用并原子保存状态 / cursor；seq > C+1 暂缓应用，补读缺口或重新 snapshot。重连采用带 jitter 的 1–30 秒退避，恢复前台立即尝试。

项目列表的可选 `{type:"catalog.changed"}` 只作为重新 GET 列表的提示，无离线投递保证；每次重新连接必须刷新列表。它不能代替 Session 的可靠事件。

服务端每 25 秒协议 ping，60 秒无 pong 关闭。发送缓冲超过 4 MiB 时发 `resync_required` 并关闭 4408，不阻塞 agent，也不静默丢事件。事件 frame 最大 1 MiB，适配器把超大正文转 artifact / 显式截断；输入控制 frame 最大 64 KiB。

连接中断和 cursor 恢复只保证已提交事件至少一次投递加客户端去重。新进程缺少本地缓存时，重新 GET snapshot，不能从空 reducer 直接跳到一个旧 cursor。

## 6. 交互响应

select 的 response 为 `{value:string}` 且属于 options；confirm 为 `{confirmed:boolean}`；input / editor 为 `{value:string}`。所有类型都接受 `{cancelled:true}`，不同时带其他响应字段。服务端限制输入长度并由适配器转换为 SDK 对应默认取消值。

未设置 expiresAt 时可等待用户，abort / worker 退出仍能关闭请求。超时使用服务器时间；关闭后响应返回 INTERACTION_CLOSED，先前同幂等键的答复可重放原收据。UI 表单不因为 WSS 断开自行提交默认答案。

V1 只桥接 **execute 阶段的活动 prompt / compact Run** 中的四种对话框；initialize、configure、shutdown 阶段和已停止的 Run 不允许建立 pending Interaction。bindExtensions 的 session_start、setModel 的 model_select hook 即使请求 UI，也必须立即返回取消值：confirm=false，select / input / editor=undefined，并提交 `runtime.notice(kind="extension_ui_unavailable")`，details 只含 phase / method / commandId 等安全字段。无 Run 时 envelope.runId=null。不能自动确认，也不能等待手机响应；因此 interactions.run_id 仍为必填。

可信扩展需能处理取消。hook 因取消抛错时正常报告初始化 / 配置失败及实际配置；不保证回滚已发生的模型切换。S02 / S07 必须分别覆盖无 Run 请求和正常 Run 请求。

## 7. 内部 IPC

worker 不是一个额外网络服务。IPC 消息包含 `{ipcVersion:1,sessionId,workerEpoch,type,payload}`，命令补充 commandId / runId，事件批次补充 batchNo。

主 → worker：initialize、session_mapping_ack、execute、steer、abort、respond、set_model、set_thinking、rename、shutdown、batch_ack。worker → 主：session_mapping、session_persisted、ready、command_accepted / rejected、event_batch、heartbeat、fatal、stopped。新 manager 的映射先获持久化 ACK 才可执行；ready 不等于 JSONL 已经存在。session_persisted 只在文件校验通过后更新标记，可按 epoch / 映射重复确认。

execute 不阻塞处理控制消息。event_batch 使用严格递增 batchNo，保留有界未 ACK 缓冲，ACK 后释放；重发只发送同样字节语义的批次。超过缓冲 / 持久化超时则停止该运行并报告故障，不无限积压。

heartbeat 每 5 秒；主失联 15 秒进入停止流程。主端记录 epoch / PID 启动标识 / executionScopeKey。默认停止宽限 15 秒，然后对已验证的受管理进程组强制终止。SDK 默认 Bash 在 Linux 使用 detached 进程组，worker PGID 被清空不代表 Bash 已停止；worker 被 SIGKILL 或清理无法确认时必须 blocked，依 [部署约定](deployment.md) 完整重启 app 容器并验证清理证明，不能只重启 Node。
