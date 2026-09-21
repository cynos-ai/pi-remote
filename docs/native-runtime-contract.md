# 原生运行、内容归属与同步补充契约

API key / OAuth 登录以 configure Operation 承载：`/login [provider]` 使用原生 provider API key / OAuth 方式和 ModelRuntime.login；无参数复用原生 provider 菜单。无交互 login 方法的 provider 保留外部环境鉴权提示。秘密 input 的答复只在主进程/worker 内存中传递，由 SDK 存入 auth.json；鉴权异常不传播含 credential/cause 的对象。保存后更新模型可用状态，unknown 模型按原生默认模型选择，并后台刷新 provider 目录；失败保留缓存且不伪装登录失败。OAuth 授权链接、设备码、信息/进度通知和账户选项走独立内存展示接口；所有原生 text/secret/manual_code/select 提示的回答走 sensitive input。登录控制可随时取消，结束/编辑器取消后清除展示。SDK 回调原文不改写、不自行开放公网回调或增加 relay；需要本机浏览器回调且没有手动回退的 provider 仍须同环境实测，当前不宣称真实 provider/TUI parity。

状态：V1 实现契约，已按代码审核修订桥接和恢复路径；具体验证见[修复记录](reviews/2026-09-15-code-review-fixes.md)。与[协议](protocol-v1.md)、[数据模型](data-model.md)和[参考 SQL](schema-v1.sql)共同约束实现；下面是确定的适配工作，不能以禁用扩展代替。源码核对不等于真实 SDK 验收。

## 1. Operation、Run 和外部 Command

首次项目信任可以发生在 SDK AgentSession 创建和 native mapping ACK 之前，使用既有 initialize Operation / interaction 事件持久化，runId 为 null。respond 根据活动 worker、待答 interactionId 和 operationId 校验，不要求 SDK handle 已存在；此放行不允许其他模型/配置控制提前执行。信任表单等待及回答后的异步 hook 由已有初始化进度与心跳机制维持，不因映射尚未产生而超时取消。项目资源只在原生信任 resolver 决定后加载。

Operation 标识一次初始化、配置、模型执行、用户 Bash 或扩展回调，kind 为 initialize / configure / run / bash / extension。由持久事件维护活动投影；无须增加操作调度表。异步后续操作可用 parentOperationId 标明来源，父操作完成不自动结束子操作。

custom UI 为独立 extension 子 Operation：工厂、连续按键表单及异步 done 共享该归属，单个按键表单结束不关闭整个组件。done 关闭当时仍待答的控制表单并返回原值，用户明确取消返回 undefined；扩展自己的 Esc 语义不由适配器替代。异常向上报告并清理组件，worker 退出中止回调，迟到工厂不重新打开控件。此 UI 生命周期不是模型 Run，也不同于下文 custom 消息内容。

每个 custom 使用独立 80×24 虚拟 TUI。overlay 合成、onHandle、隐藏/恢复及焦点输入由原生 TuiMainScreen 实现；输入经过原生 addInputListener 和当前焦点组件，不直接绕过路由调用根组件。overlayOptions 回调按固定 SDK 在安装时求值一次，普通 custom 忽略 overlay 配置。应用级 onTerminalInput 按下文绑定到同 Session 的交互表面；跨实例共享焦点仍未接入。

header/footer 为无焦点组件，工厂及 FooterDataProvider 留在 worker，以安装时 Session 为归属。异步刷新若原 Operation 已关闭，创建同 Session 的新 Operation；不能沿用后来目标会话的归属。替换/清除销毁旧组件，worker 退出清理 provider 的 Git watcher。footer 状态数据来自 setStatus，可用 provider 数量按原生 scopedModels 或 available snapshot 计算，不为渲染额外发起模型请求。

editor 工厂用独立 extension Operation 跨连续按键存活；安装立即返回，不阻塞扩展命令或初始化。替换、取消、会话替换和退出使旧控件失效，迟到 onSubmit / onChange 不操作新组件。后续用户提交清除安装时的命令因果关系，创建独立操作，SDK 产生的 Run 可无外部 Command。onSubmit 异常只保留草稿、不自动重试；已开始的 SDK 任务不因编辑器被替换而停止。异步失败明确携带安装时 Session 归属。相同 editor_state 文本不调用组件 setText，避免重置原生光标。

onTerminalInput 订阅按 Session 隔离，直接注册到各原生交互 TUI；消费/改写及局部监听顺序由 SDK 负责。移除控件解除其绑定但保留有效应用订阅供之后组件使用；原生会话替换清除旧应用订阅，不能将新会话监听绑定到源会话仍待答的 custom。扩展快捷键只接入原生 CustomEditor 的 onExtensionShortcut，沿用 getShortcuts 和原上下文；已有回调不覆盖，异常通知不关闭编辑器。

默认应用动作通过 CustomEditor.actionHandlers 绑定，保留自定义 onEscape/onCtrlD，不在原生匹配前截获字节。补全取消优先于中断；streaming 停止先取回 SDK 队列并发布 Input 状态，再将 steering/followUp/当前草稿按原生顺序合并到编辑器，最后 abort，不自动提交。followUp 在 streaming/compacting 时调用原生 prompt followUp，空闲时复用普通提交；失败只恢复未被后续编辑覆盖的草稿。dequeue 原子 clearQueue，将 steering 后接 followUp 置于当前草稿前；只有完整返回队列与已有持久输入槽位精确一致时才记 returned。编辑器自产队列没有外部 Command 身份；与持久输入混合时仍恢复全部文本，但持久输入标记 unknown，不用文本去重或猜 inputId。压缩/重试取消走各自 SDK API，不清普通队列。取消 Bash 不清草稿。外部编辑用持久 editor 表单回填；思考显示切换写 SDK 设置并发布手机显示通知。旧编辑器动作回调在替换后失效。空草稿 Ctrl+D、双 Ctrl+C 和 /quit 只结束当前远程编辑器及其待答子菜单，保留草稿和后台执行，不调用服务/worker shutdown 或伪造 session_shutdown。`app.suspend` 在共享服务架构中定义为持续运行并通知，不发送 SIGTSTP。`app.clipboard.pasteImage` 触发 image 表单，由当前手机选择并上传真实图片 artifact；worker 校验文件签名后转换为 SDK ImageContent，附到下一条模型输入，成功才清除，取消或提交失败保留；清空编辑器同时清除待提交图片，不读取服务器剪贴板。

模型前后循环与思考等级循环调用 SDK cycleModel/cycleThinkingLevel，遵循原生可用模型/作用域、能力约束和默认 persist=false，不另加空闲条件。每个动作有独立 configure Operation、无外部 Command 和 Run；model_select 的 awaited 表单全部结束后才完成动作，thinking_level_select 的 fire-and-forget 表单沿用异步子操作规则。已关闭的 AsyncLocalStorage 来源不回退到其他活动 Run，迟到表单保留原配置父操作及 Session 归属。模型 hook 替换会话后不把目标配置发布到源会话。无可循环模型或不支持思考等级时显示通知，键位冲突仍由原生 CustomEditor 处理。

app.model.select 复用固定 SDK ModelSelectorComponent，搜索、目录刷新、作用域、选择/取消/保存默认键均由原组件处理；主题使用现有固定文本主题，原生全局 TUI 键位使用该 worker 的 agent 配置。菜单有独立 configure Operation 与 custom.render/select/input 控制，重复打开复用同一菜单任务。选中后关闭菜单表面，再在同一配置 Operation 调用 setModel；标准扩展表单可继续待答，编辑器仍可接收其他操作。普通选择 persist=false，保存默认选择 persist=true 并等待 SettingsManager.flush。取消不切模型、不清草稿、不停止 Run。编辑器关闭/替换或 Session 替换会取消尚未选择的菜单，旧响应不得用于新 Session；已经确认的配置仍按 SDK hook 完成。菜单与编辑器是独立虚拟表面，尚不等同于原生终端共享焦点。

app.session.resume/new 和编辑器中的完整 `/resume`、`/new` 分别进入原生历史选择与新建流程；快捷键沿原生默认保持未绑定，可由用户配置。菜单使用 SessionSelectorComponent 和 SessionManager 原生 current/all 列表，保留搜索、排序、命名过滤、路径显示、重命名和删除确认。当前历史禁止删除由原组件执行。重命名前校验持久文件；当前 Session 调用 setSessionName 以同步事件，其他文件校验后 appendSessionInfo，不允许缺失/损坏历史被 open 重建。非当前历史的手机标题在后续加载时同步；删除原生 JSONL 不删除手机事件记录，后续打开缺失历史仍失败，不自动重建。

选择或新建通过已绑定的 SDK commandContextActions 执行，保留会话替换串行、持久 intent、目标校验和映射 ACK；不直接调用未包装的 runtime.switchSession。动作占独立无 Command/Run 的 extension Operation，取消只完成该操作；失败通知原编辑器并保留源 Session。编辑器关闭或会话替换后未完成菜单失效，已选中后的标准 hook 遵循原生生命周期。退出终端仍显示待适配，树导航/分叉菜单和跨虚拟表面焦点另验。

会话替换后的扩展异常也保持原 Operation 的 Session 归属。内部 extension_error IPC 携带 sessionId，主服务只接受该 worker 已拥有的 Session；旧格式缺省回到 worker 当前 Session。原生 ctx 已失效时仍保留 SDK 错误，不因为命令 completed 就判断回调成功，也不把错误写入新会话。

Run 只记录实际 prompt / compact 生命周期。每个 Run 有唯一 operationId、source（command / extension / runtime）及可空 commandId。commandId 是外部请求的因果来源：一次扩展命令可产生多个顺序 Run，后台扩展也可没有手机请求。不得伪造设备、HTTP 命令或模型 Run 来凑表约束。同 Session 最多一个活动模型 Run，独立 Bash / 扩展内容不占此槽。

外部 Command 的初始收据不变；接收时已分配的直接 prompt / compact 可返回 runId。GET command 及后续 command.updated 用 `runs:[{runId,sessionId}]` 表达全部关联，不能用单个 runId 覆盖前一次结果。扩展命令的 completed 表示其调用本身结束，关联模型 Run 的状态单独显示；不会因为父命令返回就把其后续执行报成完成。

原生会话替换可能让来源 Command 与目标 Run 不同 Session：只允许同 owner 的因果关联。Run / Interaction 的来源 commandId 由存储事务校验 owner；回答表单的 responseCommandId 和定向 targetRunId 仍必须与请求 Session 一致。跨 Session 因果关联不改变时间线、事件、文件和回答的执行归属。

## 2. 无 Run 的内容

所有事件 envelope 增加 `operationId:string|null`。message / content / tool 及内容封存事件必须有 operationId；只有确实属于模型生命周期时才有 runId。普通列表 / 队列变更等可同时为 null。operation.updated 的 payload.operationId 必须与 envelope 相同。

TimelineItem 保存 operationId 和可空 runId；同 Session 的操作存在性、操作与 Run 的对应关系由事件事务和 reducer 校验。引用不可复用，也不能用最近活动 Run 代替真实归属。SDK 的无 Run 内容与同时进行中的模型回复可并存。

触发来源与内容存活期分开：streaming 中的扩展 custom 消息可能在配置方法返回后，才由 SDK 在 turn_end 交付。适配器为这类内容建立独立 delivery Operation（kind=extension），保留 parentOperationId / 来源 Command，即使父操作已结束也可完成交付。不能向已终态的父操作追加内容，也不能通过全局 currentOperationId 猜测并行回调归属；已确认入队但尚未交付的内容在重启后保留实际未知状态。

消息 role 支持 user / assistant / custom / bash。message.started 携带已知的角色元数据，message.completed 使用规范化 blocks 并校准最终字段；额外字段按角色定义：

| role | 补充字段与含义 |
| --- | --- |
| custom | `custom:{type,display,details?}`；保留扩展消息类型、显示语义和经过 DTO 校验的数据，文本使用 TextBlock，媒体用资源引用 |
| bash | `bash:{command,excludeFromContext,outcome,exitCode?,cancelled?,truncated?,artifactId?}`；outcome 为 running / succeeded / failed / aborted / unknown，开始为 running，完整完成不可为 running / unknown；不冒充模型 tool_call |

custom 的 display=false 内容可记录为不可见的历史项，手机遵循此原生显示标志；模型上下文仍以 pi 为准。自定义渲染器未完成时，display=true 使用明确的文本 / 结构化内容回退，不能吞掉消息或执行未经适配的终端代码。普通工具卡的 messageId 在有所属模型消息时提供，独立扩展工具内容可以只关联 Operation。

用户 Bash 的 `!` / `!!` 分别映射 `bash {command,excludeFromContext:false|true}`，遵循 TUI 的 user_bash 扩展路径和 executeBash / recordBashResult；不将 shell 文本发给模型。输出使用 role=bash 的消息与内容事件，最终结果以 SDK 返回为准。`abort_bash {}` 使用原生 abortBash，作用范围是该 Session 当前的用户 Bash 调用集合；不假称 SDK 提供了单次调用的定向取消，也不扫杀已经返回的后台服务。模型 `/stop` 与用户 Bash 停止入口分别显示实际作用对象。

Run 内容异常仍用 run.content_sealed；无 Run 的打开内容用 `operation.content_sealed {reason}`，reason 为 failed / aborted / interrupted。两者只封存各自归属的打开项，并与对应终态同事务提交，不重复封存。partial Bash 的 outcome=unknown，未收到最终结果时不填 exitCode / cancelled；已完成的消息或工具不改写。无 Run 操作终止不能结束并行模型 Run。

## 3. SDK 内输入队列与停止

应用后续 Run 队列与 SDK 当前 Run 的 steer / followUp 队列分别记录。SDK 内每条输入分配 inputId，保存完整规范化内容（包括附件引用）、来源 commandId（可空）、targetRunId、delivery 及状态。相同文本的两条输入也有不同 ID，不能用文本作为幂等标识。

规范事件 `input.updated` 包含 `{inputId,delivery,state,commandId?,content?}`，其 envelope 固定所属 Run / Operation。delivery 为 steer / followUp，state 为 queued / consumed / returned / unknown；content 形状为 `{text,attachments?:[{artifactId,mimeType}]}`。首次事件携带内容，之后可省略未变化字段。Snapshot 返回 pendingInputs 及 recoveredInputs；returned 输入可作为草稿取回，不自动执行，重新发送必须是用户的新命令。

明确的 `/stop` 与扩展 ctx.abort 入口按原生 TUI 停止路径实现：

1. 在 worker 控制通道核实目标及停止边界，捕获当前仍未消费的输入；停止窗口中迟到的旧目标输入返回明确结果，不迁移到新任务。
2. 调用 SDK clearQueue，保存对应 input.updated(returned)，随后调用 abort；不等待手机来读草稿。保留原始内容，不能只依赖 clearQueue 返回的字符串而丢掉附件。捕获、清取和停止之间不再把已返回草稿送回 SDK。
3. 返回草稿及输入状态先持久化再展示。故障窗口不能确认某项是否被消费时标为 unknown 并保留原内容，不虚构 returned，也不自动重投。后台扩展在停止期间再次入队的行为需在 S02 与 TUI 对照，不提供未经验证的“清一次队列就能禁止全部未来入队”保证。
4. 依据实际 settle / 最终消息写 Run 终态；正常后台服务不受扩大清理影响。stop 收据不表示当前调用已经停止。

compact **不套用上述清队列步骤**。固定 TUI 直接调用 session.compact；SDK 内部先 abort，未消费队列可能影响其等待及后续执行时序。S02 / S07 必须独立对照有待消费输入时的压缩，显示旧 Run 的实际过程和终态，再启动压缩生命周期；不能假称所有旧输入已经取消，也不能为方便实现额外禁用这些输入。

重启分类先检查 target_run_id：非空的旧 prompt / steer / abort 等运行控制，及旧 respond，均取消为 stale_runtime；已经分派且无法确认结果的仍是 unknown。只有没有旧目标、从未分派的独立 prompt / follow_up / compact 才适用后续队列保留规则。旧目标 prompt 不生成新的 queued Run 或暂停队列成员。

## 4. 标题、配置与异步 hook

SQLite 保存已确认标题及 version，但变更可来自手机或 pi。手机 rename 先预留版本并持久化所需标题，再同步 SDK；适配器标记该次同步，匹配的 session_info_changed 回声不重复递增版本。扩展主动 setSessionName 产生新的原生变更：按 worker 的事件顺序确认到 SQLite、递增版本、广播 session.updated。不要用“应用标题永远优先”覆盖后来的原生改名。

手机改名与原生事件交错时，适配器必须保存每次写入的来源 / 顺序，并识别已被后续变更取代的延迟回声；只比较标题字符串不足以解决 A→B→A。持久历史恢复时：若还有明确未同步的手机 rename，重放该已确认意图；否则读取有效 pi session info 校准标题，包括 SDK 已落盘但事件未提交的窗口。归档仍完全由应用维护。S04 / S07 将最小同步水位和待同步意图保存在 live_state 的 metadataSync 投影，并验证重启、并发和回声，不新增远程标题轮询服务。

SDK 方法返回不总等于扩展回调结束。setThinkingLevel 触发的 thinking_level_select 使用异步 emit；待答表单应归属于仍有效的扩展子 Operation，不能随外层配置 Command 返回而取消。setModel 的 hook 错误可能由 ExtensionRunner 错误监听上报而不 reject 方法 Promise；同时订阅真实错误通道、读取有效配置并显示关联操作错误，不能只靠 catch。正常 API 返回可确认配置本身，不能据此声称所有扩展处理成功。

## 5. 合法历史与原生会话替换

“首次 assistant 通常触发自动落盘”是新建 Session 的 SDK 行为，不是所有合法 JSONL 的完整性条件。已有文件只要具有有效 header、正确身份 / cwd 归属、可解析且符合原生格式的 entry 关系，即可成为 persisted；合法 header-only 或仅有非 assistant entry 的导入 / fork 不因缺少 assistant 被拒绝。零字节、身份不符、不可解析及已确认的写入残片仍保护原文件，不自动重建；不能仅凭“没有 assistant”判断残片。

应用项目 / Session ID 与原生文件映射必须覆盖 AgentSessionRuntime 的 new / switch / fork / import：新原生 Session 对应新的或已注册的应用 Session，旧时间线不改绑；切到已有 ID 时认领已有映射。通过运行时 factory 及 setRebindSession 完成目标映射、cwd 资源与 UI 重绑定，再执行 withSession 后续回调。各操作携带原来的来源和目标绑定，不能把回调全部归到 worker 当前选中的 Session。

fork / import 可能在 runtime factory 返回前已写出目标文件：操作意图先持久化；目标 manager 已可得时，先确认映射再绑定会产生新执行的 session_start / withSession。中间失败保留源历史和可识别的未认领文件，标记实际中断；不能为了满足“所有文件必须先 ACK 才创建”的过强断言禁止原生替换，也不能把未确认结果报成新 Session 创建成功。S02 核实具体调用顺序，S06 / S07 实现身份交接及异常测试。

编辑器 `/clone` 使用原生 fork 的 position=at，包含当前叶节点，ACK 后清草稿且不生成新 prompt。`/import` 先确认并校验完整 JSONL。原 cwd 存在时保持原语义；缺失时必须显式选择当前 owner 已注册项目目录，worker 在受管 session 目录排他创建仅修订 header.cwd 的副本、重新校验原生 ID/cwd，再把已在目标位置的路径交给固定 SDK。主进程在 intent 阶段检查原生 ID、目标项目、owner 和目标 worker 占用；拒绝通过负向 ACK 返回，不让 SDK 开始替换。原生采用后再次校验目标文件的 ID/cwd，再认领映射并 ACK。导入保留 ID；同项目已映射的同一原生 ID 复用应用 Session 并更新文件路径，不另造重复身份，原输入/旧副本保留。不同 Session 的事件归属不因 worker 更换而混用。

重定位副本在 session_replaced 前已持久正确 cwd。主服务在 bound 前崩溃时，未知导入不重放，副本作为受管孤立历史由现有找回流程显式认领；bound 已提交而 ACK 未到时沿既有映射恢复。源文件始终不修改。原 cwd 仍存在时拒绝 override，未注册/其他 owner 目录、无效路径及损坏历史都在当前 runtime 失效前失败。固定 SDK 只在内存应用 cwdOverride 的差异保留专项回归，产品路径不留下该不一致。

`/reload` 沿原生 streaming/compacting 前置条件；关闭旧 UI 与订阅后调用 SDK reload，shutdown hook 仍可产生待答表单。新 session_start 前再次清理 shutdown hook 留下的旧组件，重装默认编辑器/键位，再允许新扩展设置自己的 UI。清理按应用 Session 归属进行，不关闭其他源会话的存活组件；不复用旧扩展工厂或盲目重发输入。新表单和新快捷键在独立 Operation 中运行，模型目录与资源错误可见。编辑器草稿沿实际当前值保留，不用重载前快照覆盖重载期间的新编辑。

## 6. 修订验收归属

托管 `/share` 使用独立 Operation 和现有 UI 交互，不生成模型 Run。固定 SDK 原生 HTML 导出或 exportSessionForShare 的分支 JSONL/系统提示/工具元数据先冻结，再完整预览并明确确认目标及可见范围；实际上传使用相同字节。Gist 使用 gh、Radius 使用原生凭据与 organization 上传。上传副作用不能通过表单幂等保证远端恰好一次：已分派但结果未知时不自动恢复、重试或回退另一服务。选择/预览/确认期间退出或会话切换沿现有取消信号，不因长等待阻塞其他控制。

| 问题 | 必须验证的场景 | 阶段 / 验收 |
| --- | --- | --- |
| 无 Run 内容 | 空闲 / 初始化 custom 消息、无 Run 用户 Bash、运行中独立内容、中断封存、重连 / snapshot 一致；模型 Run 数不因这些内容增加 | S02、S03、S04、S07、S10 / AT06、AT07、AT32 |
| 自主与多 Run | 无手机命令的扩展 Run；同一命令顺序产生 compact 和 prompt；跨同 owner Session 的因果关联可追踪，跨 owner 被拒绝 | S02、S04、S06、S07 / AT07、AT12、AT32 |
| 停止与输入 | 确定性阻塞流式，加入重复文本 / 附件输入后 stop，未消费项可取回且不自动执行；compact 单独对照实际时序 | S02、S07、S10 / AT05、AT14、AT15、AT32 |
| 恢复分类 | 活动 prompt 入库后、IPC 前崩溃；旧控制 cancelled，无新的 queued Run / 队列成员 | S06 / AT19 |
| 原生标题 / hook | 扩展改名、A→B→A、手机并发 rename、落盘后事件提交前崩溃；thinking hook 方法返回后仍可回答、runner 错误可见 | S02、S04、S07 / AT04、AT11、AT16、AT32 |
| 合法导入 | header-only / 非 assistant 历史恢复成功，损坏样例保留；原生 new / switch / fork / import 的映射与后续事件不串 Session | S02、S06、S07 / AT02、AT19、AT32 |

固定 SDK 依据：[AgentSession](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts)、[TUI](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/modes/interactive/interactive-mode.ts)、[SessionManager](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts)、[AgentSessionRuntime](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session-runtime.ts)。
