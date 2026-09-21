# 常用移动流程以 pi 原生行为为基线

状态：2026-09-22 用户确认的 V1 产品范围。手机提供适合触屏的界面，后端保留常用 pi 能力、配置和操作语义。产品不复刻完整终端；Bash 仍保留原生执行能力，具体对照见 [Bash 兼容要求](bash-compatibility.md)。

## 1. 实施原则

默认复用同版本 pi 的工具、资源发现、扩展、skills、prompt templates、上下文、模型能力及会话操作。新增的应用代码主要负责项目组织、常用能力的移动端适配、传输与持久化。不能因为某个范围内能力难适配、可能有风险或理论上可能发生竞态，就先把它关掉、自动取消或锁到“空闲才可使用”。

先用原生 SDK / TUI 跑通，再按实际差异修复适配。只有可复现的问题或用户明确配置才产生额外限制；记录复现步骤、受影响环境、原生行为、原因、作用范围和解除方式。优先修复适配器，必要限制仅影响具体操作或环境，不扩展到整个 Session / 项目。鉴权、数据完整性与准确报告结果继续保留；它们不授权增加工具审批或减少 pi 功能。

“界面尚未实现”与“功能被禁止”必须区分。S02 建立 V1 能力清单，状态为 available / needs_adapter / disabled_by_owner / upstream_unavailable，并注明证据。needs_adapter 是范围内的开发待办，不是允许永久禁用的产品决策；基础对话、工具、模型、会话与标准交互的适配必须在发布前完成。终端排版、跨 custom 实例共享焦点、聊天区域清屏/重绘、完整主题、硬件光标、全屏/滚动区和所有低频 TUI 快捷键不属于 V1；缺少这些效果不能成为关闭整个扩展或其工具的理由。

V1 必须直接支持的手机流程包括：对话、工具和用户 Bash；模型、思考等级与压缩；Session 新建、切换、改名、归档与恢复；图片输入；标准扩展表单和常用 slash 命令；断线后的快照、历史和草稿恢复。扩展终端 UI 的常用结果通过有界文本、触控控制和标准表单投影，无法投影的终端专属视觉效果以明确限制说明处理。

## 2. 本轮撤回的预先限制

| 原先做法 | 当前决策 |
| --- | --- |
| 项目扩展默认关闭 | 使用 DefaultResourceLoader 和 pi 原生信任 / 配置流程；已在该开发环境启用的资源照常使用，不加一层应用默认禁用 |
| 无 Run 的对话框立即取消 | 初始化、配置、扩展回调都可以产生手机表单；用 operationId + workerEpoch 关联，断网后等待并重现 |
| 模型 / 等级一律空闲才可改 | 按 SDK 原生行为调用，记录实际配置和生效位置，不因有活动 Run 或旧队列而拒绝 |
| 忙时 compact 一律拒绝 | 用户明确触发压缩时遵循 SDK 的“先停止当前运行，再压缩”；展示这一行为，保持两个 Run 的事件归属清楚 |
| 运行中归档、归档后操作全部拒绝 | 归档只是列表组织；既有执行、交互和操作继续可用，不借归档隐式停止任务 |
| 同工作区强制串行、2 个 Run / 4 个 worker、5 分钟回收 | 不同 Session 默认可并行，包括同工作区；容量及回收策略由运营者按实际资源配置，默认不额外设限、不自动回收已加载 Session |
| 错误后空队列也锁住整个 Session | 保留异常记录；有旧后续项时只暂停这些项，仍可新对话、改配置、回答交互。最后一项取消后恢复空的 ready 队列 |
| 启动必须经过宿主 helper 登记；异常必需整容器恢复才能继续 | 普通 docker compose up 即可启动；未知命令不自动重跑。异常记录不变成永久项目封锁；具体清理、重启按实际故障处理 |

单个 AgentSession 同时生成中的输入按原生 steer / follow-up 路径处理，不用 SESSION_BUSY 代替输入适配。互相冲突的底层状态变更仍要保持原子性，但操作锁不能跨整个 prompt 或等待手机答案，从而挡住 SDK 本来允许的控制。

旧队列暂停只阻止自动执行旧意图。用户发新的 prompt 是新的明确操作，可独立运行；它不自动恢复旧队列。未知结果保持 unknown，不因用户继续工作而改成成功，也不重放该旧命令。

## 3. 移动端如何承载原生能力

统一输入区支持普通输入及 SDK 处理的扩展 slash 命令；运行中输入提供 steer / follow-up，扩展命令保留原生即时处理路径。按钮和命令面板是入口，不构成后端命令白名单。模型、等级、压缩及会话操作使用对应 SDK API，而非将命令文本误发给模型。

标准 select / confirm / input / editor 对话框在所有生命周期阶段可回答、取消和重连恢复；image 表单用于选择并上传当前设备的真实图片 artifact。notify、状态 / 文本 widget、编辑器内容等先适配为手机组件。初始化尚未 ready 也必须能处理 respond；UI 等待不持有其他控制命令需要的锁。扩展的任意终端渲染函数不能当作 JSON 直接发送，S02 记录实际 API，S07 / S10 做对应适配，不假称完整渲染已实现。

输入附件、用户 Bash（`!` / `!!`）、会话树 / fork / 导出 / 导入、扩展命令和自定义工具都进入 S02 能力清单，沿用 SDK 已有能力逐项接入；初稿中的“文本输入”“任意 TUI 留待后续”等不再作为后端永久拒绝规则。涉及新 DTO 时，在实现该适配前同步协议、schema、示例及测试，不用未定义的任意方法反射调用作为捷径。

[原生运行补充契约](native-runtime-contract.md)已明确本轮审核发现的适配：无 Run custom / 用户 Bash、自主和一命令多 Run、stop 输入恢复、旧目标 prompt 的重启分类、扩展标题同步及合法空历史 / 原生会话替换。它们属于开发与验收要求，不能留作“默认关闭后再考虑”的项目。

同环境的本地 TUI 仍可因原生模型能力、OS 权限或自身 API 前置条件返回错误，后端应准确呈现。不能把预计问题写成已经发生的问题；尚无证据的限制不进入默认配置。

## 4. 常用流程对照验收

对应 FR14 / AT32，与 [AT31 的 Bash 对照](bash-compatibility.md)一起执行。对比相同 Linux 环境、SDK 版本、模型、资源及用户配置；比较范围内操作是否可用、处理时机、状态和实际结果，不验收终端像素、终端共享焦点或模型措辞。

| 对照项 | 必须验证的结果 |
| --- | --- |
| T01 原生资源 | 原生工具、项目 / 全局扩展、skills、templates、上下文文件按相同配置加载；没有额外默认关闭 |
| T02 输入与命令 | 回复中可 steer / follow-up；stop 清取完整未消费输入为草稿且不重放；扩展 slash 即时执行，自主及一命令多 Run 不伪造外部请求 |
| T03 模型与压缩 | 按原生切配置；实际值与 hook 错误分别可见；compact 的待消费队列行为单独对照，不强加 stop 的 clearQueue 或全局空闲门槛 |
| T04 全阶段交互 | initialize / configure / run / bash / extension 均可回答及取消四类表单；初始化未 ready 或 thinking 方法返回后仍可等待，无 Run 不自动取消 |
| T05 会话与并发 | 同项目多 Session 并行，归档不停止执行；扩展改名、并发 rename 与回声准确同步，旧队列暂停不锁新操作 |
| T06 连续使用 | 手机断开执行继续；默认保留已加载扩展状态；无 Run 内容可独立中断 / 回放，旧目标 prompt 重启后不变新任务 |
| T07 适配清单 | 附件、用户 Bash、custom 的文本/表单投影、树 / fork、导入导出及常用 UI 均有入口 / 步骤；合法 header-only / 非 assistant 历史可恢复，原生替换和后续执行不串 Session |
| T08 问题驱动的限制 | 任一新增默认限制都有实际复现或用户配置依据，范围和解除方式明确；普通启动无需清理证明，故障记录不阻止无关操作 |

S02 交付清单与原生语义基线；S06 验证运行 / 恢复；S07 完成控制与标准交互；S10 验证移动入口；S12 复验正常 Linux 部署；S13 汇总证据。当前合同、Linux、Docker 子集已有对应阶段报告；真实 provider 的剩余范围内流程和 Android / iOS 实机仍未完成，不将这些缺口描述为已通过。交互式原生 TUI 可用于核对语义，但完整 TUI 和 renderer 终端像素不再是发布门槛。

扩展的 `setWorkingVisible`、`setWorkingIndicator({ frames, intervalMs })`、`setHiddenThinkingLabel`、`setTitle` 和 `setToolsExpanded` 通过已持久化的 `runtime.notice` 投影到手机。托管编辑器的思考块动作另发布内部 `setThinkingVisible` 显示状态，同样支持快照和断线重放。工作行只在活动 Run 中显示，空 frames 隐藏指示器，无参数恢复默认指示器；隐藏思考标签用于 redacted 或用户主动隐藏的内容。窗口标题独立显示，不修改 Session 名称。工具默认折叠，可逐项手动展开；扩展再次设置时覆盖本地展开选择，完整输出和模型工具结果不受影响。

`getToolsExpanded()` 返回当前 worker 的扩展展开设置；新 worker 从原生默认 false 开始并发布通知，同一 worker 的原生会话替换在目标映射确认后发布当前值。通知支持快照及断线重放，无须新增协议字段或数据库迁移。上述标量控制不代表已支持任意终端组件，也不替代设备渲染验收。

widget 工厂现在由固定版本 `pi-tui@0.85.1` 的 `TuiMainScreen` 对象及 SDK dark 主题承载，在 80 列视口调用原生组件 `render()`，向手机发布去除 ANSI 控制序列后的文本。`requestRender()` 支持异步刷新、相同内容去重；同名替换、移除和 worker 退出调用 dispose，过期刷新不再覆盖新内容。编辑器上下 placement 对文本及工厂 widget 都生效。异步刷新在原 Operation 已终态时创建归属原 Session 的独立 Operation。

这属于无焦点文本 widget 适配；颜色、自定义主题、终端图片和动态视口属于终端专属视觉效果，不在 V1 范围。终端图片和渲染异常显式报告，不能用上次成功内容冒充新结果。宿主不启动本地终端或占用 worker 的 stdin/stdout，组件输出不会混入 IPC。

`registerMessageRenderer` 与 `registerEntryRenderer` 使用同一固定 80 列纯文本边界。worker 从当前 ExtensionRunner 取 renderer，以 SDK dark theme、当前工具展开值和原生 outputPad 执行；只把去除 ANSI 的有界文本投影写入协议。custom message 的 renderer 返回 undefined、抛错或渲染失败时沿固定 SDK 回退到原消息内容，`display:false` 不执行 renderer。custom entry 不进入模型上下文：没有 renderer 或返回 undefined 时不创建手机时间线项，成功时写独立 `custom_entry`，调用或渲染异常时保存原生风格失败文本。最多保存 256 行 / 32768 字并显式标记截断；函数、组件、dispose 回调和扩展数据不作为可执行对象重放。SQLite v1 兼容升级扩展 timeline kind，旧历史原样复制；snapshot、历史分页和 WSS 重连重放同一不可变投影。

`setHeader` / `setFooter` 工厂复用 80 列文本宿主，手机分别在会话内容顶部和输入区下方显示；undefined 清除扩展画面并恢复普通布局。footer 使用原生 FooterDataProvider，提供真实工作目录的 Git 分支、分支变化订阅、扩展状态和当前可用 provider 数量。状态变更刷新画面；header 的 setExpanded 跟随扩展工具展开设置。替换、清除时销毁组件，worker 退出再清理 Git watcher；异步刷新归属安装时 Session，不转移到后来切换的 Session。渲染失败清除旧画面并提示错误，原始工厂不传到手机。编辑器交互按下文单独验收，不把 header/footer 文本显示当成编辑器支持。

非 overlay 的 `custom()` 已接入根组件 handleInput 与 done 回调：使用同一 80 列文本宿主及当前 agentDir 的原生 KeybindingsManager，每个实例有独立子 Operation、画面及控制表单。手机方向键等按钮发送终端序列，也可输入文本；画面随 requestRender 刷新。Esc 由组件自行解释，取消文本输入返回控制面板，用户明确取消控制面板返回 undefined 并销毁组件。done 的原始对象留在 worker 返回给扩展，不做 JSON 往返；同步/异步工厂和异步 done 均可结束，迟到工厂只销毁、不重开控件。

custom 另支持固定 80×24 文本视口中的 overlay：复用原生合成、几何计算、可见性、onHandle 的隐藏/恢复/焦点控制，以及 TUI 的 addInputListener 和 setFocus 输入路由。overlayOptions 函数按 SDK 0.85.1 实际实现只在安装时求值；未传配置时保留组件 width 回退。每个 custom 是独立虚拟 TUI，背景仅包含该实例添加的组件，不是整个应用的终端画面。原生输入经虚拟 Terminal 路由，不占用进程 stdin/stdout。

ctx.ui.onTerminalInput 已接入当前 Session 的 custom/editor 虚拟终端，按原生监听器顺序消费或改写输入；普通手机 TextInput 的草稿同步不是终端按键事件。跨 custom 实例共享焦点和终端像素效果不在 V1 范围，文本适配只承诺常用移动语义。画面仅跟随待答控件展示；worker 崩溃使旧交互失效，不能用重连恢复内存中的组件回调或重发旧按键。

`setEditorComponent` 工厂接收原生 EditorTheme 结构、KeybindingsManager、padding 和补全显示设置；组件留在 worker，按 custom 的独立 Operation / 按键表单显示和操作。`getEditorComponent` 返回原工厂，替换/恢复保留文本；setEditorText、getEditorText、pasteToEditor 操作实际组件，粘贴优先使用原生光标插入。相同手机草稿重复同步不重置光标或补全状态。自动补全使用原生 CombinedAutocompleteProvider，包含文件、扩展命令、prompt templates 和已启用 skills，addAutocompleteProvider 按顺序包装。输入 Enter 是否提交由组件决定，onSubmit 的文本原值用于提交（沿原生去除首尾空白），不从画面反推输入。

普通提交经 SDK prompt，运行中使用 steer；扩展 slash 保留即时处理；`!` / `!!` 使用原生用户 Bash hook 和执行器，不误发为模型文本。后续用户提交不归因于早先安装编辑器的扩展命令：独立 Operation、原生因果 Run，外部 Command 可空。提交异常保留文本为草稿，不自动重发、不覆盖用户较新的草稿。取消编辑器控件/恢复默认/会话替换会关闭旧按键并保留草稿；停止编辑器不停止已开始的模型任务。worker 重启不恢复内存回调。

编辑器内置命令以[命令与快捷键状态表](editor-command-status.md)为当前清单。手机统一输入识别 `/`，搜索/快捷填入 23 个托管命令并通过 extension_command 执行；自定义扩展命令也可直接输入，slash 不误发模型。运行开始后普通输入默认 steer，可切 follow-up，空闲后恢复 prompt。follow-up/dequeue 已覆盖压缩/生成使用同一 SDK 队列路径；图片粘贴复用手机 artifact 上传并进入 SDK 图片输入；挂起在共享服务架构中保持任务运行。真机键盘/图片选择仍待验收；服务器系统剪贴板和完整交互式 TUI 不属于 V1。

工具输出、助手文本、thinking、工具参数或 Bash 展示副本带 artifactId 时，历史页和执行页均可按需读取服务器 artifact 的 64 KiB 鉴权文本预览。请求使用 Range，不自动下载整个大文件；仍有后续字节时明确标记。网络或权限失败保留原展示副本并允许重试。

应用输入监听按注册顺序安装到原生 TUI，支持 consume、data 改写、晚注册和取消订阅；组件自身的 tui.addInputListener 保持原生相对顺序。会话替换清理旧应用监听，仍待答的源 custom 组件保留自己的局部监听和按键能力；新 Session 不继承旧监听。worker 退出释放全部订阅。扩展 registerShortcut 使用原生 getShortcuts 的冲突处理及 matchesKey，绑定到具有 actionHandlers 的 CustomEditor；保留扩展自定义 onExtensionShortcut。快捷键回调使用 SDK createContext，异步不阻塞输入，错误归属原编辑器 Session，不能把快捷键注册套到所有普通 custom 组件。

控制表单新增“组合键”输入，支持 ctrl/alt/shift 与字符、方向/导航键及 F1–F12，例如 ctrl+k、ctrl+alt+j、shift+enter。无效键名提示后回到控件，不关闭组件或向模型发送文本。固定 SDK 0.85.1 的 matchesKey 对带修饰键的 F1–F12 恒返回 false；适配仍传递标准终端字节供原始监听/组件处理，但不声称它们能通过原生扩展快捷键匹配。

CustomEditor 默认应用动作沿用用户 keybindings 配置。Esc 先取消补全，再按当前阶段停止模型/Bash 或取消压缩/重试；模型停止时未消费文本恢复到编辑器且不自动重发。空白草稿在原生前置操作均未触发时，两次 Esc 间隔小于 500ms 按 doubleEscapeAction 打开树（默认）、分叉或不操作；成功触发后清空双击计时，单次停止不作为空闲双击计数。自定义 onEscape 和扩展快捷键仍优先。Ctrl+C 清草稿；Ctrl+O 切换工具展开。follow-up 在活动时排到原生 follow-up 队列、空闲时等同普通提交；dequeue 一次取回 steering/follow-up 并置于现有草稿前，不自动发送。外部编辑动作打开手机完整 editor 表单，思考显示动作同步 SDK 设置与手机投影。空草稿 Ctrl+D、500ms 内双 Ctrl+C 与 `/quit` 关闭远程编辑器及子菜单，后端任务继续运行；非空 Ctrl+D 保持向前删除。挂起键显示服务持续运行通知；图片粘贴键打开手机 image 表单并附到下一条模型输入。真机按键、图片选择权限与系统剪贴板差异仍需验收，不能把当前子集当成完整应用热键已通过。

模型循环现已接入原生 app.model.cycleForward/cycleBackward（Linux 默认 Ctrl+P / Ctrl+Shift+P），思考等级循环接入 app.thinking.cycle（默认 Shift+Tab）；用户 keybindings 和显式历史键优先级保留。支持运行中切换，配置同步到手机并由 SDK 写入当前会话历史，不改全局默认值，也不重启当前模型请求。只有一个可用模型或当前模型不支持思考等级时提示原因。配置 hook 的表单独立于编辑器控制表单和模型 Run，可正常作答/取消；思考块显示切换已接入，原生终端聊天重绘仍待对照。

CustomEditor 的 Ctrl+L（app.model.select，可重映射）和 `/model` 可打开原生模型菜单，沿现有文本画面和输入表单使用搜索、目录刷新、上下选择、作用域 Tab、Enter 选择及 Ctrl+S 保存默认值；具体键位以原生菜单提示和用户配置为准。`/model 引用` 使用 SDK 精确匹配规则（包括 provider/id、大小写及歧义），先检查作用域或缓存；作用域内无匹配直接进入搜索，无作用域则调用原生共享目录刷新，15 秒超时后使用缓存，再次无精确匹配时打开预填搜索菜单。关闭编辑器取消该刷新订阅，不终止其他订阅；刷新异常显示原因并保留搜索入口。普通选择及精确引用只改当前会话，保存默认值才更新全局配置。Esc/表单取消保留当前模型，不停止执行；关闭编辑器或切换 Session 后旧菜单失效。菜单已选中时先收起画面，再展示 model_select 扩展表单；精确引用沿同一独立 configure Operation 等待 hook，不提交模型 prompt。当前菜单和编辑器分属独立虚拟表面；共享终端焦点及低频终端菜单不属于 V1。

CustomEditor 输入 `/resume` 可打开原生历史菜单，`/new` 新建会话，也可配置 app.session.resume/new 快捷键（SDK 默认无绑定）。菜单保留搜索、作用域、排序/命名过滤、路径展示，以及原生重命名和确认删除；当前历史不能删除。重命名当前会话立即同步手机标题，其他历史标题在后续加载时同步。删除只移除原生历史文件，手机事件记录保留；菜单明确提示这一差异，缺失历史不会被静默重建。取消菜单不停止活动模型；选择后走既有会话映射，旧编辑器按键失效。

`/fork` 与可配置的 app.session.fork 打开原生用户消息选择器，默认选中最新消息；保留原生上下选择、确认和取消。空历史只通知，不创建新会话。确认通过已绑定的 fork 动作执行原生 before-fork hook，复制所选消息之前的路径；映射确认后在目标会话把所选文本恢复为草稿，不自动发给模型。源历史及手机事件归属保留。恢复/分叉/树共用一个菜单生命周期，重复打开不叠加菜单，编辑器结束或会话替换后旧菜单输入失效。

`/tree` 与 app.session.tree 使用原生 TreeSelectorComponent，保留搜索、过滤、折叠、标签及当前叶节点无操作行为。复制键在手机打开可长按复制的文本框，不修改消息或草稿；沿既有表单最多显示 32768 个字符，超过时明确提示。树导航使用原生 AgentSession.navigateTree：先询问无摘要/摘要/自定义指令，遵循 branchSummary.skipPrompt；取消摘要选项返回原选中节点，取消自定义指令返回选项。确认后才取回未消费队列并停止活动响应，保持每条 Input 的持久 returned/unknown 状态。摘要有独立取消表单和编辑器 Esc 入口，调用 abortBranchSummary；取消后返回树，不自动发送恢复草稿。原生 before-tree/session-tree 扩展及异步表单保留，已开始的导航不因编辑器关闭而自动撤销。返回的用户文本只填入空白草稿。

导航改变当前模型上下文，不删除历史分支，也不重写手机事件时间线。无摘要导航沿 SDK 只改变内存叶指针，下一次原生追加记录时才固定新分支；摘要路径写入原生 branch_summary。手机菜单明确说明事件记录保留，不把旧事件列表当作当前模型上下文。树画面与编辑器仍是独立虚拟表面；聊天区域终端重绘、压缩期间 TUI 输入队列刷新和完整终端焦点不属于 V1；远程编辑器退出边界见命令状态表，设备流程仍单独验收。

`/thinking` 使用固定 SDK 的 ThinkingSelectorComponent，保留当前/默认标记、搜索、选择、保存默认键及取消；可用列表直接来自当前模型。`/thinking 等级` 按原生规则忽略大小写精确匹配当前可用等级，未知或当前模型不支持的等级显示可用列表，不发给模型。普通选择/直接设置 persist=false，显式保存才更新默认值并等待设置落盘。菜单打开后模型变化时，最终 setThinkingLevel 仍由 SDK 处理有效等级；手机显示实际结果。thinking_level_select 保持原生 fire-and-forget，待答表单及迟到回调沿既有独立 Operation 生命周期处理，不借用无关 Run。菜单结束/编辑器替换后旧输入失效。

`/scoped-models` 使用固定 SDK 的原生模型范围菜单，支持搜索、启停、按 provider 批量切换、全选/清空、排序和显式保存。选择即时影响当前 Session 的原生范围；关闭不撤销，只有保存键才写 `enabledModels` 并检查 flush 错误。全部、空列表或仅失效条目沿原生语义解除运行时范围限制；只有一个可用范围模型时轮换不强制切换当前模型。配置中的未匹配条目继续可见，目录刷新复用原生共享订阅与 15 秒超时，用户已改选择不会被刷新覆盖。菜单拥有独立 configure Operation，编辑器结束或 Session 替换后旧菜单失效；范围调整不提交模型 prompt、不停止正在运行的模型。当前证据来自本地合成 provider 与真实服务进程，尚非真实 TUI 或设备验收。

`/settings` 现使用原生 SettingsSelectorComponent、搜索、值循环和模型思考覆盖子菜单。已接通自动压缩、steer/follow-up 模式、transport、HTTP idle timeout、模型思考覆盖增删、图片自动缩放/模型图片阻断、skill 命令、默认项目信任、双 Esc、树过滤、编辑器 padding 与补全条数。运行时设置使用 SDK setter/dispatcher，当前模型覆盖同步 thinking，编辑器支持对应 setter 时立即更新布局与补全；不具备这些可选接口的自定义编辑器保留自身布局，设置仍供后续编辑器使用。默认项目信任是原生后续信任决策的回退值，不重写当前项目的既有决定。设置菜单使用独立 configure Operation，修改后等待 SettingsManager.flush 并检查 drainErrors；写入错误明确提示、操作记失败，不声称已保存。关闭只收起菜单，不撤销已改设置；失败时内存值遵循 SDK 行为，不伪造持久成功。

终端主题、Mermaid/缓存提示/聊天 padding、硬件光标、全屏/滚动/选择复制、terminal progress、clear-on-shrink、quiet-startup、安装遥测及终端警告样式属于终端专属设置，不在 V1 范围；菜单如显示这些项目会明确说明配置未修改。思考块显示、changelog 和模型图片输入已有独立手机入口。终端图片显示/宽度仍遵循 SDK 的原生可见条件，但不阻断模型图片能力。

`/trust` 已接通原生信任菜单及 trust.json 持久化，支持当前目录/父目录、继承、取消；保存不会改变当前 runtime 的信任状态或打断任务。同宿主按 cwd 缓存决定，worker 重启重新决策。首次遇到需信任项目资源时，通过 DefaultResourceLoader 的原生 bootstrap 先加载用户级扩展，再运行 resolveProjectTrusted：project_trust hook 优先，其次保存决定、全局默认 always/never/ask、显式询问。仅本次决定留在内存；拒绝/取消不加载需信任的项目资源，对话和 Bash 不另加限制。hook 的 select/confirm/input/notify 使用 initialize 或触发替换的既有 Operation，SDK handle/映射尚未建立也可回答。完整提示置于 message，断线重放、幂等与原生 hook 错误回退保留；真实设备仍未验收。注入 SettingsManager/ResourceLoader 或未提供信任 UI 的底层 SDK 调用保留原有自定义控制路径。

依据：[SDK 与资源发现](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md)、[AgentSession 控制与扩展行为](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts)。
