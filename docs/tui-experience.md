# 整体以本地 pi TUI 体验为基线

状态：2026-09-12 用户确认的产品原则，适用于整个 V1。手机提供适合触屏的界面，后端保留原生 pi 的能力、配置和操作语义。Bash 只是其中一个例子，具体对照见 [Bash 兼容要求](bash-compatibility.md)。

## 1. 实施原则

默认复用同版本 pi 的工具、资源发现、扩展、skills、prompt templates、上下文、模型能力及会话操作。新增的应用代码主要负责项目组织、原生能力的移动端适配、传输与持久化。不能因为某个能力难适配、可能有风险或理论上可能发生竞态，就先把它关掉、自动取消或锁到“空闲才可使用”。

先用原生 SDK / TUI 跑通，再按实际差异修复适配。只有可复现的问题或用户明确配置才产生额外限制；记录复现步骤、受影响环境、原生行为、原因、作用范围和解除方式。优先修复适配器，必要限制仅影响具体操作或环境，不扩展到整个 Session / 项目。鉴权、数据完整性与准确报告结果继续保留；它们不授权增加工具审批或减少 pi 功能。

“界面尚未实现”与“功能被禁止”必须区分。S02 建立实际能力清单，状态为 available / needs_adapter / disabled_by_owner / upstream_unavailable，并注明证据。needs_adapter 是开发待办，不是允许永久禁用的产品决策；基础对话、工具、模型、会话与标准交互的适配必须在发布前完成。终端排版、快捷键、主题或自定义 TUI 组件按真实需要适配，不能据此关闭整个扩展或其工具。

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

标准 select / confirm / input / editor 对话框在所有生命周期阶段可回答、取消和重连恢复。notify、状态 / 文本 widget、编辑器内容等先适配为手机组件。初始化尚未 ready 也必须能处理 respond；UI 等待不持有其他控制命令需要的锁。扩展的任意终端渲染函数不能当作 JSON 直接发送，S02 记录实际 API，S07 / S10 做对应适配，不假称完整渲染已实现。

输入附件、用户 Bash（`!` / `!!`）、会话树 / fork / 导出 / 导入、扩展命令和自定义工具都进入 S02 能力清单，沿用 SDK 已有能力逐项接入；初稿中的“文本输入”“任意 TUI 留待后续”等不再作为后端永久拒绝规则。涉及新 DTO 时，在实现该适配前同步协议、schema、示例及测试，不用未定义的任意方法反射调用作为捷径。

[原生运行补充契约](native-runtime-contract.md)已明确本轮审核发现的适配：无 Run custom / 用户 Bash、自主和一命令多 Run、stop 输入恢复、旧目标 prompt 的重启分类、扩展标题同步及合法空历史 / 原生会话替换。它们属于开发与验收要求，不能留作“默认关闭后再考虑”的项目。

同环境的本地 TUI 仍可因原生模型能力、OS 权限或自身 API 前置条件返回错误，后端应准确呈现。不能把预计问题写成已经发生的问题；尚无证据的限制不进入默认配置。

## 4. 整体对照验收

对应 FR14 / AT32，与 [AT31 的 Bash 对照](bash-compatibility.md)一起执行。对比相同 Linux 环境、SDK 版本、模型、资源及用户配置；比较操作是否可用、处理时机、状态和实际结果，不要求终端像素或模型措辞相同。

| 对照项 | 必须验证的结果 |
| --- | --- |
| T01 原生资源 | 原生工具、项目 / 全局扩展、skills、templates、上下文文件按相同配置加载；没有额外默认关闭 |
| T02 输入与命令 | 回复中可 steer / follow-up；stop 清取完整未消费输入为草稿且不重放；扩展 slash 即时执行，自主及一命令多 Run 不伪造外部请求 |
| T03 模型与压缩 | 按原生切配置；实际值与 hook 错误分别可见；compact 的待消费队列行为单独对照，不强加 stop 的 clearQueue 或全局空闲门槛 |
| T04 全阶段交互 | initialize / configure / run / bash / extension 均可回答及取消四类表单；初始化未 ready 或 thinking 方法返回后仍可等待，无 Run 不自动取消 |
| T05 会话与并发 | 同项目多 Session 并行，归档不停止执行；扩展改名、并发 rename 与回声准确同步，旧队列暂停不锁新操作 |
| T06 连续使用 | 手机断开执行继续；默认保留已加载扩展状态；无 Run 内容可独立中断 / 回放，旧目标 prompt 重启后不变新任务 |
| T07 适配清单 | 附件、用户 Bash、custom、树 / fork、导入导出及 UI 均有入口 / 步骤；合法 header-only / 非 assistant 历史可恢复，原生替换和后续执行不串 Session |
| T08 问题驱动的限制 | 任一新增默认限制都有实际复现或用户配置依据，范围和解除方式明确；普通启动无需清理证明，故障记录不阻止无关操作 |

S02 交付清单与原生基线；S06 验证运行 / 恢复；S07 完成控制与标准交互；S10 验证移动入口；S12 复验正常 Linux 部署；S13 汇总证据。当前合同、Linux、Docker 子集已有对应阶段报告；真实 provider、交互式原生 TUI、Android / iOS 实机及终端专用 custom renderer 对照仍未完成，不将这些缺口描述为已通过。

扩展的 `setWorkingVisible`、`setWorkingIndicator({ frames, intervalMs })`、`setHiddenThinkingLabel`、`setTitle` 和 `setToolsExpanded` 通过已持久化的 `runtime.notice` 投影到手机。工作行只在活动 Run 中显示，空 frames 隐藏指示器，无参数恢复默认指示器；隐藏思考标签只替换已隐藏内容的提示，不隐藏原本可见的思考。窗口标题独立显示，不修改 Session 名称。工具默认折叠，可逐项手动展开；扩展再次设置时覆盖本地展开选择，完整输出和模型工具结果不受影响。

`getToolsExpanded()` 返回当前 worker 的扩展展开设置；新 worker 从原生默认 false 开始并发布通知，同一 worker 的原生会话替换在目标映射确认后发布当前值。通知支持快照及断线重放，无须新增协议字段或数据库迁移。上述标量控制不代表已支持任意终端组件，也不替代设备渲染验收。

widget 工厂现在由固定版本 `pi-tui@0.85.1` 的 `TuiMainScreen` 对象及 SDK dark 主题承载，在 80 列视口调用原生组件 `render()`，向手机发布去除 ANSI 控制序列后的文本。`requestRender()` 支持异步刷新、相同内容去重；同名替换、移除和 worker 退出调用 dispose，过期刷新不再覆盖新内容。编辑器上下 placement 对文本及工厂 widget 都生效。异步刷新在原 Operation 已终态时创建归属原 Session 的独立 Operation。

这属于无焦点文本 widget 适配；颜色、自定义主题、终端图片、动态视口仍待完成。终端图片和渲染异常显式报告，不能用上次成功内容冒充新结果。宿主不启动本地终端或占用 worker 的 stdin/stdout，组件输出不会混入 IPC。

`setHeader` / `setFooter` 工厂复用 80 列文本宿主，手机分别在会话内容顶部和输入区下方显示；undefined 清除扩展画面并恢复普通布局。footer 使用原生 FooterDataProvider，提供真实工作目录的 Git 分支、分支变化订阅、扩展状态和当前可用 provider 数量。状态变更刷新画面；header 的 setExpanded 跟随扩展工具展开设置。替换、清除时销毁组件，worker 退出再清理 Git watcher；异步刷新归属安装时 Session，不转移到后来切换的 Session。渲染失败清除旧画面并提示错误，原始工厂不传到手机。编辑器交互按下文单独验收，不把 header/footer 文本显示当成编辑器支持。

非 overlay 的 `custom()` 已接入根组件 handleInput 与 done 回调：使用同一 80 列文本宿主及当前 agentDir 的原生 KeybindingsManager，每个实例有独立子 Operation、画面及控制表单。手机方向键等按钮发送终端序列，也可输入文本；画面随 requestRender 刷新。Esc 由组件自行解释，取消文本输入返回控制面板，用户明确取消控制面板返回 undefined 并销毁组件。done 的原始对象留在 worker 返回给扩展，不做 JSON 往返；同步/异步工厂和异步 done 均可结束，迟到工厂只销毁、不重开控件。

custom 另支持固定 80×24 文本视口中的 overlay：复用原生合成、几何计算、可见性、onHandle 的隐藏/恢复/焦点控制，以及 TUI 的 addInputListener 和 setFocus 输入路由。overlayOptions 函数按 SDK 0.85.1 实际实现只在安装时求值；未传配置时保留组件 width 回退。每个 custom 是独立虚拟 TUI，背景仅包含该实例添加的组件，不是整个应用的终端画面。原生输入经虚拟 Terminal 路由，不占用进程 stdin/stdout。

仍未支持 ctx.ui.onTerminalInput 的应用级监听、跨 custom 实例共享焦点、任意组合键或终端像素效果；不能将文本适配当成完整 TUI。画面仅跟随待答控件展示；worker 崩溃使旧交互失效，不能用重连恢复内存中的组件回调或重发旧按键。

`setEditorComponent` 工厂接收原生 EditorTheme 结构、KeybindingsManager、padding 和补全显示设置；组件留在 worker，按 custom 的独立 Operation / 按键表单显示和操作。`getEditorComponent` 返回原工厂，替换/恢复保留文本；setEditorText、getEditorText、pasteToEditor 操作实际组件，粘贴优先使用原生光标插入。相同手机草稿重复同步不重置光标或补全状态。自动补全使用原生 CombinedAutocompleteProvider，包含文件、扩展命令、prompt templates 和已启用 skills，addAutocompleteProvider 按顺序包装。输入 Enter 是否提交由组件决定，onSubmit 的文本原值用于提交（沿原生去除首尾空白），不从画面反推输入。

普通提交经 SDK prompt，运行中使用 steer；扩展 slash 保留即时处理；`!` / `!!` 使用原生用户 Bash hook 和执行器，不误发为模型文本。后续用户提交不归因于早先安装编辑器的扩展命令：独立 Operation、原生因果 Run，外部 Command 可空。提交异常保留文本为草稿，不自动重发、不覆盖用户较新的草稿。取消编辑器控件/恢复默认/会话替换会关闭旧按键并保留草稿；停止编辑器不停止已开始的模型任务。worker 重启不恢复内存回调。

终端专用内置 slash 菜单尚未接入该编辑器路径，识别后提示使用手机对应入口并保留文本，不能当普通 prompt 发给模型。完整应用快捷键、压缩期间排队对照、图片粘贴及真机键盘手感仍待验收，现有手机附件及模型/会话/压缩入口继续独立使用。本适配不宣称完整交互式 TUI 已通过。

依据：[SDK 与资源发现](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md)、[AgentSession 控制与扩展行为](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts)。
