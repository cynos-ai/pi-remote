# V1 HTTP、事件与 IPC 契约

状态：待实现规范，S03 落为公共 schema、类型及 reducer。遵循[整体 TUI 体验原则](tui-experience.md)，手机不直接消费 pi 内部类型。示例包括[正常流](examples/stream.json)、[中断流](examples/interrupted.json)和[无 Run 的初始化表单](examples/initialization-dialog.json)。当前无发布客户端，可直接修订 V1 草案；发布后同类语义变更需升级协议。

## 1. 通用约定

- 前缀 `/v1`；JSON UTF-8；字段 camelCase。Project / Session / Run / Command / Operation / Interaction / Artifact ID 使用服务端 UUID；messageId、blockId、toolCallId 为最长 128 字符的不透明引用，可来自 SDK 或适配器映射。
- 时间为 UTC RFC3339；seq 为 JSON 安全整数，Session 内从 1 连续增长。
- 鉴权使用 `Authorization: Bearer <deviceToken>`。token 不出现在 URL、日志或事件中。
- 所有持久业务变更携带 `Idempotency-Key: <UUID>`。`/pair` 和短期 `/ws-tickets` 有各自的一次性规则，不使用业务命令幂等。
- 普通列表默认 50、最多 200 条；使用稳定 cursor，不用 offset 追读活动列表。名称 1–120 字符、用户文本 1–32768 UTF-8 字节、输入请求体最大 64 KiB。
- path、URL、token、secret 等字段不得自动回显到错误详情。资源不属于当前用户时统一 404。
- 对精确定义的请求拒绝未知字段，响应允许增加非破坏字段；新增影响 reducer 正确性的事件语义必须升级协议，不得仅靠客户端忽略未知事件。

错误：

```json
{"error":{"code":"VERSION_CONFLICT","message":"会话配置已更新，请刷新后重试","requestId":"request-id","details":{"currentVersion":3}}}
```

| HTTP | code 示例 | 行为 |
| --- | --- | --- |
| 400 | INVALID_REQUEST、INVALID_CURSOR | 修正请求，不自动重复发送 |
| 401 | UNAUTHENTICATED、DEVICE_REVOKED | 重新配对或使用有效设备 |
| 404 | NOT_FOUND | 不泄漏归属信息 |
| 409 | IDEMPOTENCY_CONFLICT、VERSION_CONFLICT、SESSION_BUSY、STALE_RUN、INTERACTION_CLOSED | 仅对应具体操作 / SDK 真实冲突，不以归档、旧队列或活动 Run 统一拒绝全部操作 |
| 413 | PAYLOAD_TOO_LARGE | 缩小输入 |
| 422 | MODEL_UNAVAILABLE、NOTHING_TO_COMPACT、INVALID_PROJECT_PATH | 展示 SDK / 环境的实际原因；合法 thinking level 的原生 clamp 返回实际值 |
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
| GET `/v1/capabilities` | 鉴权，`sessionId?` | `{protocolVersion:1,commands,limits,features,nativeCapabilities}`；按实际加载资源返回扩展命令及 available / needs_adapter / disabled_by_owner / upstream_unavailable 状态 |
| GET `/v1/models` | 鉴权 | `{items:[{model:ModelRef,name,thinkingLevels,contextWindow}]}`；仅已配置模型，无凭据 |
| GET `/v1/projects` | `cursor?,limit?` | `{items:ProjectSummary[],nextCursor}` |
| POST `/v1/projects` | `{name,rootPath,defaultModel?,defaultThinkingLevel?}` | 201 `{project,commandId}`；同一真实目录已注册则 200 返回已有项目，不覆盖其配置；rootPath 位于容器内允许根 |
| PATCH `/v1/projects/:id` | `{expectedVersion,name?,defaultModel?,defaultThinkingLevel?}` | 200 `{project,commandId}`；V1 不改变 rootPath |
| GET `/v1/projects/:id/sessions` | `archived=exclude\|only\|all,cursor?,limit?` | `{items:SessionSummary[],nextCursor}` |
| POST `/v1/projects/:id/sessions` | `{title?,model?,thinkingLevel?}` | 201 `{session,commandId}`；空标题由服务生成，不复制历史 |
| PATCH `/v1/sessions/:id` | `{expectedVersion,title?,archived?}` | 200 `{session,commandId}`；归档仅更新元数据，不停止任务或关闭交互 |
| GET `/v1/sessions/:id/snapshot` | 鉴权 | Snapshot，见下文 |
| GET `/v1/sessions/:id/history` | `cursor,limit?` | `{items:TimelineItem[],nextCursor,atSeq}`，固定读边界 |
| GET `/v1/sessions/:id/events` | `afterSeq,limit?` | `{events,throughSeq,hasMore}`；最多 500 条，按 seq 正序 |
| POST `/v1/sessions/:id/commands` | CommandRequest | 异步命令 202；cancel_queued / resume_queue 事务内完成返回 200；幂等重放使用原收据 |
| GET `/v1/commands/:id` | 鉴权 | `{commandId,kind,state,runId?,error?,result?}`，当前真实状态 |
| POST `/v1/ws-tickets` | 鉴权，无正文 | 201 `{ticket,expiresAt}`；60 秒单次、绑定设备，内存保存摘要 |
| GET `/v1/artifacts/:id` | 鉴权 | 已封存资源，支持 Range；目录由服务器确定 |

ProjectSummary：`{id,name,version,lastActivityAt,runningCount,waitingInputCount,blockedReason?}`。项目详情的 rootPath 只对已鉴权 owner 展示。

SessionSummary：`{id,projectId,title,version,model,thinkingLevel,status,phase,activeRunId?,queuedCount,queueState,queueVersion,queuePause,piPersistenceState,historyErrorCode?,lastActivityAt,lastMessagePreview,archivedAt}`。status 取 idle / queued / running / waiting_input / busy / interrupted / failed；它描述当前或最近状态，不是全局命令许可开关。queueState 只控制旧后续项的自动调度；paused 仍可发送新 prompt 和改配置。queuePause 为 null 或 `{runId,reason:"failed"|"aborted"|"interrupted"}`。piPersistenceState 为 uninitialized / unflushed / persisted，不暴露文件路径。

Snapshot：

```json
{
  "session":{"id":"session-id","projectId":"project-id","title":"修复登录","version":1,"status":"idle","model":null,"thinkingLevel":null,"archivedAt":null,"queueState":"ready","queueVersion":0,"queuePause":null,"piPersistenceState":"uninitialized"},
  "snapshotSeq":0,
  "activeRun":null,
  "activeOperations":[],
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
| prompt | `{text,streamingBehavior?:"steer"\|"followUp"}` | 空闲时建立 prompt Run；活动输入默认 steer，也可明确 followUp，入库时固定 target_run_id，不创建第二个同时生成的 Run；分派时目标已变则报告 STALE_RUN，不误投新任务 |
| extension_command | `{text}` | 已加载扩展 slash 命令经 session.prompt 原生路径执行，包括 streaming 期间；建立 Operation，不能被全局 busy 拒绝，也不误发为普通模型文本 |
| follow_up | `{text}` | 追加 prompt Run，允许当前有任务；空闲时也可进入队列 |
| steer | `{targetRunId,text}` | 当前 running 的 prompt Run；非同一 runId 返回 STALE_RUN |
| abort | `{targetRunId}` | 停止当前 running / waiting_input Run，包含 compact；phase 先变 stopping |
| cancel_queued | `{targetCommandId}` | 仅 queued，原 command / Run cancelled |
| resume_queue | `{expectedQueueVersion,afterRunId}` | 恢复仍暂停的旧项；版本与暂停 Run 匹配后原子 ready，不要求先清空整个 Session 的其他操作 |
| set_model | `{expectedVersion,model:ModelRef,persist?:boolean}` | 按 SDK 行为运行中也可切换；返回实际配置，persist 默认 false，明确为 true 时保存 pi 默认值 |
| set_thinking | `{expectedVersion,level,persist?:boolean}` | 按 SDK 行为切换并返回有效等级，不因 streaming 或旧队列拒绝；默认只改当前 Session |
| compact | `{expectedVersion,instructions?}` | 遵循原生先 abort 后 compact；停止旧 Run 后启动 compact Run，保留清楚的终态和归属 |
| respond | `{interactionId,operationId,response}` | pending、同操作、同 epoch、未过期；不要求 runId，响应类型见交互 |

归档不改变操作许可。模型、等级、扩展命令及 respond 不被长 prompt 或待答表单占用的操作锁阻塞；仅短暂串行化相互冲突的配置提交。compact 是明确的停止后压缩操作，不能让两个生成 Run 同时修改同一 AgentSession，也不以 SESSION_BUSY 代替该适配。set_model / set_thinking 的 persist 写入要等待 SettingsManager.flush 并报告实际结果，不追溯改变其他已加载 Session。

输入区根据实际命令清单将扩展 slash 命令送至 extension_command，原生模板 / skills 仍走 SDK prompt 展开；内置 TUI 命令映射到对应 API。扩展可只改状态，也可发起或补充模型调用：Command / Operation 和 Run 分开记录，只有实际模型生命周期才建立或关联 Run，不能因为扩展函数返回就宣称关联任务全部完成。其他原生能力由 S02 清单和适配器补齐 DTO，不把本表当作禁止扩展的白名单。

### 队列暂停与恢复

| Run 结果 | 队列策略 |
| --- | --- |
| completed | ready 队列继续；若旧队列已有暂停，新的主动任务完成不隐式恢复它 |
| failed / aborted / interrupted | 有待执行后续项时暂停旧项，保存 pause.runId / reason 并递增 queueVersion；空队列保持 ready |
| cancelled（尚未分派） | 移除该项；最后一项取消后清空 pause 并变 ready |

暂停不拒绝新的 prompt、配置或交互。新 prompt 明确发起新的工作，不自动恢复旧后续项；follow_up 仍可追加到当前队列并显示其暂停状态。手机提供“恢复旧队列”和逐项“取消”。resume_queue 的版本不符返回 VERSION_CONFLICT，afterRunId 不符或已无暂停返回 STALE_RUN；它只改队列，不越过实际 SDK 状态和历史损坏。队列变更都更新 queueVersion，归档不影响此状态。

queue.updated.items 明确列出后续队列成员，不等同于数据库中所有 state=queued 的命令。新的主动 prompt / compact 可直接调度，不能仅因暂处 queued 就被并入暂停旧项；配置 / respond 也不进入该队列。成员和暂停状态随同一事件事务投影，恢复时使用已保存成员，不能靠 Session 的 paused 布尔值阻挡所有命令。SDK 内的 steer / followUp 输入已经关联当前 Run，不再重复建立一条应用后续 Run；其未完成结果随该 Run 中断处理。

重启时只有从未分派的 prompt / follow_up / compact 可保留，并服从暂停规则；queued steer / abort / respond 一律取消为 stale_runtime，不能迁移到新 Run。尚未分派的配置命令取消为 restart_before_dispatch。dispatching / accepted 不明结果标记 unknown，不自动重发。

abort 是异步停止请求，202 不表示 SDK 已停止。SDK 原生 abort 返回后记录 aborted，不额外扩大到历史后台服务。停止失败则 interrupted / unknown 并暂停已有旧项，发 runtime.notice 说明实际状态；不自动重放未知命令，也不据此永久拒绝用户的新操作。实际残留处理按部署文档执行。

模型 hook 失败可能发生在 SDK 已变更配置之后；command.updated(state="failed") 必须在可读取时带 result.actualConfig，同时发 session.updated 校准实际值，不能声称自动回滚。若 worker 已退出，使用持久化恢复规则并展示未知结果。

最终 result 单独持久化并由 GET command 返回，不覆盖初始 HTTP response_json。

队列 / 并发 / 回收上限由运营者按资源配置，未配置时不添加产品级上限；只有达到已配置限额才返回 QUEUE_FULL。传输和显示预算不减少模型工具能力。已有幂等收据始终可读取；同一待答请求只交付一次。

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

message / content / tool 事件及 run.content_sealed 必须带非空 runId。interaction / operation 事件允许 runId=null，以 operationId 和 workerEpoch 关联初始化、配置或扩展回调。内容引用在 Session 内不可复用；不能把其他 Run 或其他操作的事件混入当前状态。

内容块：

```text
TextBlock     {id, index, kind:"text", text}
ThinkingBlock {id, index, kind:"thinking", text, redacted?:boolean}
ToolCallBlock {id, index, kind:"tool_call", toolCallId, toolName, arguments:object}
```

| type | payload 的必需字段 / reducer 行为 |
| --- | --- |
| command.updated | `{commandId,kind,state,runId?,error?,result?}`，更新对应收据 |
| operation.updated | `{operationId,kind,status,commandId?,runId?,error?}`；kind 为 initialize / configure / run / extension，status 为 running / waiting_input / completed / failed / interrupted / cancelled，更新活动操作投影 |
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
| interaction.requested | `{interactionId,operationId,origin,kind,title,options?,message?,placeholder?,prefill?,expiresAt?}`，保存待答表单；origin 同操作 kind |
| interaction.resolved | `{interactionId,status,response?,reason?}`，结束表单；status 为 resolved / cancelled / expired |
| queue.updated | `{state,version,pause,items:[{commandId,runId,kind,position}]}`，替换队列及暂停状态；pause 形状同 queuePause |
| session.updated | `{changes}`，更新标题、version、有效配置或归档等已验证字段 |
| runtime.notice | `{kind,message,details?}`，展示 compaction / retry / output_truncated / extension_notify / interrupted 等附加过程 |

tool.args 和 completed blocks 的 arguments 都是通过 schema 验证的 JSON 对象。大型或非文本工具内容转换为类型明确的 artifact 引用，UI 不执行其 HTML 或脚本。图片等媒体通过附件与资源引用适配，不塞进文本 delta；S02 按原生类型核实上传、引用及显示契约，S07 / S10 接入。当前 DTO 缺少某种内容时必须补齐并验证，不能写成 V1 永久禁用或静默丢弃。

Bash 工具保持 SDK 的 command / 可选 timeout 语义和模型结果；本文的请求体、frame、显示尾部及 artifact 上限只约束客户端 API 与展示副本。未传 timeout 时不新增超时；手机断连、慢消费者和显示配额不终止 Bash、不改变模型可读取的原生结果文件。非零退出产生真实工具错误供 pi 继续处理，不能直接推断 Run.failed。

tool.finished 表示该次 SDK 工具调用已返回，可能包含已成功启动后台服务的结果；不能解释为所有后代 PID 已退出。正常 Run 完成后释放前台调度槽，后台服务不占 liveItems 或活动 Run。其日志按命令自己的重定向位置读取，后续通过 Bash 操作；不凭猜测 PID 在时间线伪造后台服务监控状态。完整语义见 [Bash 兼容要求](bash-compatibility.md)。

### TimelineItem 与异常封存

共同字段为 `{itemId,runId,kind,ordinalSeq,finalizedSeq,completeness,endReason?,data}`。kind 为 message / tool；completeness 为 complete / partial。ordinalSeq 来自 started，finalizedSeq 来自完成或封存事件；完整项无 endReason，partial 必须有 failed / aborted / interrupted 原因。

- message.completed 生成 complete 消息，data 为完整 payload；tool.finished 生成 complete 工具，data 合并 started 元数据与最终 payload，另带 outcome=succeeded / failed（按 isError 映射）。完整仅表示收到了最终结果，不能据此推断整个 Run 成功。
- run.content_sealed 对该 Run 的打开项做确定性封存：保留现有文本、thinking、工具参数片段和最近累计输出。partial 消息没有虚构的 stopReason / usage；尚未结束的 tool_call 块使用 `{id,index,kind:"tool_call",toolCallId,toolName,argumentsText,argumentsIncomplete:true}`，不把未完成 JSON 强行解析为 arguments。
- partial 工具保留名称、参数和 output，outcome 必须是 unknown，不填 isError 或 exitCode。卡片显示“执行结果未知”，不能把没收到结果当成工具成功或普通失败。已有 tool.finished 的工具项保持原结果。
- 服务端先输出 run.content_sealed，再输出异常 run.updated、该 Run 的 interaction / operation 终态和 queue.updated；这些在同一事务提交。completed Run 必须没有打开项；若出现残留则属于适配器错误，应失败并封存，不能报成功。终态后的内容事件拒绝，重复 seq 仍按通用去重处理。

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

初始化、配置、执行及扩展回调都桥接标准表单，不因没有 Run 自动取消。每次 SDK 操作分配 operationId；操作开始事件先持久化，随后建立表单并进入 waiting_input。后台扩展若无当前操作，在首次 UI 请求时建立 extension Operation。activeOperations 投影保存在 sessions.live_state_json，Snapshot 一并返回，不另建长期操作队列。

interaction 记录 operationId、origin、可空 runId / commandId 与 workerEpoch；respond 只需 interactionId + operationId。命令处理通道在 initialize 尚未 ready、setModel 正等待 hook 时也必须可用，不能因 SDK 调用未返回而不读取 respond。手机重连从 snapshot 重现表单，不自动发送默认答案。关闭该操作、worker 退出、原生超时或用户取消才结束请求；Run 结束只关闭属于该 Run 的交互，不误关并行的配置表单。

操作终态前在同一事务关闭其所有 pending 表单，从 activeOperations 移除，保留事件与 interactions 历史；旧 epoch 的回答不交给新 worker。用户取消、原生到期或操作确实结束时按实际原因映射 SDK 取消值；hook 抛错仍校准实际配置。run Operation 的终态随关联 Run：completed / failed / interrupted 同名，aborted 映射 cancelled。S02 / S07 必须覆盖 session_start 和 model_select 中真正等待并成功回答的场景。

## 7. 内部 IPC

worker 不是一个额外网络服务。IPC 消息包含 `{ipcVersion:1,sessionId,workerEpoch,type,payload}`，SDK 操作补充 operationId 及可空 commandId / runId，事件批次补充 batchNo。

主 → worker：initialize、session_mapping_ack、execute、steer、abort、respond、set_model、set_thinking、rename、shutdown、batch_ack。worker → 主：session_mapping、session_persisted、ready、command_accepted / rejected、event_batch、heartbeat、fatal、stopped。新 manager 的映射先获持久化 ACK 才可执行；ready 不等于 JSONL 已经存在。session_persisted 只在文件校验通过后更新标记，可按 epoch / 映射重复确认。

initialize / execute / 配置 hook 均不阻塞控制消息读取。event_batch 使用严格递增 batchNo，保留有界未 ACK 缓冲，ACK 后释放；重发只发送同样字节语义的批次。实际存储失败要如实报告并处理，不能让手机慢连接影响 SDK 执行。

heartbeat 每 5 秒；主失联 15 秒进入当前调用的停止流程。主端记录 epoch / PID 启动标识 / executionScopeKey。默认停止宽限 15 秒，只能对已验证属于当前未完成调用的进程组升级停止；这些时限不用于正常 Bash 执行或无输出检测。SDK 默认 Bash 在 Linux 使用 detached 进程组，worker PGID 被清空不代表未知调用已停止；故障时依[部署约定](deployment.md)恢复。空闲 worker 退出、已返回工具留下的后台进程不触发 blocked，不做额外进程树清扫。
