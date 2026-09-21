# 开发进度与验证证据

最后更新：2026-09-21。

### 2026-09-21 图片附件与远程挂起语义（本次提交）

- 基线 `b102906`；接通 `app.clipboard.pasteImage` 的真实图片路径。CustomEditor 的专用 onPasteImage 回调打开新增 image interaction，手机复用 Expo 图片选择和 artifact 上传后一次性回答。服务端验证 owner、精确 Session 和已存 MIME，仅在私有 IPC 中传递受控 artifact 文件路径；worker 校验 PNG/JPEG/GIF/WebP 文件签名并构造固定 SDK `ImageContent`，公共事件和持久命令只保存 artifact 引用，不保存路径或图片字节。
- 普通 prompt、steer、follow-up 与编辑器提交统一把图片送入 SDK。编辑器图片随下一条模型输入发送，成功后才清除；取消选择、旧编辑器回调或提交失败保留现有草稿/图片。stop/dequeue 继续保留持久输入的完整附件引用，私有图片文件身份随已知队列项恢复。`app.suspend` 正式定义为远程任务继续运行并显示通知，不向共享 server/worker 进程组发送 `SIGTSTP`。
- 协议增加 image interaction 与 `{attachments:[...]}` response，无 SQL migration。聚焦协议、编辑器、真实 SDK worker 和 API 回归 43/43，服务端构建、lint、全仓 typecheck 和文档检查通过；真实 SDK 用临时 PNG 字节验证模型上下文获得 base64 ImageContent，并覆盖伪造 MIME/文件签名拒绝。测试使用临时目录和本地确定性模型，不读取模型凭据或调用付费 provider。
- 最终 `pnpm verify:S07`：14 passed / 2 failed；构建、命令合同、真实表单/会话进程、lint、全仓 typecheck 和文档均通过，失败仍为已有 live-commands / parity-tui-commands 报告源码身份过期。最终 `pnpm verify:S10`：17 passed / 2 not_run；移动合同、Android/iOS JS、lint、typecheck 和文档通过，Android/iOS 设备缺失。本节点未用合成结果替代报告身份或设备验收。
- 尚未运行 Android/iOS 真机的图片选择权限、后台恢复与物理快捷键，也未做原生 TUI/系统剪贴板对照或真实 provider 图片识别。image action 的远程语义是“在当前设备选择图片”，不声称读取手机或服务器系统剪贴板。

### 2026-09-21 编辑器队列、完整编辑与思考显示动作（本次提交）

- 基线 `5da1606`；接入 `app.message.followUp`、`app.message.dequeue`、`app.editor.external`、`app.thinking.toggle`。follow-up 在 streaming/compacting 时进入固定 SDK 原生 follow-up 队列，空闲时复用普通提交；dequeue 原子取回 steering 后接 follow-up 并置于当前草稿前，不自动重发。完整编辑使用现有持久 editor 表单回填，不在服务器启动 `$EDITOR`。思考显示先保存 SDK hideThinkingBlock，再用可重放的 `setThinkingVisible` 通知同步手机。无公共 Session DTO、核心事件或 SQL migration。
- 保持混合队列的持久输入边界：编辑器自产项没有外部 Command 身份；clearQueue 仍恢复全部文本，但只有完整返回队列与已有持久输入槽位精确一致时才标 returned，无法证明时标记 unknown，不按文本去重或猜 inputId。替代提交统一保存历史、清空草稿，失败时只恢复未被后续编辑覆盖的文本。
- WSL 2 Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。分组定向 SDK/手机回归 32/32，最终 worker 相关 23/23 重跑，并通过服务端构建与移动端 typecheck。隔离 Linux 临时目录中的真实 server/worker 1/1，通过空闲 follow-up、活动队列、编辑器自产与持久 steering 混合 dequeue、SDK 设置落盘、手机显示通知及完整 editor 表单回填；本地确定性 provider，不是付费/真实 provider。
- 最终 `pnpm verify:S07`：14 passed / 2 failed（`test-results/editor-actions-s07-final.log`、`s07/report.json`）；构建、命令合同、完整真实表单/会话进程、lint、全仓 typecheck、文档均通过。失败仍是 live-commands / parity-tui-commands 报告源码身份过期，未用合成结果替代。最终 `pnpm verify:S10`：17 passed / 2 not_run（`test-results/editor-actions-s10-final.log`、`s10/report.json`）；手机合同、Android/iOS JS、lint、typecheck、文档通过，Android/iOS 设备缺失使阶段保持 blocked。
- 后续节点已接入 `app.clipboard.pasteImage` 并正式定义 `app.suspend` 的远程持续运行语义；本节点当时的缺口记录保留为历史。真实 provider、原生交互 TUI、Android/iOS 设备快捷键与显示仍未运行。

### 2026-09-21 导入缺失 cwd 的持久重定位（本次提交）

- 基线 `2bbd559`；`/import` 遇到原 header.cwd 不存在时，确认页显示原路径并要求显式提交当前 owner 已注册项目目录。worker 在受管 session 目录排他创建副本，仅修订 header.cwd 并完整复验原生 ID/cwd，再由固定 SDK 直接采用；副本在 session_replaced 前已经持久正确，源 JSONL 字节不变。原 cwd 尚存时拒绝 override，避免静默改变归属。未采用的副本在取消/拒绝后删除，已采用或 bound 结果未知的副本保留供恢复。无公共 DTO 或 SQL migration。
- 内部 replacement intent 增加 relocationCwd；主服务验证目标真实目录、既有项目与 owner。intent ACK 增加成功/结构化拒绝二选一：无效、未注册或越权目标在 SDK 替换前失败，worker 保持当前 runtime，编辑器保留提交草稿。首轮真实进程 2/3（`import-relocation-process.log`）发现拒绝 intent 没有负向 ACK，导致草稿等待超时；已修复且保留失败证据，没有放宽断言。
- WSL 2 Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。定向最终 67/67（`import-relocation-targeted-release.log`），覆盖无尾换行 header-only、副本清理、源字节、重启校验、原 cwd 存在时拒绝 override、intent 失败不切 runtime，以及 IPC 成功/拒绝。真实 server/worker 3/3（`import-relocation-process-release.log`）：正常导入与重启续聊、取消/未注册目录/损坏历史、bound 前真实 SIGKILL 后由历史找回显式认领，均无自动重放。
- `pnpm verify:S07`：14 passed / 2 failed（`test-results/import-relocation-s07-final.log`、`s07/report.json`）；构建、命令契约、完整真实表单/会话进程、lint、全仓 typecheck、文档均通过。失败仍为 live-commands / parity-tui-commands 已有报告源码身份过期，未用合成结果替代真实验收。本次未修改手机代码，未重跑 S10。
- 尚未运行真实 provider、原生交互 TUI 与 Android/iOS 设备；通用 input/confirm 已走现有手机协议，但 JS/进程测试不替代设备验收。映射前崩溃留下的修订副本作为受管孤立历史保留，由用户显式找回；未知导入不会自动重试。

### 2026-09-21 分享预览与确认上传（本次提交）

- 基线 `3577cb0`；接入最后一个托管内置命令 `/share`，23 个命令均已有入口。目标选择后检查 GitHub CLI / Radius 登录状态，使用 SDK 原生 HTML 或带 pi.share 元数据的分支 JSONL；完整原文分页预览、字节数/SHA-256 与可见范围确认后上传固定副本。预览期间会话变化不改变上传内容，临时导出及时删除；取消未确认流程不上传，未知上传结果不重试、不自动切换服务。沿已有 Operation/交互协议，无 SQL migration。
- 新增直接依赖 `@earendil-works/pi-ai@0.85.1`，仅适配器读取原生 Radius 网关配置；未升级 SDK。首轮单测发现 ESM-only 导出不能经 require.resolve 定位，已改为显式依赖与 ESM import。离线安装缺少缓存元数据，在线补齐；锁文件仅增加直接依赖，未保留包管理器顺带改写的无关解析。
- 环境：WSL 2 Linux / Node 24.19.0 / pnpm 10.28.0；合成会话、假 gh 与注入 transport，无真实账号上传或付费模型调用。定向最终 14/14 通过（`test-results/share-unit-release.log`），覆盖固定字节、确认/取消、导出清理、鉴权失败、上传响应丢失/取消、URL 校验、Radius 原生元数据及不回退。查看器地址无效仍保留已创建 Gist 的明确结果。冻结安装通过（`share-frozen-install.log`）；真实进程 3/3（`share-process.log`），覆盖真实 SDK HTML、预览校验值、取消/失效回答、幂等重复确认、服务重启不重发及导出回归。
- `pnpm verify:S07`：14 passed / 2 failed（`test-results/share-s07.log`、`s07/report.json`）；构建、命令契约、完整真实表单/会话进程、lint、全仓 typecheck、文档均通过。失败仍为 live-commands / parity-tui-commands 已有报告源码身份过期，未用合成结果替换真实验收。本次未修改手机代码，未重跑 S10。
- 最终查看器地址异常处理修改后，适配器重新构建通过（`share-adapter-release.log`），分享/导出真实进程重新验证 3/3（`share-process-release.log`）；最终文档检查通过（`share-docs-release.log`）。
- 未覆盖：真实 Gist / Radius 上传、原生交互 TUI、Android/iOS 设备。当前 HTML 预览为完整源码分页，尚无手机 HTML 浏览器呈现；已浏览预览页沿普通通知持久化，凭据及 CLI 错误原文不进入通知。分享是显式上传行为，Secret Gist 持链接者可访问，不等同于私有访问控制。

### 2026-09-21 OAuth 与非持久化授权展示（3577cb0）

- 基线 `772db6f`；接入原生 API key/OAuth 登录方式选择、浏览器链接、设备码、信息/进度通知、账户选项与回调。增加受鉴权/Session 归属保护的 auth-displays no-store 接口，worker/main/mobile 仅内存保存展示内容；IPC 禁止溢出到 spool。全部回答沿 sensitive input/HMAC 幂等，独立登录控制可取消，结束/退出/重启清除。手机仅前台刷新，后台/卸载/错误清空并抑制迟到响应。无 SQL migration，也不增加公网回调或 relay。
- 环境：WSL 2 Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。本地合成 OAuth 扩展产生随机授权材料；未使用真实账号或模型凭据。首轮真实进程 0/4（`test-results/oauth-process.log`）查出 IPC 类型清单漏登记，已修复并补编解码回归；合成 provider 同时支持两种方式，测试改为明确选择 OAuth，未删减断言。
- 已验证：构建/类型检查（`oauth-build.log`、`oauth-types.log`）；最终真实进程 4/4（`oauth-process-final.log`），覆盖账户选项、设备码、手动回调、原生凭据保存、整个临时目录秘密材料检查、取消/失效旧回答、服务重启，以及 API key 回归。最终定向 47/47（`oauth-targeted-final.log`）：IPC、API 鉴权/no-store、跨 owner、手机后台/迟到响应和 provider 独立取消/迟到通知。完整阶段检查结果见下。
- 未运行：真实 OAuth provider 浏览器/网络回调、真实 TUI 对照、Android/iOS 安装包及设备。仅支持原生 SDK 已提供的回调/手动输入路径；依赖服务器本机回调且无手动回退的 provider 仍须实际条件验证。合成进程与 JS 构建不能作为这些验收的替代。
- `pnpm verify:S07`：14 passed / 2 failed（`test-results/oauth-s07.log`、`s07/report.json`）；构建、命令、真实表单/会话进程、lint、完整 typecheck、文档全部通过。失败仍为 live-commands / parity-tui-commands 的已有报告源码身份过期，本次未将它们改写为通过。
- `pnpm verify:S10`：手机 contract、Android/iOS JS export、lint、完整 typecheck 和文档全部 passed；Android/iOS device 为 not_run，阶段状态 blocked（`test-results/oauth-s10.log`、`s10/report.json`）。最终 UI 的账户选择仅提供选项按钮，回调文本仍用遮罩输入；没有将 JS 包构建等同于设备验收。

### 2026-09-21 API key 登录与秘密回答（772db6f）

- 基线 `725896b`；接入 `/login [provider]` 原生 API key 方法、configure Operation、敏感 input、服务器脱敏/HMAC 幂等、手机遮罩和清空/仅存请求标识，以及原生默认模型与目录刷新。无需 SQL migration；协议 JSON 字段和 reducer/快照验证同步修改。OAuth 浏览器/设备码/回调与鉴权富文本通知仍未适配。
- 环境：WSL 2 Linux、Node 24.19.0、pnpm 10.28.0、SDK 0.85.1；临时合成密钥和本地 HTTP provider，无真实模型调用。首轮 `login-process.log` 0/2，实际查出 interactions.payload_json 丢失 sensitive 标记导致 commands 泄漏；已修复持久元数据并保留失败证据。最初 build 的登录回调类型错误已修复。
- 已运行：`pnpm build:server` 成功（`test-results/login-build-final.log`）；协议/手机缓存/SDK/指纹文件定向 25/25（`login-targeted-final.log`）；原生备份恢复 3/3（`login-backup.log`）。最终服务器构建及真实进程登录 2/2（`login-server-final.log`、`login-process-release.log`），覆盖原生保存、整个临时目录除 auth.json 外无秘密值、取消/存储失败、幂等冲突和服务重启回执。指纹文件放在 pi 目录以纳入现有备份，恢复后值保持一致。
- `pnpm verify:S07`：13 passed / 3 failed（`test-results/login-s07.log`、`s07/report.json`）；构建、命令 contract、真实表单/会话进程、lint、文档均通过。失败项为新增测试的类型导入路径以及已有 live-commands / parity-tui-commands 报告源码身份过期；类型导入已修复，后续最终检查结果另记，不改写该失败报告。
- 最终鉴权菜单/异常测试 6/6（`login-selector-final.log`），测试类型检查通过（`login-test-types-final.log`）。`pnpm verify:S10` 的手机 contract、Android/iOS JS export、lint、完整 typecheck、文档均 passed；Android/iOS device 为 not_run，阶段状态 blocked（`login-s10.log`、`s10/report.json`）。完整类型检查已覆盖并确认 S07 中的导入错误修复。未重跑无新修改的完整进程集；最终目录配置的登录/重启路径已单独重跑通过。
- 未覆盖：真实 provider 凭据有效性、原生交互 TUI 对照、Android/iOS 键盘/后台及设备使用；JS/合成或真实本地进程测试均不能代替这些验收。

## 当前状态

S01–S12 已有实际工程实现。S01 的干净 Linux checkout 验证通过；S02 的真实 SDK contract、DeepSeek 工具调用和单模型 thinking 已通过，但第二模型、完整异常/长任务、原生 TUI 和完整 parity 仍未完成，因此保持 `blocked`；S03 的公共 schema、S04 的 SQLite 存储 contract 及 S05 的鉴权 / 资源 API 均已通过验证。S06 的 worker、调度与恢复已实现，但原生 TUI / live provider 对照仍待真实条件；S07 的命令控制与全阶段交互桥接已实现并完成可重复契约测试，真实 provider / 原生 TUI 对照仍待外部条件，因此保持 `blocked`。S08 的 WSS / HTTPS 回放、S09 的移动端本地验证和 S10 的移动端实时/执行页面合同验证已完成；S11 的双设备和弱网合同测试已完成；2026-09-15 另补实际 server / worker 进程故障集成测试；S12 的 Docker 交付也已通过完整 WSL 生命周期验证。S13 的发布就绪检查入口已补齐，真实 provider 已有部分通过证据，但完整模型矩阵、原生 TUI 和 Android / iOS 实机仍未完成，因此保持 `blocked`。参考 SQL 和尚未接入的示例事件不代表已经部署的业务功能。

已完成一轮[独立设计评审与修订](reviews/2026-09-12-design-review.md)：当时的 7 项发现已修订；后续用户要求已替换其中的预先限制，历史审核结论不能代替当前版本的验证。

随后增加 [Bash 兼容约束](bash-compatibility.md)，本轮再扩展为[整体 TUI 体验原则](tui-experience.md)：覆盖工具、资源、扩展、控制、会话和全阶段交互，只有实际问题或用户配置才增加局部限制。当前共 FR01–FR14、AT01–AT32 及两套各 8 项对照场景；S07 已进入实现完成、真实对照阻塞状态。

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| S01 | passed | Linux 冻结安装、lint、typecheck、单测、构建、Android / iOS JS bundle、healthz |
| S02 | blocked | SDK contract、DeepSeek 真实工具与单模型 thinking 通过；第二个不同模型、异常/长任务和范围内原生行为基线待验收 |
| S03 | passed | 公共 DTO/schema、正常/异常/无 Run/native fixture reducer 与序号边界测试 |
| S04 | passed | SQLite 迁移、事件事务、live projection、快照和历史分页 |
| S05 | passed | 鉴权、项目和会话 API |
| S06 | blocked | worker、调度与恢复合同测试通过；范围内 live provider 生命周期对照尚未完整运行 |
| S07 | blocked | 合同及 DeepSeek 基础命令、stop/steer/follow-up、compact 队列、生成前及受控摘要流取消子集通过；完整 compact/交互矩阵待验收 |
| S08 | blocked | 合同及 DeepSeek 真实流/工具、断线继续与持久事件回放子集通过；完整实时矩阵及原生对照待验收 |
| S09 | blocked | 移动端配对、资源列表、归档、历史与本地缓存实现；真实 Android / iOS 设备未运行 |
| S10 | blocked | 移动端实时、时间线、命令与表单已实现；真实 Android / iOS 流程未运行 |
| S11 | blocked | 双设备/弱网合同与实际 server/worker 进程故障集成通过；真实 Android / iOS 设备未运行 |
| S12 | blocked | Docker 部署生命周期子集已有通过证据；当前源码的干净 Compose、升级、备份恢复及范围内 Bash/行为复验待完成 |
| S13 | blocked | 发布检查已实现，真实 provider 已有部分证据；范围内模型矩阵、部署复验和 Android / iOS 实机仍未完成 |

## 2026-09-21 退出登录与原生凭据状态

基于 `491cdcc`，接通 `/logout` 的原生 OAuthSelectorComponent，按凭据元数据列出 provider、名称/原 ID 和类型，保留搜索、取消与排序。重复打开复用同一菜单，独立 configure Operation 不借用模型 Run；关闭编辑器后旧响应失效。使用原生 ModelRuntime.logout 和 15 秒鉴权操作期限，结合编辑器取消信号，成功后刷新本 worker 模型目录、补全和页脚，不改当前选中模型、不停止活动请求；环境变量、models.json、运行时注入凭据保持原状，其他已加载 worker 不主动广播刷新。

凭据读取/删除错误不把原始异常或 CredentialSynchronizationError 的 credential/cause 写入事件；已删除但本地同步失败有独立提示，不自动重试。空列表明确说明可移除凭据来源。命令清单现为 21 个已接入，login/share 仍待接入；本批无公共协议/schema 变化。核对发现普通 respond 会进入服务端 Command/Interaction 持久化及手机离线待发缓存，因此登录仍需先实现跨端非持久化秘密通道，再接 API key/OAuth；本批不使用普通输入框收集密钥，也不声称完整鉴权节点已完成。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：构建通过（`test-results/logout-build.log`），原生菜单/模型回归 15/15（`logout-targeted.log`），包含临时 auth.json 真实删除与模型可用性变化、保留其他凭据和模型配置、搜索/取消、取消 signal 与错误脱敏。真实服务/worker 定向进程 2/2（`logout-process.log`），覆盖运行中删除、取消/退出失效、空列表、真实存储失败和事件/命令记录无合成密钥。`pnpm verify:S07` 原始结果为 **13 passed / 3 failed**（`test-results/logout-s07.log`、`test-results/s07/report.json`）：构建、命令合同、原生表单、51 项会话进程、全量类型和文档检查通过；失败包括 preserve-caught-error lint 和两份旧 live-commands / parity-tui-commands 源码身份失效报告。鉴权 cause/credential 可能含秘密，因此只对两处公开脱敏异常添加明确的局部 lint 例外，不保留原始 cause；完整 lint 重跑通过（`logout-lint-final.log`），补充 cause/credential 不附带断言后 4/4（`logout-redaction-final.log`）。例外注释未改变运行行为，不重跑整套进程测试，不将原始阶段报告改写为全绿。最终文档和差异格式检查通过，实现提交从本节文件历史追溯。测试仅用临时合成凭据和本地 provider；未读取真实密钥或操作用户鉴权文件，真实 provider/OAuth、TUI 与 Android/iOS 未运行，S07 保持 blocked。

## 2026-09-21 首次信任、原生 hook 与默认回退

基于 `feb8d35`，受管 worker 首次遇到需信任资源的 cwd 时，使用 DefaultResourceLoader 的原生 bootstrap 和 resolveProjectTrusted；先加载用户级扩展，再按 hook → 保存决定 → 全局默认 always/never/ask → 询问的原生顺序决定项目资源加载。支持 remember、父目录、仅本次与取消；错误 hook 通知后沿原生回退，不把取消变成停止对话或 Bash。按原生 CLI 保留宿主内 cwd 决定缓存，new/fork/resume/import 和 `/reload` 不重复询问已决定的目录，worker 重启重新决策。这修正上一批“每次新 runtime 都读保存决定”的行为；菜单保存仍明确提示重启。注入 SettingsManager/ResourceLoader 或不提供信任 UI 的底层调用保留原有自定义路径。

信任 hook 的 select/confirm/input/notify 可以早于 SDK handle 及 native mapping，沿 initialize 或触发替换的现有 Operation 持久化。respond 以活动待答 interactionId/operationId 为边界，不再要求 SDK handle 已创建；模型/配置命令的 ready 条件不变。初始化 Operation 在 factory 前分配，防止重复初始化；完整信任说明存 message，标题维持既有长度规则。已有初始化表单进度与心跳覆盖长等待、重连、重复响应。无公共字段或数据库迁移，已同步协议、数据、原生契约和验收说明。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：构建通过（`test-results/trust-startup-build.log`）；原生 bootstrap、信任菜单、runtime 与历史回归 72/72（`trust-startup-targeted.log`），包含映射为空时等待超过 15 秒仍可答、随后 session_start 表单仍可答。真实 server/worker 定向进程 3/3（`trust-startup-process.log`），覆盖映射前重连/幂等、全局 hook 表单与记住决定、取消后项目上下文不进入请求且对话可继续。最终 `pnpm verify:S07` 为 **14 passed / 2 failed**（`test-results/trust-startup-s07.log`、`test-results/s07/report.json`）：构建、命令合同、原生表单、49 项会话进程、lint、全量类型和文档检查通过；两项失败仍为旧 live-commands / parity-tui-commands 报告源码身份失效。最终文档和差异格式检查通过，实现提交可从本节文件历史追溯。测试仅使用临时目录及本地合成 provider，未读取密钥或调用付费模型；真实 provider、原生 TUI、Android/iOS 尚未验收，S07 保持 blocked。

## 2026-09-21 项目信任菜单与持久决定

基于 `a7edfd3`，接入固定 SDK TrustSelectorComponent / ProjectTrustStore 的 `/trust` 菜单，保留当前目录、父目录与继承语义，使用原生锁定读/合并/写入。重复打开复用菜单，独立 configure Operation 不借用活动 Run；关闭编辑器后旧响应失效，写入错误导致 Operation 失败并恢复提交草稿。保存成功明确提示新 runtime 生效，不自行停止任务或重启 worker。命令清单现在 20 个已接入、login/logout/share 3 个仍待接入，完整第 1 大节点未完成。

首轮测试发现固定 SDK 的服务工厂不会读取 trust.json，默认初始化为 trusted；修复受管 runtime 创建的 SettingsManager 初始化，读取明确保存的目录/祖先决定。新建、恢复、导入等新 runtime 共用该路径；当前 runtime 及 `/reload` 保留原状态，注入 SettingsManager 的调用者保留自身决定，没有需信任资源时遵循原生可信语义。首次启动 ask、project_trust hook 与默认信任回退完整流程仍待适配；无保存决定时保持现有行为，不以本次保存入口代替完整信任适配。无公共协议字段、schema 或迁移变化。

环境 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。首轮构建通过（`test-results/trust-build.log`），定向 4/6（`trust-unit.log`）：父目录选择的 null 更新实际删除当前目录键，已按 SDK 语义修正断言；新 runtime 未读取保存决定的问题修复如上。第二轮构建通过（`trust-build-final.log`），菜单与 runtime/历史回归 68/68（`trust-unit-final.log`），真实服务/worker 定向进程 2/2（`trust-process-focus.log`），覆盖运行中保存、取消不落盘、重复菜单、父目录继承、退出失效与真实文件写入失败。补充项目配置实际加载断言后 3/3（`trust-config-regression.log`）。最终 `pnpm verify:S07` 为 **14 passed / 2 failed**（`test-results/trust-s07.log`、`test-results/s07/report.json`）：构建、命令合同、原生表单、46 项会话进程、lint、全量类型和文档检查通过；两项失败为旧 live-commands / parity-tui-commands 报告源码身份失效。最终文档和差异格式检查通过，实现提交可从本节文件历史追溯。未读取密钥或调用付费模型；真实 provider、原生 TUI、Android/iOS 未运行，S07 保持 blocked。

## 2026-09-21 会话导入、克隆与资源重载批次

基于 `e92f05b`，接入 `/clone` 的原生 fork(leafId, position=at)，目标映射 ACK 后清草稿，不产生新模型请求。`/import` 先确认，完整校验 JSONL 与 cwd，再经独立 import 意图、原生复制、目标 ID/cwd 二次校验、映射 ACK 接通新上下文。同项目已映射原生 ID 复用应用 Session 并更新文件路径，保留原输入/旧副本；目标占用和 owner 校验沿现有映射规则执行。补同步目标原生标题，事件不借用源 Operation。内部 IPC 增加 import 种类，公共协议/schema 无字段新增、无数据库迁移；同步协议、数据模型、计划和验收矩阵。

`/reload` 按原生非 streaming/compacting 条件执行，按 Session 清理旧控件、终端监听、页脚/widget/status 和包装补全；shutdown hook 可以正常请求表单，session_start 前再清理 shutdown hook 安装的旧 UI，然后安装新默认编辑器/键位，让新扩展重建 UI。新 hook 表单保持可回答，失败不复用旧扩展工厂，资源/model 配置错误可见。草稿使用当时实际值，不覆盖重载期间的新输入。原生资源重载不代表尚未适配的主题/终端像素设置已经生效。

发现并明确保留一个局部缺口：固定 SDK import 的 cwdOverride 不写回 JSONL header，后续持久恢复会因 cwd 不一致失败；当前拒绝缺失目录的导入，提示恢复目录，保留源会话与文件。新增直接 SDK 复现测试证明该差异；后续仍需显式选择目录、导入副本的持久目录修订和崩溃恢复，不能声称缺失目录迁移已支持。当前命令清单为 19 个已接入、trust/login/logout/share 4 个流程待接入；完整第 1 大节点仍有剩余事项。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：构建通过（`test-results/session-tools-build.log`、`session-tools-build-final.log`）。首轮进程 42/44（`session-tools-sessions.log`）：导入 IPC 白名单漏加 import，重载测试使用了 SDK 不自动发现的 .mjs 后缀；分别补齐校验和改为 SDK 支持的 .js 后缀，未放宽断言。随后全量会话进程 44/44（`session-tools-sessions-debug.log`），定向四场景 4/4（`session-tools-focus.log`）。初次定向 85/85（`session-tools-targeted.log`），增加 IPC/导入检查后 86/86（`session-tools-targeted-final.log`），lint 通过（`session-tools-lint.log`）。补充同 ID 重复导入、旧页脚清理与直接 SDK cwdOverride 复现，以最终阶段验证记录为准。

首次阶段验证为 13 passed / 3 failed（`session-tools-s07.log`、`session-tools-s07-initial-report.json`），其中会话进程 43/44：新增重复导入同 ID 的断言暴露存储层仍禁止 persisted 路径更新；定向复现为 3/4（`session-tools-focus-boundaries.log`）。增加只用于已验证导入的旧路径/同 ID CAS 更新，常规 setPiMapping 仍拒绝更换 persisted 路径；正常更新、错误 ID 与过期旧路径保护的存储测试 7/7（`session-tools-storage.log`）。直接 SDK cwdOverride 与历史回归 29/29（`session-tools-cwd-regression.log`）。保留所有初始失败。最终 `pnpm verify:S07` 为 **14 passed / 2 failed**（`test-results/session-tools-s07-final.log`、`test-results/s07/report.json`）：构建、命令合同、原生表单、44 项会话进程、lint、全量类型与文档检查通过；两项失败为旧 live-commands / parity-tui-commands 报告源码身份失效。最终文档和差异格式检查通过。本批基于 `e92f05b`，实现提交可从本节文件历史追溯。未读取密钥或调用付费 provider；真实模型、原生 TUI、Android/iOS、完整导入故障矩阵未运行，S07 保持 blocked。

## 2026-09-21 内置命令与远程退出交付节点

基于 `f235cf5`，新增 `/session`、`/name`、`/copy`、`/export`、`/changelog`、`/hotkeys`、`/compact` 与 `/quit` 编辑器入口，并接通原生复制键、空草稿退出键、双 Ctrl+C 和历史选择器退出。统计直接取 SDK 全会话用量、模型费用分组和缓存重复计费；信息使用可翻页文本窗口。导出保留原生 HTML/JSONL 与引号路径解析，文件留在服务端，不自动上传。复制使用手机文本框，不声称写入服务器剪贴板；超长回复明确提示文本框上限及完整导出方式。手动压缩直接走 SDK，不套用 stop 清队列或自动重试。

退出只关闭当前远程编辑器和待答子菜单，保留草稿与后台任务，不调用 worker/service shutdown，也不伪造原生 shutdown hook。非空 Ctrl+D 保持向前删除，扩展自定义处理优先。挂起/恢复仍明确提示待适配，不发送 SIGTSTP。只读/复制窗口按类型复用，导出/改名/压缩不合并不同提交。失败草稿与 Operation 沿现有归属边界处理，旧响应失效。无协议/schema 变化。

新增[命令与快捷键状态表](editor-command-status.md)，覆盖固定 SDK 的 23 个命令：16 个已接入（部分设置仍待适配），7 个流程仍待实现。import/clone/reload/trust/login/logout/share 分别列出具体适配步骤，运行时保留文本并给出相应说明，不再用不存在的手机入口搪塞。app.message.followUp/dequeue、外部编辑器、图片粘贴、思考显示与挂起热键仍未接入；本次是大节点中的可交付命令批次，不将能力清单完整等同于全部流程实现。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：构建通过（`test-results/editor-commands-build.log`、`editor-commands-build-final.log`），定向 editor/custom/worker/runtime 回归 66/66（`editor-commands-targeted.log`），lint 通过（`editor-commands-lint.log`）。首轮真实会话进程 39/40（`editor-commands-sessions.log`）：退出测试的清理误用不存在的 stop Command，协议要求 abort；已修正测试，未更改退出行为或放宽断言。该轮信息、标题同步、复制、双格式导出、导出失败保留草稿、待接入流程说明、压缩落盘及空历史失败均由本地合成 provider/真实服务进程验证；退出三种路径的运行中断言均完成，失败发生在末尾清理。随后补齐历史选择器远程退出和动作提交不合并边界，以最终 S07 重建验证为准。

最终 `pnpm verify:S07` 为 **14 passed / 2 failed**（`test-results/editor-commands-s07.log`、`test-results/s07/report.json`）：构建、命令合同、五类生命周期表单、40 项会话进程、lint、全量类型检查和文档检查通过；失败仍为旧 live-commands / parity-tui-commands 报告源码身份失效。最终文档及差异格式检查通过。未读取模型凭据、未调用付费 provider，未运行真实 TUI、Android/iOS 实机及双端 JS 构建；S07 仍保留外部验收阻塞。下一批继续会话导入/克隆及资源重载的完整映射和 UI 生命周期，不以清单代替实现。

## 2026-09-21 原生模型范围菜单

基于 `f206a97`，接入 `/scoped-models` 的固定 SDK ScopedModelsSelectorComponent，保留搜索、启停、provider 批量选择、排序、全选/清空与显式保存。选择即时更新 Session.scopedModels 及扩展页脚 provider 数量，关闭不撤销；只有保存键才写 enabledModels，等待 flush 并检查 drainErrors。全部、空列表或仅失效条目沿原生语义解除运行时范围限制，单个可用范围模型不强制轮换当前模型。未匹配配置条目继续可见并参与保存，目录刷新沿原生共享取消订阅和 15 秒超时，不能覆盖用户已改选择。独立 configure Operation 不借用正在运行的 Run，编辑器结束/会话替换后旧菜单失效；没有新增协议、schema、执行限制或付费调用。

环境为 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。构建通过（`test-results/scoped-models-build.log`）。首轮会话进程 35/36（`scoped-models-sessions.log`）：新增测试错误预期单模型范围会强制切换模型，核对 SDK 后改为断言原生不切换，再显式选择并验证轮换范围。首轮定向 71 项通过但新增 suite 加载失败（`scoped-models-targeted.log`、`scoped-models-unit.log`），原因是 SDK 不提供 CommonJS exports；测试改为动态导入。随后新增 3/4（`scoped-models-unit-final.log`），取消断言早于共享刷新订阅的异步清理，改为等待一个事件循环后检查实际 signal，4/4 通过（`scoped-models-unit-verified.log`）。补充页脚同步和原生排序键断言后仍为 4/4（`scoped-models-surface-unit.log`）；完整 lint 通过（`scoped-models-lint.log`）。保留初始失败证据，不削弱断言或更改原生轮换行为。

首轮 `pnpm verify:S07` 为 14 passed / 2 failed（`scoped-models-s07.log`、`scoped-models-s07-initial-report.json`），36 项会话进程通过；运行期间补充页脚同步，故未将该报告作为最终产品证据。固定产品与测试后重新运行 `pnpm verify:S07`，最终仍为 **14 passed / 2 failed**（`scoped-models-s07-final.log`、`s07/report.json`）：构建、命令合同、五类生命周期表单、37 项会话进程、lint、全量类型和文档检查均通过。新增进程测试覆盖不保存/显式保存/清空/全选、原生单模型轮换语义、关闭编辑器后旧表单拒绝、正在生成时修改范围、实际写入失败通知及 configure Operation 失败终态，模型请求不被重启。两项失败为旧 live-commands / parity-tui-commands 源码身份失效。最终文档检查与 git diff --check 通过；真实 provider、交互式 TUI、Android/iOS 实机未运行，测试只用临时项目和本地合成 provider，未读取模型凭据，未重跑双端 JS 构建。S07 仍保持 blocked。下一步继续 `/session` 等尚未接入的内置菜单和显示/启动设置，完整发布验收仍需外部真实条件。

## 2026-09-21 原生设置菜单与即时生效路径

基于 `755513a`，接入 `/settings` 的原生 SettingsSelectorComponent、SettingsList 搜索/值循环和模型思考覆盖子菜单。支持自动压缩、steer/follow-up 模式、传输/HTTP idle timeout、模型思考覆盖增删、图片自动缩放/模型图片阻断、skill 命令、默认项目信任、双 Esc/树过滤，以及编辑器 padding/补全条数。SDK runtime setter 与设置保存同时执行；编辑器更新不替换组件、不清草稿，缺少可选 setter 的自定义编辑器沿原生行为保留自身布局。默认项目信任只改变原生后续回退决策。没有新协议字段、schema 或默认执行限制。

尚未接入显示/启动生效路径的主题、全屏、图片显示、思考块隐藏、聊天重绘/布局、警告等可见项标为“待适配”，选择时明确提示配置未修改。图片显示/宽度项是否出现仍由原生终端图片能力决定；模型图片处理设置没有默认禁用。菜单使用独立 configure Operation，重复打开不叠加、旧编辑器输入失效；异步 flush 后检查 SettingsManager.drainErrors，保存失败通知并将操作记失败。关闭不撤销已更改设置，写入失败不伪装成持久成功；模型 thinking hook 沿现有独立生命周期处理。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：首轮构建因菜单 done 回调参数类型失败（`test-results/settings-menu-build.log`），改用显式 undefined 后构建通过（`settings-menu-build-final.log`）。首轮进程 32/33（`settings-menu-sessions.log`）：测试选了当前文本终端不显示的 Show images 项，持续 HTTP 等待触发限流；改为实际存在的 Hide thinking 项并读取持久事件，不放宽产品限流或断言。第二轮 34/35（`settings-menu-sessions-final.log`）：新增覆盖子菜单测试使用了未定义的 Down/Up 响应值，已改为协议提供的箭头。保存/显示项拒绝和实际文件写入失败验证均通过。定向回归 71/71（`settings-menu-targeted.log`），新增布局/补全即时更新、保留草稿且不重建组件验证。本轮 `pnpm verify:S07` 原始结果为 13 passed / 3 failed（`settings-menu-s07.log`、`s07/report.json`）：构建、命令合同、五类生命周期表单、35 项会话进程、全量类型检查及文档通过；失败是 selector 的 prefer-const lint 及旧 live-commands / parity-tui-commands 源码身份失效。变量改为 const 后完整 lint 和 agent-pi 类型检查均通过（`settings-menu-lint-final.log`、`settings-menu-types-final.log`），不改产品行为或测试断言，保留阶段原始失败报告。新增进程证据覆盖保存后双 Esc 立即生效、编辑器草稿保留、未适配项/子菜单不写配置、重连画面、旧响应拒绝、运行中模型思考覆盖增删，以及实际文件写入失败不声称保存成功。最终文档和差异格式检查通过；S07 保持 blocked，不将菜单子集记为完整阶段通过。

未读取模型凭据或调用付费 provider；测试只用临时项目和本地合成模型。完整真实 provider/传输/图片/信任矩阵、交互式 TUI、Android/iOS 实机均未验收，双端 JS 构建未重跑。菜单明确标出的显示/启动项、共享焦点、聊天重绘、`/scoped-models` 和退出/挂起仍待实现；设置菜单已接通的子集不代表完整 TUI 能力通过。

## 2026-09-21 原生思考等级菜单

基于 `ff00191`，接入固定 SDK ThinkingSelectorComponent 和 `/thinking` / `/thinking 等级`。菜单保留当前/默认标记、搜索、原生选择与保存键、取消，默认等级来自 SDK 常量与 SettingsManager；直接命令忽略大小写精确匹配当前可用等级，无效等级显示可用列表，不作为 prompt 提交。普通选择 persist=false，保存默认值才更新设置并等待 flush。模型在菜单打开后改变时，最终 setThinkingLevel 仍沿 SDK 能力处理，通知与手机配置反映实际有效等级。

菜单使用独立 configure Operation，重复打开不叠加；编辑器结束或替换会关闭菜单并使旧响应失效。thinking_level_select 保持原生 fire-and-forget，复用既有 controlOperations 与迟到回调归属处理，不借用正在执行的 Run，也不重复发布 thinking_level_changed 已产生的配置变更。本轮未改协议、schema、手机代码或 SDK 版本。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：生产构建通过（`test-results/thinking-menu-build.log`），定向 model/editor/custom/terminal/worker/runtime 回归 70/70（`thinking-menu-targeted.log`）。首次真实会话进程 32/32（`thinking-menu-sessions.log`）。最终 `pnpm verify:S07` 为 14 passed / 2 failed（`thinking-menu-s07.log`、`s07/report.json`）：构建、命令合同、五类生命周期表单、32 项会话进程、lint、全量 typecheck 和文档通过；失败仍是旧 live-commands / parity-tui-commands 源码身份失效。新增用例验证不支持/未知等级、大小写引用、菜单搜索及普通选择、重映射保存默认键、运行中取消保护草稿、异步 hook 归属、编辑器关闭使旧输入失效，以及菜单打开后模型变化仍由 SDK 限定等级；没有额外模型 prompt。最终文档与差异格式检查通过，S07 保持 blocked，不将本地验证记为完整阶段通过。

未读取模型凭据或调用付费 provider；新增测试仅使用临时目录、本地合成模型和真实 SDK/server/worker。真实模型等级矩阵、原生 TUI 与设备验收未运行，双端 JS 构建未重跑。`/settings` 涉及多项持久设置和终端/聊天布局即时应用，需逐项接通真实生效路径；它与 `/scoped-models`、退出/挂起、共享焦点、聊天重绘仍待适配，不能把思考菜单子集称为完整 TUI 通过。

## 2026-09-21 空草稿双 Esc 与模型命令入口

基于 `33e215d`，在原生 CustomEditor 的 app.interrupt 回退中加入空白草稿双 Esc：遵循 SDK 小于 500ms 的窗口和 doubleEscapeAction（默认 tree，可设 fork/none），成功打开后重置计时。补全、自定义 onEscape、扩展快捷键、摘要/压缩/重试取消、停止模型/Bash 和清理 Bash 草稿仍优先；普通停止不计为空闲 Esc。继续使用现有会话菜单去重和编辑器生命周期，不添加默认键位或新 Run。

`/model` 和 `/model 引用` 进入同一 configure Operation。精确匹配直接调用固定 SDK findExactModelReferenceMatch，遵循作用域、provider/id、大小写和歧义；无作用域且缓存未命中时使用原生共享 refreshModelCatalogs，保留 15 秒超时、失败提示与缓存回退，再无匹配则打开带原搜索词的 ModelSelectorComponent。编辑器关闭取消其刷新订阅，不取消其他订阅；确认后的 model_select hook 仍完整等待。普通选择/精确引用 persist=false，不写全局默认值，slash 文本不发给模型。没有公共 schema 或手机代码变更。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：首次构建通过（`test-results/menu-entry-build.log`）；真实会话进程 30/30（`menu-entry-sessions.log`），验证 tree/fork/none、非空稿与停止优先、窗口超时/重置、模型引用/模糊搜索/无结果、运行中 hook 归属与默认配置不变。定向回归 70/70（`menu-entry-targeted.log`），包含新增四项引用歧义、作用域、刷新结果/失败、共享订阅取消和超时释放测试。本轮 `pnpm verify:S07` 原始结果为 12 passed / 4 failed（`menu-entry-s07.log`、`s07/report.json`）：构建、命令合同、五类生命周期表单、30 项会话进程及文档通过。除旧 live-commands / parity-tui-commands 源码身份失效外，新增测试还有未使用参数 lint 和只读 scopedModels 数组 push 的类型错误。已将 mock 改为类型签名、在夹具内部维护可变数组，不改变产品代码或测试断言。保留阶段原始失败报告；最终 lint、测试全量类型检查及受影响四项测试均通过（`menu-entry-lint-final2.log`、`menu-entry-test-types-final.log`、`menu-entry-model-final2.log`）。生产包/服务端/手机类型检查已在阶段运行中通过，无需重跑未变的构建及进程用例。最终文档与差异格式检查通过；S07 保持 blocked，未将补充证据改写为整阶段通过。

未读取模型凭据或调用付费 provider；进程测试仅使用临时项目与本地合成模型接口。真实 provider 目录、交互式 TUI、设备按键/网络时序仍未验收，双端 JS 构建未重跑。其他内置菜单（thinking/settings/scoped-models 等）、终端退出/挂起、共享焦点和原生聊天重绘仍待适配，不把本轮入口补齐记为完整 TUI 或设备通过。

## 2026-09-20 原生会话树与分支摘要

基于 `059dcc4`，接入固定 SDK TreeSelectorComponent 及 `/tree` / app.session.tree，和恢复/分叉共用菜单生命周期。保留原生搜索、过滤、折叠、标签写入、当前叶节点无操作及 treeFilterMode 设置。复制键使用既有手机 editor 表单呈现文本，不写宿主剪贴板或覆盖对话草稿；超过既有 32768 字符显示配额时明确提示截断。

无 Run 的独立 extension Operation 调用原生 AgentSession.navigateTree。摘要选项遵循 branchSummary.skipPrompt；取消选项回树、取消自定义指令回选项。用户确认后才取回 SDK steer/followUp 队列，持久每条 Input 的 returned/unknown 状态，再停止活动响应。摘要使用独立取消表单和编辑器 Esc 调用 abortBranchSummary，取消后回到原选中节点；原生 before-tree/session-tree hook 及异步表单保留。已有草稿不被返回的用户文本覆盖，恢复文本不自动重发，编辑器关闭不自动撤销已开始的导航。

模型上下文切换到选中路径，原生所有历史及手机事件记录保留；菜单明确说明这一差异，不伪造原生聊天重绘。无摘要导航按 SDK 只改内存 leaf，后续追加才固定分支；摘要生成原生 branch_summary，不新增协议字段或 SQLite schema。

验证环境为 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。首次构建通过（`test-results/tree-menu-build.log`），真实会话进程 23/25（`tree-menu-sessions.log`）：失败来自测试向 follow_up 传入不支持的 targetRunId，以及遗漏 SDK 摘要固定说明文字。按实际协议/原生格式修正。第二次构建通过（`tree-menu-build-final.log`），进程 24/25（`tree-menu-sessions-final.log`）：队列测试错误等待服务端 follow_up 待执行命令完成，已改为 prompt.streamingBehavior=followUp，验证实际运行中的 SDK 输入队列。保留原断言与失败日志。定向 worker/editor/custom/terminal/runtime 66/66（`tree-menu-targeted.log`）。最终 `pnpm verify:S07` 为 14 passed / 2 failed（`tree-menu-s07.log`、`s07/report.json`）：构建、命令合同、五类生命周期表单、26 项会话进程、lint、全量 typecheck 和文档均通过；失败仍是旧 live-commands / parity-tui-commands 源码身份失效。新增进程用例验证原生标签/复制、异步 hook 归属及否决、草稿保护、模型上下文分支、队列完整取回和零重发、摘要表单与 Esc 取消、模型错误时历史不变、原生摘要落盘及 skipPrompt 配置。相关过程证据位于 `test-results/code-review/r16-details/`。最终补录后的文档与差异格式检查通过，S07 保持 blocked，不把本地检查改写为整阶段通过。

未读取模型凭据或调用付费 provider，所有新增进程测试使用临时目录与本地合成模型。真实模型/TUI 对照、Android/iOS 实机、附件/超长消息复制、完整过滤/折叠键位矩阵仍未验收；本轮没有手机代码变更，双端 JS 构建未重跑。原生聊天重绘、压缩期间 UI 队列刷新、共享焦点、空草稿双 Esc 菜单及终端退出仍待适配，不将本轮结果记为完整 TUI 或设备通过。

## 2026-09-20 原生用户消息分叉菜单

基于 `34edf22`，接入固定 SDK 的 UserMessageSelectorComponent，完整 `/fork` 和可配置 app.session.fork 进入同一流程。原生消息列表、最新消息初选、上下选择和取消由 SDK 处理；空历史只通知。恢复与分叉共用菜单生命周期，重复打开不叠加，编辑器结束或 Session 替换清理旧输入。菜单使用独立 extension Operation，不创建 Run。

确认使用 extensionRunner.createCommandContext 的已绑定 fork，保留原生 session_before_fork 取消、持久 intent、替换串行及映射 ACK。所选消息之前的路径复制到新会话；withSession 在目标映射确认后恢复所选文本为草稿，不自动提交，也不写回源历史。源/目标操作与手机事件沿既有归属处理；本轮未改公共 schema、手机代码或树导航。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：生产构建通过（`test-results/fork-menu-build.log`）；SDK/editor/custom/terminal/runtime 定向回归 66/66（`fork-menu-targeted.log`）。首次真实进程为 21/22（`fork-menu-sessions.log`）：分叉、目标草稿、历史及零重发断言已通过，测试末尾误查不存在的 operations 表。改为读取持久 operation.updated 事件，保留完成状态断言，并增加原生扩展取消分叉验证。最终 `pnpm verify:S07` 为 14 passed / 2 failed（`fork-menu-s07.log`、`s07/report.json`）：构建、命令合同、五类生命周期表单、22 项会话进程、lint、全量 typecheck 和文档通过；失败仍是旧 live-commands / parity-tui-commands 源码身份失效。分叉过程证据见 `test-results/code-review/r16-details/native-fork-menu-handles-empty-history-cancellation-and-destination-draft-without-resubmission.json`。最终补录后的文档和差异格式检查通过；S07 保持 blocked，不将本地验证标为整阶段通过。

未读取模型凭据或调用付费 provider；测试仅使用临时目录和本地合成模型。真实 provider、交互式 TUI、Android/iOS 实机未运行，双端 JS 构建未重跑。树导航的摘要/取消、共享焦点与终端退出仍待适配；本轮分叉菜单未覆盖活动流中确认分叉、附件消息及完整自定义键位矩阵，不替代这些验收。

## 2026-09-20 原生历史恢复菜单与新建会话

基于 `0c9d6f4`，接入 SessionSelectorComponent：沿 SDK current/all 列表、搜索、排序、命名过滤、路径显示、重命名、删除确认和当前历史保护。app.session.resume/new 沿原生默认保持无键位，可自定义绑定；CustomEditor 的完整 `/resume` 和 `/new` 也进入同一流程，不作为 prompt 发给模型。选择/新建使用 extensionRunner.createCommandContext 的已绑定动作，保留现有持久 intent、历史校验、替换串行和映射 ACK，不另开未经保护的 runtime 路径。菜单是独立 extension Operation，原生退出入口仍明确提示待适配。

当前历史重命名通过 setSessionName 同步手机标题；非当前历史先校验文件/身份再 appendSessionInfo，手机标题在下次加载时同步。删除沿 SDK trash/unlink 与确认行为，只删除原生 JSONL，不删除手机事件记录；这一区别已写入菜单说明。菜单关闭清理状态计时器并停止渲染；会话替换使旧编辑器和菜单失效，源历史保持原内容。缺失/损坏的历史不能因恢复或重命名而静默重建。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：构建通过（`test-results/session-menu-build.log`）。首次真实进程 20/21（`session-menu-sessions-initial.log`），失败是测试假设 Ctrl+U 会清空预填重命名框；实际原生光标在开头，得到 MENU_RENAMEDMENU_SOURCE。按原生编辑行为先移到行尾再删除，原断言保持不变，复验 21/21（`session-menu-sessions-final.log`）。定向 SDK/editor/custom/terminal/runtime 66/66（`session-menu-targeted.log`）。最终 `pnpm verify:S07` 为 14 passed / 2 failed（`session-menu-s07.log`、`s07/report.json`）：构建、命令合同、五类表单、21 项会话进程、lint、全量 typecheck 和文档均通过；包含新增 slash 入口和列表展示后损坏历史的拒绝/保留源会话断言。失败仍是旧 live-commands / parity-tui-commands 源码身份失效。最终文档及差异格式检查通过，S07 保持 blocked，不将本地验证标为整阶段通过。

未读取模型凭据或调用付费 provider。真实 TUI、设备、跨 worker 的原生历史变更及跨项目菜单矩阵未验收；树导航/分叉菜单、共享焦点和终端退出仍待适配。本轮未改协议 schema 或手机代码，双端 JS 构建未重跑；原生历史删除不代表手机事件清除功能已实现。

## 2026-09-20 原生模型选择菜单

基于 `93cf24e`，Ctrl+L / app.model.select 接入固定 SDK 的 ModelSelectorComponent；内部模块加载集中在 agent-pi，新模块不向公共协议暴露 SDK 对象。直接保留原生搜索、后台目录刷新、空结果、上下选择、作用域 Tab、取消及保存默认键，菜单使用既有固定文本主题与该 worker 的原生 TUI keybindings。菜单沿 custom.render/select/input 持久表单提供控制和回放，重复打开不创建第二个菜单。

菜单占独立 configure Operation，不阻塞编辑器或活动 Run；选中后先关闭菜单表面，再在同一操作执行 setModel，model_select 表单仍可回答。普通选择 persist=false；原生保存默认键 persist=true，并等待 SettingsManager.flush。取消保留当前模型、草稿和执行状态；编辑器结束、替换或原生 Session 替换会中止尚未选择的菜单，旧响应拒绝处理。已选择并进入 SDK hook 的配置不因编辑器关闭而撤销。没有修改公共事件、schema 或手机代码。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：首轮生产构建与真实会话进程 20/20 通过（`test-results/model-menu-build.log`、`model-menu-sessions.log`）。新增用例验证运行中搜索、空结果、取消不停止模型/不清草稿、重复打开、重连画面回放、选择后的同 Operation 扩展表单、默认值只在显式保存时修改、自定义保存键、编辑器关闭及 Session 替换清理旧菜单。内部方法命名整理后的定向 SDK/editor/custom/terminal/runtime 回归 66/66（`model-menu-targeted.log`）。最终 `pnpm verify:S07` 为 14 passed / 2 failed（`model-menu-s07.log`、`s07/report.json`）：构建、命令合同、五类表单及 20 项真实会话进程、lint、全量 typecheck、文档均通过；失败仍为旧 live-commands / parity-tui-commands 源码身份失效。最终文档及差异格式检查通过，S07 保持 blocked，不把本地结果改写为整阶段通过。

当前菜单和编辑器仍是独立虚拟表面，不宣称原生终端共享焦点；`/model` slash 解析、其他会话菜单、思考块显示和退出生命周期仍待适配。未读取本地模型凭据或调用付费模型，未运行真实 provider 目录刷新/作用域矩阵、交互式 TUI 或手机实机；合成模型进程测试不能替代这些验收，双端 JS 构建未重跑。

## 2026-09-20 编辑器模型与思考等级循环

基于 `b233dc7`，接入 app.model.cycleForward/cycleBackward 与 app.thinking.cycle，直接使用固定 SDK 的 cycleModel/cycleThinkingLevel，不另写模型顺序或思考等级列表、不加空闲门槛。原生匹配保留默认 Linux Ctrl+P / Ctrl+Shift+P / Shift+Tab、用户 keybindings 和显式历史键优先级。只更新当前会话，persist 保持原生默认 false；已有全局配置不变。单模型或不支持思考等级时显示原因通知。

每个按键配置动作创建独立 configure Operation，清除安装编辑器的命令因果，不新建 Run。model_select 被 await，延迟多表单期间保持同一配置 Operation；thinking_level_select 返回后仍可在子 Operation 继续。循环模型的 hook 若替换 Session，不将目标配置发布到源 Session。

首次真实会话进程为 17/18（`test-results/cycle-sessions-initial.log`），新增运行中思考 hook 的迟到表单错误借用了模型 Run。用既有 R10 测试增加 streaming 分支再次复现：SDK 回归 13/14，空闲通过、运行中失败（`cycle-late-hook-initial.log`）。修复 operationContext：已有但已关闭的 AsyncLocalStorage 来源返回空上下文，由请求路径创建保留原父操作的子 Operation，不回退到另一个活动 Run。未削弱断言。修复后的 SDK/editor/runtime 定向回归 53/53（`cycle-targeted.log`），运行中与空闲分支均通过。

验证环境为 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。最终 `pnpm verify:S07` 为 14 passed / 2 failed（`test-results/cycle-s07.log`、`s07/report.json`）：构建、命令合同、5 类生命周期表单和 19 项真实会话进程、lint、全量 typecheck、文档通过；失败仍为旧 live-commands / parity-tui-commands 源码身份失效。新增进程用例验证双向循环、能力约束、运行中切换、hook 表单回答/取消与延迟归属、幂等按键、会话 JSONL/手机配置一致、全局默认值不变、单模型提示、键位重映射及历史键优先。最终文档与差异格式检查通过，S07 保持 blocked，不改写为整体通过。

测试只使用临时目录与本地合成模型接口，未读取模型凭据或调用付费 provider，不代表两个真实 provider 的切换验收。交互式 TUI、手机实机和模型作用域实测仍未运行；未修改手机或协议 schema，未重跑双端 JS 构建。下一步仍包括模型选择菜单、会话菜单和退出生命周期。

## 2026-09-20 编辑器默认动作：清草稿、工具展开与停止

基于 `5dd06fb`，在原生 CustomEditor.actionHandlers 绑定默认清草稿、工具展开和中断动作；不自行抢占输入匹配，沿用 SDK 的扩展快捷键、补全和显式历史键优先级及用户 keybindings 配置。已有 onEscape/onCtrlD 保持有效，缺省走原生 actionHandlers 回退；替换或重复安装同一组件后，旧默认动作回调失效，新动作正常。回调异常通知原编辑器且不关闭输入循环。

Ctrl+C 清草稿而不停止模型；Ctrl+O 复用持久化工具展开通知，刷新 header/footer，不创建 Run。Esc 首先取消补全；streaming 时先取回 SDK 队列、发布每条完整 Input 的 returned/unknown 状态，再将未消费文本按 steering/followUp/当前草稿顺序恢复到编辑器，最后停止对应 Run，不自动重发。Bash 走 abortBash，压缩/重试走各自 SDK 取消 API，不混用普通 stop 清队列。退出 Ctrl+D 和 500ms 内双 Ctrl+C 明确提示待适配，非空 Ctrl+D 保留原生向前删除；空稿双 Esc 菜单、退出/挂起、其他模型和会话动作仍未完成。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：初次与最终定向 SDK/editor/custom/terminal 回归均 33/33（`test-results/actions-targeted.log`、`actions-targeted-final.log`），覆盖自定义特殊回调、动作覆盖、异步错误和重复安装隔离，既有完整队列/partial 回归通过。首轮 S07 构建发现目标 Run ID 可空，已修复为优先选实际活动 Run；保留 `actions-s07.log` 和 `actions-s07-initial-report.json`，不改写失败。

第二次 `pnpm verify:S07` 为 14 passed / 2 failed（`actions-s07-final.log`、`s07/report.json`）：构建、命令合同、真实生命周期表单/会话、lint、全量 typecheck 和文档通过；两项失败仍为旧 live-commands / parity-tui-commands 证据失效。该轮构建后又简化特殊键处理为原生回退，最终源文件的定向测试及阶段静态检查已通过；随后重新执行 `pnpm build:server` 和 `node scripts/test-real-process-e2e.mjs --no-build --sessions-only`，构建通过、真实会话进程 17/17（`actions-build-final.log`、`actions-sessions-final.log`）。新用例通过 HTTPS 幂等响应操作真实 CustomEditor，验证清草稿不停止、补全 Esc 优先、重复文本队列完整恢复且零重发、Bash 取消、工具展开持久回放及非空 Ctrl+D 删除。保留阶段原始报告与补充证据，不改写为整阶段 passed。

本轮未读取模型凭据或调用付费模型，未执行交互式原生 TUI、压缩/重试热键实际流程或 Android/iOS 真机验收。手机沿用既有表单/通知协议，没有 schema 迁移或手机代码变更；未重跑双端 JS 构建。S07 继续保持 blocked。

## 2026-09-20 终端监听、组合键与扩展快捷键

基于 `ee66346`，接入按 Session 隔离的 TerminalInputHub，将 onTerminalInput 直接绑定到 custom/editor 的原生 TUI，保留注册顺序、消费/改写、组件局部监听相对顺序、晚注册和取消订阅。控件关闭解除绑定；原生会话替换清除旧应用监听，源 custom 控件自身仍可继续完成；worker 退出清理订阅。普通手机草稿同步不伪造终端按键，跨表面共享焦点仍未接入。

CustomEditor 的扩展快捷键使用 SDK getShortcuts / matchesKey / createContext，保留已有 onExtensionShortcut；回调异步执行且异常归属原编辑器，不关闭输入循环。普通 custom 组件不强行插入编辑器快捷键处理。控制表单增加“组合键”，支持 ctrl/alt/shift、字符/导航键及 F1–F12；仍沿两次既有 select/input/respond 消费，不新建协议 kind 或数据库表。无效键名显示错误并返回控制，重复请求不重复按键。

首轮定向测试 `test-results/keys-targeted.log` 为 16/17，失败来自对 shift+f12 可被原生 matcher 识别的假设。查阅固定 0.85.1 的 keys.js 确认 F1–F12 分支在 modifier 非零时直接 false；测试拆分为普通组合键原生匹配与修饰功能键的准确字节/原生不匹配两项，保留限制，不升级 SDK、不用自定义匹配替代原生结论。原始组件/监听器仍可处理这些标准终端字节。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：定向 terminal/editor/custom/runtime 51/51（`keys-targeted-verified.log`），初次真实进程会话 16/16（`keys-sessions.log`）。真实 worker 验证消费阻断、转换后触发快捷键一次、取消订阅、错误保持控件、通知重放、零模型调用；随后补充原生会话替换清除旧监听但保留源 custom 的断言，也经本轮 S07 真实进程通过。

`pnpm verify:S07` 原始结果 13 passed / 3 failed（`keys-s07.log`、`s07/report.json`）：构建、命令合同、真实表单/会话进程、lint 和文档通过；typecheck 中产品包、服务端和手机通过，测试配置按 CommonJS 检查导致新测试的 import.meta 不允许。已改用仓库绝对路径加载 SDK，`pnpm exec tsc -p tsconfig.tests.json`、SDK/editor/custom 19/19 及 `pnpm lint` 复验全部通过（`keys-test-types-final.log`、`keys-sdk-final.log`、`keys-lint-final.log`）。另外两项仍是旧 live-commands / parity-tui-commands 身份失效。保留阶段失败报告；仅测试加载路径修正后未重跑完整进程构建，不改写为整阶段 passed。最终文档与 diff 格式检查通过。

当前完成的是应用输入监听与扩展注册快捷键；默认应用动作（退出/挂起、切模型、会话菜单等）尚未完整绑定，终端菜单、压缩队列对照及真机输入仍未验收。本轮未读取模型凭据或调用付费模型，未重跑 Android/iOS JS 构建，手机继续使用既有表单；真实进程测试不替代 live/TUI/device。

## 2026-09-20 editor 工厂、输入与提交

基于 `887a195`，新增 EditorHost：原工厂 getter、原生 EditorTheme/KeybindingsManager、padding/补全显示配置、原生文件/扩展/template/skill 补全及追加包装器。使用既有 custom.render 与持久 select/input/respond 操作实际组件，草稿 getter/setter、光标粘贴、onChange/onSubmit、替换和取消均留在 worker。安装立即返回，旧组件回调不操作新组件；初始化/输入异常清理组件，恢复默认保留文本。手机相同文本的 editor_state 不重置光标/补全，失败提交按草稿版本恢复，不覆盖用户后来输入或主动清空的内容。

普通提交经 SDK prompt（流式时 steer），扩展 slash 仍即时执行；`!`/`!!` 经原生 user_bash hook/执行器及独立 Bash Operation，可沿手机停止入口控制。用户后续 Run 不绑定安装编辑器的旧 Command。终端专用内置菜单命令明确提示现有手机入口并保留文本，不误投模型；全局快捷键、压缩期间队列、图片粘贴与真机键盘手感仍待适配/对照。会话替换和 worker 退出关闭编辑器控件并重置补全包装器，重启不重发输入。

WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1：定向 SDK/editor/custom/runtime 45/45（`test-results/editor-targeted-verified.log`）。真实 SDK CustomEditor 会话测试 15/15（`editor-sessions-final.log`），覆盖补全、单次模型提交、扩展命令、`!!` 排除上下文、内置菜单保护、光标粘贴和清除旧控件。首轮 `editor-sessions.log` 为 14/15：首个构建尚无相同草稿同步跳过 setText 的修复，光标粘贴等待最终触发 HTTP 429；重新构建后保持光标断言通过，没有调高限流或放宽断言。

`pnpm verify:S07` 为 14 passed / 2 failed（`editor-s07.log`、`s07/report.json`）：构建、合同、真实表单和 15 项会话进程、lint/typecheck/docs 通过，后续会话替换关闭旧编辑器与 Bash Operation 类型断言亦通过；失败仅是旧 live-commands / parity-tui-commands 源码身份失效。最后对齐多层补全器 triggerCharacters 合并，SDK/editor/custom 独立复验 13/13（`editor-completion-final.log`），并由阶段后续 lint/typecheck 检查；该纯补全合并修订后未重跑完整进程构建。`pnpm verify:S10` 为 17 passed / 2 not_run（`editor-s10.log`、`s10/report.json`），手机合同、Android/iOS JS 构建及静态检查通过，设备未运行。保留首次失败日志和各阶段实际证据，不改写成整阶段 passed。最终文档及 diff 格式检查通过。

协议、状态/数据说明、设计和验收同步更新，无新 DTO 或数据库迁移。未读取凭据或调用付费模型，真实进程使用本地合成 provider，不代替 live/TUI/设备验收。

## 2026-09-20 header/footer 工厂与原生 footer 数据

基于 `b6c630c`，接入 header/footer 工厂的 80 列文本渲染、异步刷新、去重、替换/清除/dispose 和错误清除。footer 使用 SDK 0.85.1 的实际 FooterDataProvider：Git 分支及订阅、扩展状态、按 scopedModels / available snapshot 计算的 provider 数量；header 的 setExpanded 跟随展开设置。SDK 内部模块引用仅在 agent-pi，升级版本需重验。手机独立显示顶部和输入区下方画面，复用既有 runtime.notice 持久化及快照/WSS 重放，无新增公共类型或数据库迁移。

每个 Session 保留独立 surface 数据，异步更新在安装时源 Session 创建 Operation，避免原生会话替换后误写目标。替换/清除调用组件 dispose，worker 退出清理全部组件与 Git watcher。定向测试在真实临时 Git 仓库检查分支变化通知、状态/provider 数量、展开更新、迟到刷新及工厂/render/dispose 异常；手机验证重放、清除及失败时移除旧内容。首轮 12/12 与全量 typecheck 通过，日志 `test-results/surface-targeted.log`、`surface-typecheck.log`。

首次真实进程测试 13/14（`surface-sessions.log`），失败为夹具以扩展命令闭包触发旧画面刷新，但原生会话替换重新加载扩展，闭包已重置。已改用原组件定时读取临时测试文件触发自身刷新，仍断言源画面更新、目标无画面，不绕过原生扩展重新加载或放宽归属断言。

最终 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1 验证：SDK/widget/surface/mobile/runtime 定向 44/44（`surface-targeted-final.log`）；`pnpm verify:S07` 为 14 passed / 2 failed（`surface-s07.log`、`s07/report.json`），构建、合同、真实表单和 14 项会话进程测试、lint/typecheck/docs 通过，失败仅为旧 live-commands / parity-tui-commands 身份失效。`pnpm verify:S10` 为 17 passed / 2 not_run（`surface-s10.log`、`s10/report.json`），移动端合同及 Android/iOS JS 构建通过，真机未运行。保留原始失败日志和各报告源码身份，不将整个阶段改写为 passed。最终文档检查和 diff 格式检查通过。

本轮只完成 header/footer 的无焦点文本适配；editor 工厂还需输入、提交、自动补全及快捷键契约，未把静态显示当成交互支持。未运行付费模型、本地交互式 TUI 或 Android/iOS 真机验收。

## 2026-09-20 custom overlay 与原生焦点路由

基于已推送的 `389ebe1`，custom 改用独立 80×24 虚拟 Terminal 和原生 TuiMainScreen。普通组件及 overlay 均经原生输入监听和当前焦点接收按键；保留 overlay 合成、几何、onHandle、隐藏/恢复、nonCapturing、永久移除及焦点切换。overlayOptions 函数按 SDK 0.85.1 实际实现在安装时求值一次，缺省配置保留组件 width 回退。终端输出为空实现，不占用 worker stdin/stdout；画面复用 custom.render，未改变公共协议类型或数据库 schema。

定向测试覆盖监听器消费/转换、嵌套焦点、overlay 几何和隐藏输入隔离、永久移除、关闭后旧 handle 不再发布画面，以及配置/handle/渲染异常清理。WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1 上，`pnpm exec vitest run --config vitest.config.mjs tests/sdk/custom-ui.test.ts tests/sdk/widget-host.test.ts tests/runtime/runtime.test.ts` 为 43/43，通过日志 `test-results/overlay-targeted-final.log`。`pnpm build:server` 和真实 SDK/server/worker 的 `node scripts/test-real-process-e2e.mjs --no-build --sessions-only` 为 13/13，日志 `overlay-build.log` / `overlay-sessions.log`；新增 HTTPS/WSS 场景验证隐藏不接收按键、独立扩展命令恢复、重连画面、原值返回、dispose、无 Run 和零模型调用。

`pnpm verify:S07` 本轮为 13 passed / 3 failed（`test-results/overlay-s07.log`、`s07/report.json`）：构建、命令合同、真实表单/会话进程、全量 typecheck 和文档通过；一项 lint 失败为测试中 CustomTextTui 只作类型却未写 import type，已修正，独立 `pnpm lint` 复验通过（`overlay-lint-final.log`）。另外两项仍是旧 live-commands / parity-tui-commands 报告身份失效。保留阶段首次失败记录，不改写为整阶段通过；仅类型导入修正后未重复完整进程测试。最终 `python3 scripts/check_docs.py` 与 `git diff --check` 通过。

当前仍是每实例独立文本 TUI，背景仅含工厂自身添加的组件；未接入应用级 ctx.ui.onTerminalInput、跨实例共享焦点、任意组合键、颜色/图片和动态手机视口。未运行本地交互式 TUI、付费模型或 Android/iOS 真机验收；上述真实进程测试使用本地合成 provider，不能替代这些验收。

## 2026-09-20 非 overlay custom 输入与完成回调

基于 `3dac602`，接入 custom 根组件的原生 TUI/主题/KeybindingsManager、80 列文本画面、requestRender、handleInput 和 done 原值返回。手机在匹配 Operation 的控制卡片中显示画面，使用现有 select/input/respond 发送方向键、Enter/Esc 等或文本；取消文本输入回到控制面板，明确取消控制面板关闭组件并返回 undefined，Esc 保留扩展自己的处理。没有新核心事件、Interaction kind 或数据库迁移，custom.render 沿用持久化 notice，原始组件和回调结果留在 worker。

每个实例有独立子 Operation，跨连续按键保持存活，不因单个表单完成而提前终态；同步/异步工厂、同步/异步 done、取消慢工厂、迟到组件销毁、输入/渲染异常和 worker 退出均清理生命周期。画面不单独作为普通 widget 展示，避免失效旧交互留下可操作的假象。协议、设计、数据模型、开发计划、原生契约和验收说明同步更新。

跨会话验证首轮失败来自夹具在 custom 返回后读取已失效的原生 ctx.cwd；改为等待前保存测试记录路径，保留原值返回、dispose 和源/目标隔离断言，不绕过 SDK 失效检查。排查还发现实际 extension_error 诊断此前落到 worker 当前目标 Session；修正为传递原 Operation 的 Session，主服务验证 ownedSessionIds 后持久化。真实测试进一步在返回后主动抛错，验证错误只写源会话。首轮测试 this.focused 的 TypeScript 类型错误亦已修正；失败日志保留，不把 Command completed 等同于扩展成功。

补跑 runtime 回归还发现既有握手夹具只确认 mapping、不确认新增初始化 UI 事件批次而超时；已按真实主服务协议确认 batch_ack，继续断言 mapping/ready 顺序和默认展开通知，不修改超时或削弱断言。最终定向 runtime/SDK/custom/widget/mobile 57/57 通过，日志 `test-results/custom-targeted-verified.log`。首轮类型错误、原生 stale ctx 夹具及未 ACK 超时日志分别保留在 `custom-s07.log`、`custom-sessions-final.log`、`custom-routing-targeted-final.log`，没有改写为成功。

最终验证环境为 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。最终构建的完整 `node scripts/test-real-process-e2e.mjs --no-build` 为 26/26（`test-results/custom-e2e-verified.log`），包含成功回调、同键重复响应、源/目标画面及错误隔离。最终 `pnpm verify:S07` 为 14 passed / 2 failed（`custom-s07-verified.log`、`s07/report.json`）；构建、合同、真实进程、lint、全量 typecheck 和文档通过，失败仍是旧 live-commands / parity-tui-commands 证据未匹配当前源码。`pnpm verify:S10` 执行为 17 passed / 2 not_run（`custom-s10.log`、`s10/report.json`），双端 JS 构建及手机检查通过，设备未运行；最后服务端诊断路由修复另经最终 S07、57 项定向与完整进程验证。报告保留各自执行时源码身份，不改写旧证据。`python3 scripts/check_docs.py` 与 `git diff --check` 通过。

当前仍是非 overlay 根组件的文本/按键子集。overlay/onHandle、全局输入监听与完整焦点路由、任意组合键、颜色/图片/动态视口及 Android/iOS 真机触控验收未完成。本轮只调用本地合成 provider，不读取或调用付费模型凭据。

## 2026-09-20 原生 widget 工厂文本适配

基于 `6ab762a`，新增 `WidgetHost`，固定直接依赖 pi-tui 0.85.1，与 SDK 保持同版。用实际 TuiMainScreen 和 SDK dark 主题执行 widget 工厂，以 80 列渲染文本；通过现有 setWidget 通知持久化、快照和 WSS 重放。手机按 aboveEditor/belowEditor 显示，旧缓存默认 aboveEditor。未新增公共 SDK 类型、数据库表或迁移，协议文档补充现有通知的 placement 和 rendererError 形状。

支持异步 requestRender、相同内容去重、同名替换/清除/退出时 dispose、旧刷新失效；原 Command 已完成的刷新产生归属原 Session 的独立 Operation，不创建 Run。失败清除旧显示并报告原因，恢复为相同文本仍重新发布并清除该 widget 错误。终端图片显式报告仍需图片适配，不把转义载荷显示为正常文本。

首轮定向测试发现 TUI 在 SDK 0.85.1 只导出类型，改用原生 TuiMainScreen 后通过；失败日志保留 `test-results/widget-targeted.log`。依赖安装曾因离线 registry 索引缺失失败，之后通过项目 npm 镜像解析固定版本；撤回 pnpm 顺带重写的无关 Expo 锁文件元数据，只保留 pi-tui 直接依赖声明。

验证环境 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。定向 SDK worker、widget 宿主及手机投影 20/20 通过（`test-results/widget-targeted-complete.log`）；最后增加异常恢复断言后宿主/手机 7/7 通过（`widget-recovery-final.log`）。重新构建的 `pnpm test:e2e` 为 24/24，证据 `widget-e2e.log`，使用临时项目及本地合成 provider。`pnpm verify:S07` 为 14 passed / 2 failed，两个失败仍为旧 live-commands / parity-tui-commands 证据身份不匹配（`widget-s07.log`、`s07/report.json`）；`pnpm verify:S10` 为 17 passed / 0 failed / 2 not_run，Android/iOS JS bundle、lint、全量 typecheck、手机合同及文档通过，设备未运行（`widget-s10.log`、`s10/report.json`）。详细阶段报告保持执行时的源码身份，不改写为后续提交。`pnpm install --frozen-lockfile --offline --ignore-scripts`、`python3 scripts/check_docs.py` 和 `git diff --check` 通过。

当前是无焦点文本 widget 子集：不宣称颜色、自定义主题、动态终端宽度、overlay、终端图片、header/footer/editor 工厂或 custom 键盘交互已适配。主题加载器使用固定 SDK 内部相对路径，集中封装在 agent-pi，升级 SDK 时须重验。未执行付费模型调用、交互式本地 TUI 或 Android/iOS 真机验收。

## 2026-09-20 扩展 UI 标量控制

基于 `98d5395`，接通手机工作行显隐、工作指示器帧/间隔、隐藏思考标签、独立窗口标题及工具展开控制。完整工具结果不受手机折叠影响，错误/中断提示始终显示；旧缓存补默认字段，通知按 seq 去重及快照恢复。修正 worker 的 `getToolsExpanded()` 固定 false：现在返回当前扩展设置，新 worker 发布默认 false，原生会话替换在 bound ACK 后通过归属目标的独立 Operation 发布存活设置，不串回源 Session。

继续使用现有 runtime.notice，未新增公共协议字段或数据表。测试新增手机正常/异常/重置投影，以及真实 SDK 扩展到生产 server/worker 的 HTTPS/WSS 持久化、重放、无 Run 控制、窗口标题不改 Session 名称和原生替换归属。环境为 WSL Linux / Node 24.19.0 / SDK 0.85.1，本轮仅使用本地合成 provider，无付费模型请求。

验证：完整 `node scripts/test-real-process-e2e.mjs --no-build` 为 23/23 通过，日志 `test-results/extension-ui-e2e.log`；定向 SDK worker 13/13 通过。手机新增夹具首轮漏了协议必填 message 字段，修正后 `tests/mobile/extension-ui.test.ts` 为 3/3 通过，首轮与修正日志分别保留在 `extension-ui-targeted.log`、`extension-ui-mobile-final.log`。`pnpm verify:S07` 为 14 passed / 2 failed；失败仍是旧 live-commands / parity-tui-commands 证据与当前源码不匹配，本轮构建、合同、两组真实进程、lint、全量 typecheck 和文档通过，见 `extension-ui-s07.log` 与 `s07/report.json`，未改写旧报告。

最终 `pnpm verify:S10` 为 blocked（17 passed / 0 failed / 2 not_run）：手机合同、Android/iOS JS bundle、lint、全量 typecheck、文档通过；两个 not_run 为设备。首轮夹具失败保留在 `test-results/extension-ui-s10.log`，最终证据在 `extension-ui-s10-final.log` 与 `s10/report.json`。`python3 scripts/check_docs.py` 和 `git diff --check` 通过。

任意 custom、header/footer/editor 工厂和终端 renderer 仍待组件适配，Android/iOS 设备显示与动画未运行；不能将本轮标量控制或 JS 构建视为完整原生 UI 或真机通过。真实 provider / 交互式 TUI 矩阵仍需当前源码证据。

## 2026-09-20 手机历史找回入口

基于 `aa625d0`，新增项目级 recoverable-history / history-imports API、公共 Zod DTO、手机 API 方法及 Session 列表的选择/确认/取消入口。服务只读管理目录 `${PI_REMOTE_PI_DIR}/sessions`，通过 agent-pi 的完整 JSONL 检查和真实 cwd 核对发现历史；跳过符号链接、空白/损坏、重复原生身份、其他项目或已有映射。候选 HMAC 绑定项目、相对路径和原生 ID，手机不传任意路径。导入重新扫描，在事务中核对映射、创建 persisted Session 与幂等收据；同键重放原收据、不同键返回已有同项目映射，活跃原生替换期间拒绝抢占。没有新增数据表或迁移，没有修改 Bash/模型能力边界。

导入不写 JSONL、不创建 Run、不自动派发旧任务；模型/等级由后续原生加载发布，原上下文可继续。手机对同一确认动作保留幂等键，网络失败可重试；候选失效提示刷新。原 JSONL 还没有转换为手机旧时间线，界面明确提示消息列表从找回后记录。历史找回限于服务管理目录，不代表完整通用文件导入或 terminal custom UI 已完成。

验证环境：WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。新增 API 正常/异常检查：鉴权、项目归属、header-only、损坏/空白/链接/重复身份排除、列表后损坏/删除、活跃替换拒绝、同键/异键幂等与文件不变；手机验证 DTO 与重试键。新增真实 HTTPS/server/worker 流程：并发导入同一候选只有一份映射、不调用模型、不写历史，继续后模型请求包含原历史上下文。只调用本地合成 provider，不使用付费凭据。

首轮手机测试夹具缺少协议必需 requestId，修正后按真实错误 DTO 验证；首轮完整 E2E 另暴露既有故障夹具的时序竞态：Bash 副作用可先于 accepted 投影持久化，改为等待 accepted 落库后再故障注入，保留原有故障状态断言。失败证据保留于 `test-results/history-s05.log`、`history-s09.log`、`history-e2e.log`；最终验证分别写入 `history-s05-final.log`、`history-s09-final.log`、`history-e2e-final.log` 和阶段 report.json，不改写旧证据身份。

最终结果：`pnpm verify:S05` 为 passed（12/12）；`pnpm verify:S09` 为 blocked（22 passed / 0 failed / 2 not_run），Android/iOS JS bundle、lint、全量 typecheck 与文档通过，两个 not_run 为真实设备。`node scripts/test-real-process-e2e.mjs --no-build` 为 22/22 通过；最后补充边界后定向执行 `pnpm exec vitest run --config vitest.config.mjs tests/api/api.test.ts tests/mobile/api.test.ts tests/runtime/runtime.test.ts` 为 48/48，通过证据另存 `test-results/history-targeted-final.log`。`python3 scripts/check_docs.py` 与 `git diff --check` 通过。

决策已同步 README、设计、协议示例、数据/无迁移说明、开发计划及 AT12/AT21/AT22/AT32 补充验收。当前无 Android/iOS 设备证据，不能把 JS bundle 当成真机已通过；原有真实 provider / TUI 矩阵、终端专用 UI 适配和旧时间线回填仍待完成。

## 2026-09-19 标题竞争与 fork 映射崩溃窗口

基于 `a547eae`，在 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1 扩展真实进程会话回归。两次手机 PATCH 使用同一 version 并发提交，断言恰好一个成功、另一个 409 VERSION_CONFLICT；SDK 标题回声不重复递增 version，后续原生改名可生效。标题已写 JSONL、事件未提交 SQLite 时对真实主进程 SIGKILL；重启加载会话后读取原生标题，未知旧命令不变为成功。

fork 分别在目标文件写入后、映射事务之前，以及映射已提交、bound ACK 尚未发送时暂停并 SIGKILL 主进程。检查文件身份与内容保留、源历史未变、旧命令 unknown、无 continuation 模型请求或新 Run。未映射文件经用户显式 switch 认领，已映射目标经新 prompt 继续，均保持目标身份、不创建第二份 fork 文件、不自动重放 FORK_FIRST / FORK_SECOND。

故障注入位于 `tests/sdk/fault-checkpoints.mjs`，仅由临时测试入口 opt-in 启用：在真实 manager 方法前 SIGSTOP，由父测试确认真实文件/数据库状态再发送 SIGKILL。不修改生产代码，不替换 SDK、消息、EventStore 或恢复逻辑；这是受控时序证据，不能声称覆盖所有自然竞争。未映射文件路径由夹具观察记录再显式传入，尚未证明手机 UI 可发现或找回该文件。

实际执行 `node scripts/test-real-process-e2e.mjs --no-build --sessions-only`：7/7 通过，含新增 4 项与前轮 3 项；日志为 `test-results/session-races.log`。完整 `node scripts/test-real-process-e2e.mjs --no-build`：21/21 通过，日志为 `test-results/session-races-e2e.log`。阶段记录写入 `test-results/session-races-s07.log` 与 `test-results/s07/report.json`，本地详细证据不提交。`python3 scripts/check_docs.py` 与 `git diff --check` 通过。真实 provider、交互式 TUI、设备、延迟旧标题回声与新原生标题竞争以及手机恢复入口仍未完成；本轮不填充完整 live 验收项。

本轮 `pnpm verify:S07`：14 passed / 2 failed，构建、合同、真实表单/会话进程、lint、全量 typecheck 和文档检查通过；两个失败项仍为旧 live-commands / parity-tui-commands 证据源码指纹不匹配。保持阶段 failed，不以本地合成测试代替真实验收，也不重写旧报告。

## 2026-09-19 原生 fork、导入、标题与多 Run

基于 `8fa4a9e`，在 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1 增加 `tests/e2e/sessions-process.test.mjs`，使用临时项目、SDK 正常发现的扩展、生产 server / worker、HTTPS/WSS 与本地合成 provider。新增 `--sessions-only`，接入 S07 与完整 E2E，不修改产品协议或运行时行为。

验证范围：原生 fork 的 withSession 顺序发起两次实际模型运行，两个不同 Run 均关联源 Session 的同一 Command，目标历史包含两次输入而源历史字节不变，重启后模型收到 fork 上下文；未映射的合法 header-only JSONL 经 switchSession 导入、运行、落盘并在重启后保持原生身份；扩展 A → 手机 B → 扩展 A 的标题在 SQLite 和 JSONL 一致，源 Session 标题不受污染；缺失、零字节与损坏 JSONL 被拒绝后文件不被重建或改写，不产生新 Session，原会话可继续对话。

定向命令 `node scripts/test-real-process-e2e.mjs --no-build --sessions-only` 首轮两项正常路径通过，证据为 `test-results/sessions-process.log`。补充异常路径后，首轮错误地要求扩展命令 failed；核对 SDK `_tryExecuteExtensionCommand` 确认其捕获异常并经 ExtensionRunner 发出错误，Command completed 不代表导入成功。改为同时断言 completed、同 Operation 的原生导入错误通知、文件不变/缺失、映射不变及新对话成功；没有修改产品语义。首轮失败保留于 `test-results/sessions-s07.log`、`test-results/sessions-full-e2e.log`；最终复验使用 `test-results/sessions-s07-final.log`、`test-results/s07/report.json`、`test-results/sessions-full-e2e-final.log`。详细日志仅保留在忽略目录。

后续修正了夹具的归属查询：queued 的 command.updated 尚无 operationId，必须选取真实执行后非空的归属再比对错误通知。第二轮完整 E2E 为 16 passed / 1 failed（该查询导致等待超时），保留原日志；修正后的定向会话测试 3/3 通过，见 `test-results/sessions-corrected.log`。最终源码运行 `node scripts/test-real-process-e2e.mjs --no-build` 为 **17/17 通过**，包括新增 3 项及既有 14 项，证据为 `test-results/sessions-full-e2e-verified.log`；阶段记录另存 `test-results/sessions-s07-verified.log`，不覆盖前次失败证据。`python3 scripts/check_docs.py` 与 `git diff --check` 通过。

最终 `pnpm verify:S07` 为 14 passed / 2 failed：构建、合同、真实表单/会话进程、lint、全量 typecheck 与文档通过；失败仍是旧 live-commands / parity-tui-commands 报告源码身份过期，未改写证据或重跑付费模型。阶段报告保持 failed，发布条件未满足。

这些证据不代替真实 `CMD-native-session-title` / `CMD-autonomous-multiple-runs`：并发标题竞争、JSONL 已落盘但事件未提交的崩溃窗口、fork 文件写入后的映射 ACK 窗口、无外部 Command 的自主运行、compact 后 prompt 及真实 provider / TUI / 设备矩阵仍有未覆盖项。不将本轮两个顺序 continuation 泛化为全部多 Run 行为通过。

## 2026-09-19 五阶段真实进程表单回归

基于 `7d4178719121dda780908f957392edbbabdc9e12`，在 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / pi SDK 0.85.1 补充 `tests/sdk/forms-extension.mjs` 与 `tests/e2e/forms-process.test.mjs`。扩展从临时 agentDir 正常发现，使用真实 SDK、生产 server / worker、HTTPS/WSS 和 SQLite；五个入口分别为 session_start、thinking_level_select、before_agent_start、user_bash 和 extension_command。四类表单均验证实际回答、取消返回值、持久终态、同键幂等及新键重复回答拒绝，另验证输入超时、迟到回答拒绝和待答期间快照/重连回放。Bash 检查真实文件副作用；仅 run 场景产生一次本地合成模型请求，没有付费模型调用。

配置 hook 的后续表单遵循既有异步契约：首张属于 configure，配置操作完成后创建 extension 子 Operation，并断言 parentOperationId；不强制延长原生配置命令或取消后续表单。首轮夹具误用了内部 snapshot.interactions、未改变实际 thinking 等级，以及将扩展 slash 发往普通 prompt；已按公开 pendingInteractions、实际不同等级与 extension_command 入口修正。首次直接 Windows 挂载运行遇到测试超时，后续使用既有离线 Linux staging；不将这些夹具失败记录为产品修复。

新增 `--forms-only` 入口，并接入 `pnpm verify:S07` 与完整 `pnpm test:e2e`。实际执行 `pnpm verify:S07`：13 passed / 2 failed，构建、合同、五阶段真实进程、lint、全量 typecheck 和文档检查通过；两个失败来自旧 live-commands / parity-tui-commands 报告源码身份失效，阶段报告诚实为 failed，不能据此判定产品运行故障，也不改写旧报告身份。实际执行 `node scripts/test-real-process-e2e.mjs --no-build`：14/14 通过，包括新增 5 项和原有 9 项故障恢复/会话测试。`python3 scripts/check_docs.py` 与 `git diff --check` 通过。证据：`test-results/forms-process.log`、`forms-staged.log`、`forms-fixed.log` 保存初次失败；`test-results/forms-s07.log`、`test-results/s07/report.json` 及 `test-results/forms-full-e2e.log` 保存最终验证。这些本地日志不提交。

范围：未修改产品协议或运行时行为，未把合成 provider 的结果填入真实 `CMD-all-phase-forms`。第二个真实模型、model_select 全表单、完整会话 fork/import/标题/多 Run、交互式 TUI 与 Android/iOS 仍需后续验证或实现，S07 不据此改为 passed。下一步继续原生会话与多 Run 的真实进程闭环，再补真实 provider 表单证据和移动适配。

## 2026-09-19 默认配置、空会话回收与扩展错误

本轮基于 `d821ffab211b528a6fff8d59ca780916d165f74e` 工作树，环境为 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。新增 `--scenario defaults`（至少 4 次顶层任务），对照默认值落盘、新会话继承、已加载会话隔离、空历史主动回收恢复，以及两个不同模型间的 model_select hook 错误。测试保存默认 low，再将空会话单独设为 medium，避免把回退到默认值误判为成功恢复；保留“回收前后历史文件均缺失、旧 PID 退出、新 PID 加载、后续真实调用”的断言。

回归发现并修复两个实现问题：

1. SDK 初始化选中了已保存的默认模型，但未通过 session.updated 发布，后端新会话快照仍为 model=null。worker 现于初始化 hook 完成后、ready 之前发布与加载参数不同的实际 model/等级，并刷新可用等级。使用已有事件和 ACK 顺序，不改 schema；相同配置不产生无意义的版本变化。失败证据 `test-results/deepseek-live/defaults-regression.log`。
2. idle reaper 收到 stopped 后没有关闭 worker stdin，JSONL reader 一直等待输入，进程不能正常退出。现仅在 stopped 确认到达后关闭输入；worker 的 stopped 本身等待先前事件批次 ACK，因此不会提前切断持久化确认。保持默认不自动回收，测试入口才显式启用。失败证据 `defaults-fixed-regression.log`；生命周期回归的 fake worker 也改为真正等待 stdin EOF 后退出，防止合成自动退出掩盖缺陷。

两处修复后的真实后端/合成 provider 回归 12/12 通过（`defaults-reaper-regression.log`）。后续对初始化事件增加“仅发送实际变化”的处理，运行 runtime 与真实 SDK worker 回归 45/45 通过（`defaults-runtime-regression.log`）。双模型合成场景验证：原生 setModel 不因扩展错误 reject，实际模型已改变；后端仍完成命令并保留相同 Operation 的错误提示，不假称回滚。同模型重复选择不会触发 SDK 的 model_select，因此用户的 DeepSeek 单模型配置在此子项记录 not_run，不额外引入第二模型。

`pnpm test:acceptance` 25/25 通过（`test-results/deepseek-live/defaults-acceptance.log`），完整 lint 通过（`defaults-lint.log`）。`pnpm verify:S06` 为 12 passed / 0 failed / 2 not_run，状态 blocked（`defaults-s06.log`、`test-results/s06/report.json`）；构建、运行时合同、lint、全量 typecheck 和文档检查通过，缺失的完整 Bash/TUI 原生对照仍为 not_run。后续文件断言在两会话之间删除旧结果，避免用前一会话的文件冒充新调用成功。

最终构建的后端回归 12/12（`defaults-final-regression.log`），实际进程故障 E2E 9/9（`defaults-e2e.log`）通过；后者包含 SIGKILL、未知命令不重投、stop 草稿、超过 60 秒的初始化交互、原生会话替换。首次 DeepSeek defaults 实测在原生部分断言失败，保留 `defaults-live.log`、`defaults-first-report.json`；原诊断阶段粒度不足，不能事后断定具体 provider 故障或根因。

随后补充单模型合成回归及分阶段安全诊断，后端回归 13/13 通过（`defaults-single-regression.log`）；其中单模型 hook 子项明确 not_run。零生成请求的私有预检确认原配置保存/继承正常（`defaults-preflight.log`），并观察到 DeepSeek 把请求 medium 调整为 high。带细化诊断的真实复验通过 `AUTO-CMD-persist-empty-recovery`：默认 low、邻接会话 off、空会话回收后 high 均符合原生 SDK，实际后续模型和新生成文件通过。证据 `defaults-live-diagnostic.log`、`defaults-passed-report.json`；4 次顶层任务上限，360000 ms 测试时限。`AUTO-CMD-model-select-error` 在真实单模型环境保持 not_run，完整 suite 为 blocked（退出码 1）。

S06 报告早于最后的诊断/单模型测试补充，生产修复代码此后未改变；所有报告保留运行时父提交和工作树指纹，不改绑历史证据。最终发布仍须在发布提交汇总所需验收，不能用本轮子集结果替代完整阶段或 TUI/设备证据。

最终 `pnpm verify:S07` 为 12 passed / 0 failed / 2 not_run，状态 blocked（`test-results/deepseek-live/defaults-s07.log`、`test-results/s07/report.json`）。构建、命令/交互、lint、全量 typecheck、文档检查通过；未运行项为完整 commands（含单模型无法触发的 hook）及原生 TUI。189 个非忽略文件的凭据扫描为 0 匹配，`git diff --check` 通过。下一步补充全阶段扩展交互、原生会话切换与多 Run 的真实 provider 对照；双端设备和完整 TUI 继续独立验收。

## 2026-09-19 执行中配置与重启恢复

基于 `8419e8bb3c0b660bd241e2d03910ec6669d8c9a1` 的工作树，在 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1 继续 S07。新增 `--scenario configuration`，预算至少 4 次顶层任务。直接 SDK 与生产后端各在 Bash 工具等待期间请求 xhigh、选择目标模型、请求 low，比较 SDK 实际生效等级；后端配置完成时旧 Run 必须仍在 running。随后停止任务，分别重新打开原生会话、SIGKILL 并重启主服务，再验证配置、后续 assistant 的实际 model/provider 与写入文件。配置不改默认值，原始专用 agent 先复制到临时目录；无产品实现改动。

`pnpm test:acceptance-backend` 11/11 通过（`test-results/deepseek-live/configuration-staged-regression.log`），本地使用两个合成模型验证实际切换及非 reasoning 模型的等级 clamp。首次运行仅因临时 Linux 目录漏复制 `live-model-selection.mjs` 而失败（`configuration-regression.log`），补全 staging 后通过。`pnpm test:acceptance` 24/24 通过（`configuration-acceptance.log`），所有改动文件定向 lint 通过（`configuration-lint.log`）。预算不足不能导入 runtime；新自动项 `AUTO-CMD-active-config-recovery` 不替代完整 `CMD-model-thinking`。

测试覆盖活动工具期间的配置，不等同于 token 流中的精确时序；persist=true、空历史回收及 model_select hook 错误仍待单独验收。真实环境按用户指定的单模型配置执行，同模型重新选择不能算两个真实模型切换。

真实 DeepSeek `node --env-file=.env scripts/test-live.mjs --suite commands --scenario configuration` 通过 `AUTO-CMD-active-config-recovery`；本轮请求 xhigh 的原生有效值仍为 xhigh，随后设为 low，双方重开/重启后恢复 low。后续 assistant model/provider 与实际文件均核对，两个临时 agent 的默认 settings 内容未改变。证据 `test-results/deepseek-live/configuration-live.log`、`configuration-passed-report.json`，4 次顶层操作上限、360000 ms 测试时限。suite 保持 blocked、退出码 1（其余 6 个完整 case 未在本次运行），不覆盖两模型实测、完整 TUI 或设备。报告保留执行时父提交和源码指纹。

最终 `pnpm verify:S07` 为 12 passed / 0 failed / 2 not_run，状态 blocked（`test-results/deepseek-live/configuration-s07.log`、`test-results/s07/report.json`）。构建、命令/交互合同、lint、全量 typecheck 和文档检查通过；完整 commands 与原生 TUI 未完成。188 个非忽略文件的凭据扫描匹配数为 0，`git diff --check` 通过。下一步为 persist=true 默认配置隔离、空会话回收恢复及 model_select hook 异常；本轮不重复独立进程故障矩阵，已在新增真实进程场景中执行配置后的主服务 SIGKILL/恢复。

## 2026-09-19 compact 摘要流取消

基于 `24ac04358ed2e8ad34027ef32ae638696aacba49` 工作树继续 S07，环境沿用 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1。新增 `--scenario compact-cancel-stream`，要求至少 8 次顶层操作。固定 SDK 没有公开摘要 token 事件，因此测试专用本机 relay 在收到并转发 provider 首个非空 content frame 后暂停后续交付，分别触发原生 `abortCompaction()` 和后端定向 abort。检查两个 HTTP 流关闭、原生取消事件、Run/Command 取消终态、无 compaction 落盘及原上下文可继续写文件。该受控网络窗口不等同于未经延迟的实网时序或交互式 TUI；不改变生产代码、模型配置或摘要默认行为。

relay 仅请求原配置 provider 地址且拒绝重定向，不持久化请求/响应/凭据；临时配置与 relay 随夹具清理。增加空内容反例：即使 HTTP 200 和结束 frame 都到达，没有非空 content 仍不能触发“生成中”断言。`pnpm test:acceptance-backend` 10/10 通过（`test-results/deepseek-live/compact-stream-final-regression.log`），包括原有控制/compact 路径及流取消；该回归使用合成 provider。`pnpm test:acceptance` 23/23 通过（`compact-stream-acceptance.log`），新自动项仍不能将完整 `CMD-compact-queue` 改为 passed。

真实 DeepSeek `node --env-file=.env scripts/test-live.mjs --suite commands --scenario compact-cancel-stream` 的 `AUTO-CMD-compact-cancel-stream` 通过；专用配置为 8 次顶层操作上限、360000 ms 测试时限，不是产品超时或费用上限。证据 `test-results/deepseek-live/compact-stream-live.log`、`compact-stream-passed-report.json`；两侧首个非空摘要 frame、取消断连和后续文件均通过实际断言。完整 suite 仍为 blocked、退出码 1，因为其余 6 个完整命令场景在本次定向运行中 not_run。保留报告的父提交与源码指纹，不合并旧报告或改写历史身份；生产实现没有新增修改，因此不重复上一轮已通过的独立 SIGKILL E2E。

首次 S07 检查发现测试 helper 的 URL / TextDecoder / AbortController 未按仓库 lint 规则显式引用；改为 Node import 和 globalThis 后，定向 lint 通过。此修改晚于真实模型报告，因此原报告只作为上述版本的历史证据；另行生成当前源码的 live/TUI not_run 报告，不将旧证据改绑到新指纹。失败记录保留于 `compact-stream-s07.log`，不为报告指纹重复付费请求。后端回归重新执行于 `compact-stream-imports-regression.log`。

最终后端回归仍为 10/10；`pnpm verify:S07` 为 12 passed / 0 failed / 2 not_run，状态 blocked、退出码 1（`test-results/deepseek-live/compact-stream-final-s07.log`、`test-results/s07/report.json`）。构建、命令/交互、lint、全量 typecheck 与文档检查通过；完整 commands 与原生 TUI 尚未验收。187 个非忽略文件的凭据扫描为 0 匹配，`git diff --check` 通过。下一步补 streaming 模型/思考配置及恢复后的配置一致性，完整应用队列/扩展、原生 TUI 和双端设备仍单独保留待验收。

## 2026-09-19 compact 原生队列与取消对照

本轮基于 `28f80b2acaa8a0d53b1437064b94828805590d6a` 工作树，在 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / pi SDK 0.85.1 继续 S07。真实进程回归复现：compact 为保留原生输入而停止当前生成时，worker 仍强制设置 abort 标记，导致原生队列已继续执行并成功结束的旧 Run 被误记为 aborted。现仅在 preserveQueue 路径预置中断结果，允许后续原生 assistant 的实际 stop/error 覆盖；显式 stop 仍清取草稿并保持 abort 优先。未修改协议、schema 或生产压缩配置。

新增 `--scenario compact` 与 `--scenario compact-cancel`，每个场景分别要求至少 8 次顶层操作。直接 SDK 与生产后端使用相同的临时配置和合成项目，比较原生队列、旧 Run、压缩历史、摘要保留标记以及后续真实写文件；取消场景在原生 before-compact 待答窗口定向 abort，核对取消终态、待答关闭、无摘要落盘和原上下文可继续。后者只覆盖摘要生成前取消，尚未覆盖 provider 摘要流中断或交互式 TUI。两项自动结果均不能代替完整 `CMD-compact-queue`。

- 修复前 `compact-regression.log` 保留旧 Run aborted/completed 不一致；修复后正常队列、无队列及空历史失败恢复均通过。取消夹具最初使用 SDK 不自动发现的扩展后缀，且短历史仍在保留窗口内；改用受支持的 `.js`、补足独立历史轮次，并对 compact 提前退出立即报错。未放宽断言或产品前置条件，失败日志保留。
- `pnpm test:acceptance-backend`：8/8 通过，证据 `test-results/deepseek-live/compact-cancel-final-regression.log`。这是生产 server/worker 加本地合成 provider 的回归，不替代真实模型。
- `pnpm test:acceptance`：22/22 通过，证据 `test-results/deepseek-live/compact-final-acceptance.log`，包括两个 compact 场景的预算限制与子集不得通过完整矩阵的约束。
- 真实 DeepSeek `--scenario compact`：`AUTO-CMD-compact-native-queue` passed；双方 seed → gate → steer → native followUp 顺序一致、队列均消费完、旧 Run completed、摘要和后续文件验证通过。证据 `test-results/deepseek-live/compact-live.log`、`compact-live-passed-report.json`。
- 真实 DeepSeek `--scenario compact-cancel`：`AUTO-CMD-compact-cancel-before-summary` passed；证据 `test-results/deepseek-live/compact-cancel-live.log`、`compact-cancel-passed-report.json`。凭据仍只保存在忽略的本地配置中。

两份真实报告分别保留运行时的父提交和工作树 SHA-256；正常压缩报告早于取消测试的后续修改，不改写它的身份。完整 commands 仍包含 not_run，因此两次定向运行的 suite 均为 blocked（退出码 1），不声明 S07、完整 TUI 或发布验收通过。

最终 `pnpm verify:S07` 为 12 passed / 0 failed / 2 not_run，状态 blocked；构建、命令/交互合同、lint、全量 typecheck、文档检查均通过。未运行项是完整 commands 与原生 TUI，当前定向报告不合并旧 controls 结果。证据 `test-results/deepseek-live/compact-s07.log`、`test-results/s07/report.json`。`node scripts/test-real-process-e2e.mjs --no-build` 9/9 通过，证据 `test-results/deepseek-live/compact-e2e.log`；包含真实进程 SIGKILL、停止草稿、不重发未知命令、超过 60 秒待答恢复及原生会话替换，模型传输仍为本地合成。186 个非忽略文件的凭据扫描匹配数为 0，`git diff --check` 通过，`.env` 与私有 agent/报告继续被忽略。下一步继续完整 compact 的摘要流取消、应用队列/扩展对照及 streaming 配置；原生 TUI、第二模型和双端设备仍需独立验收。

## 2026-09-19 控制场景继续复验

沿用上一轮精确控制指令，没有继续修改产品执行逻辑。新增控制诊断结构：输入状态、原生 JSONL 中的合成指令标记、工具名称/错误标记；任意对话、工具参数和输出不进入报告。新增脱敏回归，证明测试用私有字符串不会被序列化到诊断中。

本轮首次真实 DeepSeek 控制场景已完整通过 `CMD-steer-stop-drafts` 与 `AUTO-CMD-stop-drafts`：三份完整草稿取回、旧队列暂停及取消、旧 target 拒绝、新任务执行、steer consumed、同键收据、独立 follow_up Run、`gate → steer → follow` 精确副作用顺序、无草稿重放。证据 `test-results/deepseek-live/controls-trace.log` 与 `controls-trace-passed-report.json`。此前请求超时与结果断言失败仍作为历史保留；旧报告未保留的细节无法事后推断，因此不声称已经证明每次历史失败的根因。

随后补入脱敏回归与说明文档并冻结源码。`pnpm test:acceptance-backend` 4/4 通过（`controls-trace-regression.log`），包含三个真实进程/确定性模型场景及一项诊断脱敏测试；这些本地结果不代替真实模型验收。完整 commands 矩阵还缺模型/等级 streaming 配置、compact、全阶段表单、原生会话/标题及自主多 Run；第二模型、原生 TUI 和设备验收仍未完成。

冻结后的第二次真实 controls 再次通过（`controls-frozen-live.log`、`test-results/live-commands/report.json`）：2 passed / 5 not_run，suite 为 blocked，退出码 1 仅表示完整矩阵缺项。`pnpm test:acceptance` 20/20 通过（`controls-trace-acceptance.log`）。两次真实通过均在 WSL Linux / Node 24.19.0 / pi SDK 0.85.1 执行，仍使用用户指定的 DeepSeek 模型 ID。凭据扫描 185 个非忽略文件，匹配数为 0；`git diff --check` 通过。验收记录保留执行时的父提交 `262b4c3` 与工作树 SHA-256，不在提交后改写原始报告身份；最终发布仍须在发布提交重新汇总所需证据。

最终 `pnpm verify:S07` 为 **12 passed / 0 failed / 2 not_run**，状态 blocked、退出码 1。构建、命令/交互合同、lint、全量 typecheck、文档检查均通过；两项 not_run 分别为剩余 5 项 commands 场景和 8 项原生 TUI 对照，已不再含真实 controls 执行失败。证据 `controls-frozen-s07.log`、`test-results/s07/report.json`。本轮修复、验收脚本、CI 与进度记录一并交付；不宣称完整 S07 或发布验收通过。

## 2026-09-19 stop / steer / follow-up 控制验收与修复

新增 `--suite commands --scenario controls`，使用真实生产 server/worker、HTTPS/WSS 和临时 Bash gate，要求三次顶层任务预算。场景验证两份相同 steer 和一份 native followUp 的完整多行中文草稿取回、持久 follow_up 在 stop 后暂停、旧 target 不停止新 Run、steer 消费、后续任务顺序、同键收据与结果文件无重复写入。真实模型与本地确定性模型分别记录，带附件输入、compact、原生 TUI 对照仍不在此场景内。

本地真实进程回归复现了现有缺陷：直接 prompt 的异常终态不在 queue.items 中，原 reconcileQueue 分支会直接 pump 后续项，导致 stop 后旧 follow_up 继续执行。现依据该 Command 自己关联的异常终态 Run 暂停已有后续项；不因失败的输入/控制命令暂停其他 Run，不覆盖已有 pause，不限制新对话，取消最后一项仍恢复 ready。这是对现有 protocol-v1 队列规则的实现修复，未改协议或 schema。增加 cancelled / failed 两种直接 Run 的命令回归，并在真实进程场景保留“暂停后不自动执行”断言。

调试证据保留于 `test-results/deepseek-live/`：`controls-regression.log` 记录产品修复前 ready/paused 断言失败，`controls-regression-fixed.log` 和 `controls-regression-diagnostic.log` 为修复后 3/3 通过。`controls-e2e.log` 记录既有真实进程故障回归 9/9 通过，包含 SIGKILL、不重投未知命令、stop 草稿、旧队列保留、初始化表单及原生会话替换；该回归使用本地确定性模型。

真实 DeepSeek 第一次 controls 在第二个任务等待 gate 超时；第二次补充终态诊断后确认该任务 completed 但未调用工具，不能算通过。两次 stop 部分均已执行到取回三份完整草稿、暂停并取消持久 follow_up；第二次单独记 `AUTO-CMD-stop-drafts` passed，不代替完整 `CMD-steer-stop-drafts`。保留 `controls-first-report.json`、`controls-diagnostic-report.json`、`controls-live.log`、`controls-live-diagnostic.log`。随后为第二段使用不同脚本及明确的新任务指令；仍要求真实 Bash 调用，不放宽原断言。

后续复验曾在首次工具调用前失败，安全诊断识别到 timeout，未采集到足以区分 provider / worker 的具体错误码；证据 `controls-third-report.json`、`controls-timeout-report.json`。停止并行构建后，下一次完成 stop、旧 target 拒绝、新任务及后续任务终态，但最后断言失败；保留 `controls-consumption-report.json`。随后将精确 Bash 指令写入 steer/follow-up，并把副作用顺序、输入消费及最终快照拆成独立诊断阶段；只输出允许列表中的错误类别、命令状态和合成标记，不保存秘密或模型正文。

最终精确指令版本的本地 runner 回归 3/3 通过（`controls-regression-latest.log`）；真实调用在首次工具前失败，报告含 `SDK_OPERATION_FAILED`、`provider-request-timeout`，未观察到工具开始或内容流（`controls-live-latest.log`、`test-results/live-commands/report.json`）。至此停止重复付费调用。当前完整 controls / S07 不通过；下一步应在 provider 请求恢复稳定后继续核对真实 steer 消费及 follow_up 副作用顺序，不能用历史 stop 部分通过或本地确定性结果代替。生产修复之后未再改变产品执行逻辑；后续修改仅为验收指令和安全诊断。

当前源码的验收报告回归 `pnpm test:acceptance` 20/20 通过（`controls-acceptance-current.log`）；`git diff --check` 通过。185 个 Git 非忽略文件的 key 扫描匹配数为 0；`.env`、模型配置及实际运行报告继续被忽略。环境仍为 WSL Linux / Node 24.19.0 / pnpm 10.28.0 / SDK 0.85.1，工作树基于 `262b4c3`，本轮未提交或推送。

最终 `pnpm verify:S07`：12 passed / 1 failed / 1 not_run，退出码 1；构建、命令/交互合同、lint、全量 typecheck 和文档检查通过。failed 为真实 commands 场景尚未通过，not_run 为缺少 8 项原生 TUI 对照。证据 `controls-s07-current.log`、`test-results/s07/report.json`。完整阶段保持未通过，不把本地检查的绿色结果替代真实验收。

## 2026-09-19 DeepSeek 真实调用

基于提交 `262b4c33cf09ffdfb2463a91732dc05fd31871ec` 的未提交工作树，环境为 WSL Linux、Node 24.19.0、pnpm 10.28.0、pi SDK 0.85.1。按用户要求从指定 key.txt 只提取 DeepSeek key，存入 Git 忽略的本地 `.env`；私有模型配置通过环境变量引用，不写入源码。TLS 使用已验证证书链中的公开 CA，未关闭证书验证。

使用用户指定的 `deepseek-v4-flash`。官方文档说明该旧 ID 目前映射到 DeepSeek-V4.1-Flash；本次证据表示该 ID 在测试时实际提供的服务，不证明已退役模型的原始版本。用户指定单模型，因此启用显式单模型 smoke；不能将同一模型开关 thinking 当作 AT03 的两个不同模型。

- `node --env-file=.env scripts/test-live.mjs --suite sdk`：真实 read/write 与结果文件核对、thinking block 均通过；3 passed / 3 not_run，整体 blocked。证据 `test-results/live-sdk/report.json`、`test-results/deepseek-live/sdk.log`。修复 runner 将 SDK 0.85.1 的 checkAuth 对象误判为 boolean 的问题；初次失败发生在生成请求之前。临时测试项目置于系统临时目录，避免继承本仓库上下文。
- 同命令 `--suite commands`：生产 server/worker、HTTPS/WSS、真实工具结果、同键 prompt 收据及空闲配置投影通过；2 passed / 6 not_run，整体 blocked。证据 `test-results/live-commands/report.json`、`test-results/deepseek-live/commands.log`；未证明不同模型间切换或完整控制/交互。
- 同命令 `--suite realtime`：首次 execution 失败，原因未确定；保留 `test-results/deepseek-live/realtime-first-report.json` 和 `realtime.log`，不改写为成功。补充只含固定阶段/错误类别的安全诊断后，定向复验 RT-stream-tool、RT-reconnect-replay 通过，2 passed / 3 not_run，整体 blocked；证据 `test-results/live-realtime/report.json`、`test-results/deepseek-live/realtime-diagnostic.log`。断线后真实任务完成，回放 seq/type/payload 与 SQLite 相等。此次通过不能证明首次失败根因已修复。

SDK 与 commands 报告先于安全诊断修改生成，保留原始源码指纹，不伪造为当前源码证据；最终发布需在冻结版本统一复验。未完成项仍包括不同的第二个模型、异常重试、长时间开发、完整 commands/realtime 矩阵、原生 TUI/Bash 对照及 Android/iOS 设备。上述真实调用不构成完整阶段或端到端发布验收。

本轮本地回归：`pnpm test:acceptance` 19/19（由 `verify:S02` 执行）、`pnpm test:acceptance-backend` 2/2、`pnpm lint`、`git diff --check` 通过。后端回归使用本地确定性模型服务，不计入 live 证据。刷新 SDK 的 Bash/TUI 缺证据报告后，`pnpm verify:S02` 为 10 passed / 1 failed / 2 not_run，退出码 1；唯一 failed 为真实 SDK 报告的源码指纹先于安全诊断修改，不能当作当前版本通过，也不是新发现的模型运行失败。证据：`test-results/deepseek-live/backend-regression.log`、`lint-final.log`、`s02-final.log`。扫描 184 个 Git 非忽略文件，DeepSeek key 匹配数为 0；确认 `.env` 与私有模型目录被忽略。工作树尚未提交或推送。

## 2026-09-18 验收入口与报告规则修订

基于提交 `262b4c3` 的工作树修改；本轮未调用真实 provider，也未运行手机流程。此前 S12 的 passed 只支持 Docker 部署生命周期子集，不能覆盖 development-plan 要求的原生对照；现将完整阶段恢复为 blocked，历史 Docker 证据保留。

新增 [验收入口说明](acceptance-runners.md) 与统一证据校验。live 支持 sdk / commands / realtime；新增后端路径使用生产 server/worker、临时 HTTPS/WSS、真实模型工具往返、同键请求、配置和 cursor 回放。自动覆盖之外的必需场景继续逐项 not_run；TUI / Bash 全矩阵采用运营者实际采集、原生端与应用端双份证据及人工复核，不声称已实现自动操作 TUI。

报告绑定 commit 与源码 SHA-256；验证 case 覆盖、状态、版本、非空采集文件、SHA-256 和目录边界。完整 parity 与确定性 `--smoke` 分目录；阶段验证器读取对应报告，不再写死 not_run，也不在汇总时隐式调用付费模型。S12 增加 `--deployment-only` 供普通 CI，独立报告不能替代完整 S12。所有阶段报告记录源码指纹，S13 拒绝空报告、旧源码和不完整的 live/parity 覆盖。

验证环境：WSL Linux、Node 24.19.0、pnpm 10.28.0、pi SDK 0.85.1。证据目录为 `test-results/acceptance-runners/`（不提交运行数据）。

- `pnpm test:acceptance`：17/17 通过，含 13 类 CLI 在缺真实环境时输出完整 blocked 报告；证据 `contract.log`、`missing-environment.log`。
- `pnpm build:server`、`pnpm lint`、`python3 scripts/check_docs.py`：通过；文档检查覆盖 22 个 Markdown、13 阶段、14 FR、32 AT。lint / docs 输出见 `lint.log`、`docs.log`。
- `pnpm test:acceptance-backend`：2/2 通过，真实生产 server/worker + HTTPS/WSS + 本地确定性模型服务；不记作真实 provider 通过。证据 `backend.log`。
- `pnpm verify:S02`：10 passed、3 not_run，状态 blocked、退出码 1；SDK 合同及 runner 回归通过，完整 live / Bash / TUI 证据缺失。证据 `s02.log`、`test-results/s02/report.json`。
- `pnpm verify:S13`：2 passed、11 failed、16 not_run，状态 failed、退出码 1。其中实际进程 E2E 通过；11 个失败项是尚未重跑的新格式阶段报告缺少当前源码指纹，16 个未运行项包括 S02 阶段及 live / parity / 设备证据。已确认不会接受旧版报告或缺项。证据 `s13.log`、`test-results/s13/report.json`；没有把汇总失败改成成功。

调试中修复了快模型在轮询前完成导致断线时机失真的竞态：现在首个流事件回调立即断线，再核对持久事件。WSL 挂载目录首次运行出现 SDK 导入耗时导致的 harness 超时，已沿用既有离线 Linux 暂存方式复验；原断言保留，没有改为 skip。新增脚本不修改产品默认工具、资源或超时语义。

未覆盖：真实 provider、交互式 TUI、Docker 原生对照、Android/iOS 设备与终端 renderer 产品适配。本轮没有重跑全部阶段、Docker 生命周期或双端构建；其历史证据只表示对应旧版源码的验证。完整发布仍须在同一版本补齐报告和真实证据。工作树改动尚未提交或推送。

## 2026-09-15 代码审核修复

基于 `12994b3cafacb06b0cdd30339987db942305e10c` 的既有未提交实现，修复 R01–R16 并补真实 SDK/进程回归；没有提交或推送。逐项实现、测试与保留边界见[修复记录](reviews/2026-09-15-code-review-fixes.md)。

环境为 WSL/Linux、Node 24.19.0、pnpm 10.28.0、pi SDK 0.85.1。包含并发替换与跨目录切换补充修复的最终全量单元测试：24 文件 / 170 测试通过。全量 typecheck、lint、server 构建、Android/iOS/web JS export、文档检查全部通过，详细命令与证据统一记录在修复记录中。

`node scripts/test-real-process-e2e.mjs --no-build` 在所有补充修复后的最终构建复验 9 passed、0 failed、0 skipped，80.06 秒。使用实际生产 server/worker、SQLite/JSONL、HTTPS/WSS、原生 SDK 工具与 Bash，通过本地 HTTP 模型端点提供确定性响应，从进程外部 SIGKILL 并重启。证据在 `test-results/code-review/r16-final-real-process.log` 与 `r16-runtime-manifest.json`；旧失败日志仅作修复过程记录。这些测试补齐本地可完成的真实进程覆盖，不替代真实运营者 provider、原生 TUI、Docker 或设备验收。

修复保持原生工具、Bash、扩展、无命令自主活动和会话操作；没有增加命令过滤、审批、默认执行超时或路径执行沙箱。阶段 blocked / not_started 的外部条件未因此移除。

## S01–S12 应用实现证据

### S01

在干净 Linux checkout 使用 Node `v24.19.0`、pnpm `10.28.0`、SDK `0.85.1` 运行 `pnpm verify:S01`，冻结安装、lint、typecheck、9 个单测、server / package build、Android / iOS JS bundle 及 `/healthz` 均通过。该阶段不包含 Android / iOS 真机验收。清洗后的机器报告为 `test-results/s01/report.json`（详细运行数据不提交）。

### S02

在 WSL Linux 使用同一 Node / pnpm / SDK 运行 `pnpm verify:S02`：S02-01 至 S02-05、能力清单和 SDK 包构建通过；`pnpm test:bash-parity -- --target sdk` 的确定性 SDK 与 `/bin/bash` smoke 通过。`pnpm test:tui-parity -- --target sdk` 以及 `pnpm test:live -- --suite sdk` 因没有真实 TUI / 运营者模型配置未运行，阶段保持 `blocked`。完整清洗说明见 [sdk-verification.md](sdk-verification.md) 和 [native-capabilities.md](native-capabilities.md)。

### S03

实现 `packages/protocol/src/{http,commands,events,state,reducer}.ts`，协议包直接依赖 `zod@4.6.2`，不依赖 pi SDK。`pnpm verify:S03` 与全仓 `pnpm run lint`、`pnpm run typecheck`、`pnpm run test:unit` 均通过；当前 S03 共 9 个单测，覆盖正常流、异常封存、无 Run 初始化、跨 Session 原生事件、累计工具快照、重复事件和序号缺口。S03 只验证公共契约与合成 fixture，不代表 SQLite / API / worker 已实现。

本轮约定的 npm、Docker 镜像及 CI 国内源记录在 [.npmrc](../.npmrc)、[engineering-baseline.md](engineering-baseline.md)、[deployment.md](deployment.md) 和 [.github/workflows/ci.yml](../.github/workflows/ci.yml)；后续阶段沿用，不把源地址写入凭据或运行数据。

### S04

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0` 和 Node 内置 `node:sqlite` 运行 `pnpm verify:S04`，迁移脚本、server build、15 个单测、lint、typecheck、文档检查及构建产物迁移文件均通过。`tests/storage/storage.test.ts` 使用真实临时 SQLite 文件覆盖 WAL / foreign key / synchronous / busy timeout、重复启动、按 Session 分配连续 seq、`workerEpoch + batchNo` 幂等及冲突、迟写失败全事务回滚、正常与 partial 封存、无 Run interaction / custom / Bash、SDK 输入附件恢复、固定 `atSeq` 历史分页与 cursor 防篡改、同 owner 跨 Session 因果及跨 owner 拒绝、Session live projection 和 artifact 相对路径校验。报告写入 `test-results/s04/report.json`（该目录不提交）。

S04 的标题同步已先落下 durable metadataSync 水位；source/echo intent 的真实手机与 SDK hook 交错路径由 S07 接续验证。artifact 本阶段验证元数据和路径安全，原子大文件封存与下载授权由后续 artifact API 阶段完成。

### S05

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0` 和固定 SDK `0.85.1` 运行 `pnpm verify:S05`，S05 文件检查、server build、18 个单测、lint、全量 typecheck 和文档检查均通过。`apps/server/src/auth.ts` 提供单 owner 配对 token 原子消费、设备摘要凭据、Bearer 鉴权、设备列表 / 吊销和内存限流；`routes.ts` 接入 `/v1/pair`、me、devices、capabilities、models、projects、sessions、snapshot、history、events 和 command 查询。项目注册使用 realpath、允许根、读写权限、dev/inode identity、Git common dir 和 keyset cursor；父子目录可分别注册，symlink 越界被拒绝。项目 / Session 资源变更写入统一 command 收据，事务内再次检查幂等键，PATCH 使用 expectedVersion，Session 元数据更新通过 `session.updated` 事件持久化；归档只改元数据，重开 SQLite 后状态保持一致。报告写入 `test-results/s05/report.json`（该目录不提交）。

S05 的覆盖范围是临时真实 SQLite 文件和 Fastify 注入 API；已验证单次配对、吊销失效、跨 owner 404、路径边界、重复真实目录、父子目录、分页、CAS、归档 / snapshot / history / events、重启恢复及并发同键创建。真实 HTTPS / WSS、worker 执行、模型、设备和 artifact 下载仍由后续阶段验证；未实现的执行命令没有在 capabilities 中宣称可用。

### S06

实现 `apps/server/src/runtime/{ipc,scheduler,recovery,manager}.ts` 与 `packages/agent-pi/src/worker.ts`：worker 使用独立 Node 进程、固定 cwd、workerEpoch、映射 ACK、ready / fatal / stopped、心跳、事件 batch ACK；主进程提供同 Session 单 Run、不同 Session 默认并行、可选工作区串行 / 容量 / 空闲回收、单实例锁和旧 epoch 防写。恢复先检查 `target_run_id`，区分 IPC 前的 `STALE_RUNTIME` 与分派后的 `UNKNOWN_RUNTIME`，封存活动 Run、关闭失效交互并暂停已有后续项，不自动重投未知命令；同时覆盖首次映射的 `uninitialized` / `unflushed` / `persisted` 状态和合法 header-only / 非 assistant 历史。

在 WSL 2 Linux 使用 Node `v24.19.0`、pnpm `10.28.0`、固定 SDK `0.85.1`，并将 npm / Docker 配置分别设为 `https://registry.npmmirror.com` / `docker.m.daocloud.io`，运行 `pnpm verify:S06`：6 个文件检查、server build、15 个 runtime 测试、lint、全量 typecheck 和文档检查均通过，报告为 `test-results/s06/report.json`（默认不提交）。测试覆盖 IPC framing / ACK、映射边界、同目录 Session 并行、调度选项、活动调用与待答保护、worker 崩溃恢复、旧 target prompt stale、未知分派结果、旧 epoch、陈旧锁及单实例锁。

S06 报告状态为 `blocked`：AT31 / AT32 的真实 provider、原生 pi TUI 和真实 SIGKILL / Bash 进程组对照尚未提供，不能用合成测试替代。为保持 WSL 工具链可复现，本次 Node 与 pnpm Linux 二进制均从 npmmirror 获取；验收脚本同时修正了 Windows Node interop 下的 Python 命令选择。下一步是 S07 命令与交互桥接，并继续保留这些真实对照为未运行。

### S07

实现 `apps/server/src/services/commands.ts`、`apps/server/src/runtime/manager.ts` 与 `packages/agent-pi/src/worker.ts` 的命令 / 控制 / 交互桥接：空闲 prompt、steer / follow-up、持久 follow-up 队列、targeted abort / respond、配置 CAS 与实际配置回传、原生扩展命令、Bash / user_bash、compact 的先停止路径，以及 initialize / configure / run / bash / extension 五类 Operation 的 select / confirm / input / editor 表单。worker 用 `AsyncLocalStorage` 保留 operationId、runId、origin 和 workerEpoch 归属；异步 thinking hook 不会因方法返回而提前结束 configure Operation。命令终态投影和后续 `command_result` 幂等合并，控制命令不会误结束目标模型 Run；排队 Run 与当前执行 Run 可并存。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0`、固定 SDK `0.85.1`，并沿用 npm `https://registry.npmmirror.com`、Docker 镜像前缀 `docker.m.daocloud.io`，运行 `pnpm verify:S07`：S07 文件检查、server build、命令合同测试、交互合同测试、lint、全量 typecheck 和文档检查均记录到 `test-results/s07/report.json`（默认不提交）。当前合同测试覆盖 4 个命令场景与 23 个交互场景；全仓单测结果为 7 个测试文件、60 个测试通过。测试包含重复 prompt / follow-up / form answer、配置版本和实际 clamp、旧 targetRun 控制、队列取消 / pump、四种表单、空 Run Operation、取消 / 超时 / 重复回答及 setThinkingLevel 异步 hook。

S07 报告状态为 `blocked`：可重复测试使用 fake SDK handle / worker transport，只证明应用契约与归属边界，不等于真实模型 streaming、原生 pi TUI、真实 compact / extension / abort 对照。`pnpm test:live -- --suite commands` 与 `pnpm test:tui-parity -- --target commands` 因缺少运营者模型配置和真实 Linux TUI baseline 保持 `not_run`，不能伪造为通过；真实 Bash / 进程组故障对照仍由 S06 / S12 继续完成。下一步是 S08 WSS、断线回放与大输出。

### S08

实现 `apps/server/src/realtime/{hub,tickets,artifacts}.ts` 与 `scripts/test-serve.mjs`：HTTPS / WSS 入口使用一次性 HTTP ticket 和 `pi-remote.v1` 子协议，订阅按 Session 校验，基于已提交 seq 回放并继续 tail；断线从 cursor 补读，过高 cursor、设备吊销、慢消费者和 4 MiB 缓冲上限都有明确处理。大输出保留有界展示副本并支持 artifact Range 下载，不能借展示配额修改 SDK 原始输出。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0`，并沿用 npm `https://registry.npmmirror.com`、Docker 镜像前缀 `docker.m.daocloud.io`，运行 `pnpm verify:S08`：WSS 合同测试、HTTPS 自签名 TLS `/healthz` smoke、server / mobile 全构建、lint、全仓 typecheck 和文档检查通过，报告写入 `test-results/s08/report.json`（默认不提交）。HTTPS smoke 在 WSL 冷启动时会等待 SDK ESM 导入完成；验证脚本已将启动窗口设为 60 秒并直接管理实际 server 子进程，避免 pnpm wrapper 留下孤儿进程。

S08 报告状态为 `blocked`：确定性 WSS / artifact 测试不替代真实 provider streaming；`pnpm test:live -- --suite realtime` 和 `pnpm test:tui-parity -- --target realtime` 为 `not_run`，因为没有运营者模型凭据和真实 Linux pi TUI baseline。设备吊销、cursor 回放和 HTTPS 入口已具备 S09/S11 使用的基础，但真实手机链路留在后续设备阶段。

### S09

实现 `apps/mobile/App.tsx` 及 `apps/mobile/src/{api,storage,app-model}`：配对页严格要求 HTTPS，设备凭据通过 Expo SecureStore 进入 Keychain / Keystore；项目与 Session 页面使用真实协议 DTO，支持分页、去重、新建、改名、归档 / 恢复；历史页先读取 snapshot，再按 cursor 加载历史。Expo SQLite 使用 WAL 和 `(account_key, resource_key)` 复合隔离键，在同一事务中保存 payload 与 cursor，断网时只展示已有缓存，不伪造运行状态。补充 `tests/mobile`、Expo SQLite web WASM Metro 配置和 `.maestro/s09-resources.yaml`。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0`，运行 `pnpm verify:S09`：13 个移动端合同 / view-model / SQLite 测试、协议构建、Android / iOS JS bundle、lint、全仓 typecheck 和文档检查通过，报告写入 `test-results/s09/report.json`（默认不提交）。另验证 `pnpm run build:mobile` 的 Android / iOS / web export；web 导出包含 Expo SQLite WASM 资产。

S09 报告状态为 `blocked`：当前 WSL 没有 `adb`、Android 模拟器、Maestro 或 Xcode / iOS 模拟器，因此真实资源 API 的配对→列表→改名→归档 / 恢复流程为 `not_run`。JS bundle 与 fake fetch 测试不能替代 AT21 / AT22 的真实设备证据；下一步应在可用 Android 模拟器或真机上运行 Maestro 流程，再补 iOS Keychain / 后台恢复。

### S10

实现 `apps/mobile/src/realtime.ts`、`apps/mobile/src/session-model.ts` 及执行页面：移动端通过 HTTPS 换取一次性 WSS ticket，使用 `pi-remote.v1` 订阅指定 Session；按持久 cursor 去重，缺口或 `resync_required` 先刷新快照，断线采用 1–30 秒有界抖动退避，AppState 回到前台立即重连。事件只有在 reducer / 本地快照缓存回调完成后才推进 cursor，缓存继续以账号隔离并原子保存 payload/cursor。

执行页接入共享 reducer，合并历史、snapshot 与 liveItems，分块显示文本 / thinking、累计工具输出、工具参数、partial / unknown / 截断状态和 Operation / Run 归属；提供模型 / thinking 配置、compact、新建 / 改名 / 归档、prompt / steer / follow-up、用户 Bash、扩展 slash、模型停止、Bash 停止、队列逐项取消 / 恢复和 initialize / configure / run / bash / extension 的 select / confirm / input / editor 表单。HTTP 命令响应丢失时用同一幂等键自动重试；恢复输入只填回草稿，不自动重放。附件现在通过 Expo 系统文件选择器选择图片，经 `POST /v1/sessions/:id/artifacts` 上传并绑定当前 Session 后再提交；已有 artifact ID 的兼容入口仍保留。真机仍需验证权限、弱网和后台恢复。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0` 运行 `pnpm verify:S10`：18 个移动端测试、协议构建、Android / iOS JS bundle、lint、全量 typecheck 和文档检查通过；报告为 `test-results/s10/report.json`（默认不提交）。报告中 S10 Android / iOS 设备检查为 `not_run`，因为当前 WSL 没有可用的 Android 设备 / 模拟器或 Xcode / iOS 模拟器；fake WebSocket、JS export 和合同测试不替代真实 provider 或设备证据，因此阶段保持 `blocked`。下一步是 S11 的真实双端弱网、后台恢复与 Linux 进程故障闭环；S12 Docker 工作可独立推进。

### S11

实现 `tests/e2e/{harness,s11-weak-network,s11-recovery,s11-dual-device}`、`scripts/test-device.mjs`、`scripts/verify-s11.mjs` 及 `.maestro/s11-recovery-{android,ios}.yaml`。最初夹具使用临时真实 SQLite、Fastify/WSS、确定性移动 WebSocket 和 Linux timer 替身进程 `SIGKILL`，恢复状态由测试构造；该版本只能证明恢复投影合同，不能证明实际应用进程恢复。2026-09-15 已移除 timer 替身，另外增加实际 server/worker 集成，见下方修复记录；生产服务没有增加远程 kill 或调试清理接口。覆盖重复 frame、seq 缺口 snapshot resync、缓存丢失、AppState 前后台重连、worker / 主进程故障后的 interrupted / partial / unknown、待答关闭、草稿保留、旧队列暂停、新操作继续、HTTP 响应丢失幂等、双设备事件流、CAS 改名、WSS 回放和设备吊销。

在 WSL Linux 使用 Node `v24.19.0`、pnpm `10.28.0`，并沿用 npm `https://registry.npmmirror.com`、Docker 镜像前缀 `docker.m.daocloud.io`，运行 `pnpm verify:S11`：文件检查、协议 / server build、4 个 E2E 测试、Android / iOS JavaScript bundle、lint、全量 typecheck 和文档检查通过。`pnpm test:device -- --platform android` 与 `pnpm test:device -- --platform ios` 均诚实记录为 `not_run`：当前没有真实设备流程配置，且 WSL 没有可用 Android / iOS 设备；不会把缺失设备转换成通过。清洗报告写入 `test-results/s11/report.json`（默认不提交）。

设备 runner 仅在检测到 Maestro、已授权在线 Android 设备或已启动 iOS Simulator、设备可访问的 HTTPS 后端、一次性配对令牌和合成 prompt / steer 后执行对应 Maestro 流程；网络切换、锁屏和 Linux 故障注入保留为真实设备流程中的人工观察点，失败或前置条件不足均保留原状态。该阶段原始报告的“Linux 进程”结果应按上述合同范围理解；真实应用进程证据由 2026-09-15 补充，真实双端证据仍待具备设备后补充；下一步为 S12 Docker 与可运维交付。

### S12

实现 `deploy/Dockerfile`、`deploy/compose.yaml`、TLS Caddy 入口、非 root Linux 工具链、部署初始化 / doctor / pair / maintenance / backup / restore CLI，以及状态卷和项目挂载的权限约定。服务的单实例锁由 `/state/instance.lock.sqlite` 上持有的 SQLite `BEGIN EXCLUSIVE` 事务保证，`/state/instance.lock` 仅保留 PID / 启动时间诊断信息，因此跨 Docker PID namespace 的备份也能可靠拒绝运行中的 app；空恢复卷不会被锁检查提前创建 sidecar。宿主机 bind-mounted 状态根目录不由启动初始化强制 `chmod`，避免 Docker Desktop / WSL 的挂载权限错误，权限仍由部署者设置并可由 doctor 检查。

在 WSL 2 Linux 使用 Node `v24.19.0`、pnpm `10.28.0`，npm registry 为 `https://registry.npmmirror.com`、Docker Hub 镜像前缀为 `docker.m.daocloud.io`，运行 `pnpm verify:S12`：30/30 检查通过。覆盖 server build、部署单测、lint、全量 typecheck、文档检查、Docker Compose 配置、实际镜像构建、HTTP health、Caddy HTTPS/WSS 入口、非 root / init / stop timeout / restart 策略、Git/bash/Node/Python/sqlite3 工具链、容器写入宿主项目、HTTP 配对、Session 持久化、app 重建、运行中备份拒绝、停机备份 manifest + SHA-256、空状态 bind mount 恢复，以及恢复服务读取旧设备凭据和旧 Session。详细清洗报告为 `test-results/s12/report.json`（不提交）。

首次 Docker 回归发现并修复两项真实问题：PID-only 锁无法跨容器识别运行实例；恢复到宿主机 bind-mounted 状态根目录时 `chmod` 被 Docker Desktop 拒绝。修复后完整 S12 报告为 `passed`。现有其他项目容器未被操作；S13 仍需真实 provider、Android / iOS 实机、完整原生 TUI 对照和最终发布验收。

## 2026-09-17 持续运行与 Docker 复核

本轮完成事件可靠性收尾：worker 的磁盘 backlog 使用 ACK lease，事件批次在父进程完成 EventStore / reducer 提交并成功写回 `batch_ack` 前不删除；未确认批次在 worker 重启后可恢复。大于 IPC 帧上限的 transport spool 文件也延迟到事件 ACK 后清理；服务启动只清理超过 60 秒的 `.tmp` 原子写临时文件，未确认的 JSON 输出保留，避免用 TTL 造成数据丢失。回归覆盖 ACK 前保留、ACK 后清理、未确认恢复、manager 级大帧提交和临时文件清理。

新增 R15 有界长运行测试：8 个 Session 连续 120 轮、共提交 960 个事件；最新一次 WSL 运行 event-loop turn p95 为 6.01 ms，RSS 增长约 61.2 MiB，所有 Session 的 live projection 与 seq 均一致。全量测试当前为 25 个文件 / 180 个测试通过。

重新核对 Docker：`exciting_blackburn` 与 `dreamy_perlman` 使用 `pi-remote:s12-debug` 正在运行且 `/healthz` 返回 200，但两者均没有宿主机端口、项目挂载或状态卷，`docker compose -f deploy/compose.yaml ps --all` 也为空。因此它们不能作为手机可访问的持久化 Compose 部署证据；S12 的可连接入口仍以独立命名的 Compose 生命周期验证为准，不能把现有手工容器冒充为该证据。现有容器未停止、删除或改动。

最终汇总 `pnpm verify:S13`：19 项检查中 8 项通过、11 项因真实 provider / 原生 TUI / Android / iOS 前置条件缺失而 `not_run`，阶段保持 `blocked`；本地真实 server/worker E2E 9/9 和确定性 Bash smoke 已通过。当时将剩余工作概括为外部环境验收不够准确；2026-09-18 核对发现 runner、证据汇总及终端专属 UI 适配仍有实现工作，见下方修订。

用户反馈后再次核对实际 Docker 状态：Docker Desktop / WSL 引擎中确有一套 `deploy-api/web/postgres` 正在运行，但其 Compose 标签指向另一份旧 `lingjian` 项目，不是本仓库的 `pi-remote`；该套旧容器保持未操作。随后使用当前仓库的 `docker compose --env-file .env.example --file deploy/compose.yaml build app` 与 `up -d` 启动正式 Compose，镜像构建使用 `docker.m.daocloud.io`、`registry.npmmirror.com`，`pi-remote-app-1` 健康、`pi-remote-gateway-1` 运行，HTTP `:8080/healthz` 和 HTTPS `:8443/healthz` 均返回 200。实际 inspect 确认 app 为 `1000:1000` 非 root、`unless-stopped`、init、45 秒停止宽限，挂载持久 `/state` 卷和 `.local/workspaces`；app 内 `doctor` 为 `passed`，仅因当前未注入真实模型目录 / 凭据而给出 warning / not_run。此次使用 `.env.example` 的开发默认值，仅证明当前仓库 Compose 可启动，不替代有效域名证书、真实 provider 或手机验收。

## 本次设计交付的检查

初稿 [29e8026](https://github.com/cynos-ai/pi-remote/commit/29e80269e47fe2a8e93f722ab7184b439580af68) 的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34687052151)。

2026-09-12 评审修订轮，在 Windows、Python 3.12.8、SQLite 3.45.3 上执行 `python scripts/check_docs.py` 与 `git diff --check`，均通过：10 份 Markdown 及链接 / 表格，13 个阶段，12 条需求，30 个验收场景及双向阶段归属，47 个合成事件，12 张 SQLite 参考表及完整性约束，MIT 许可证。

独立代理针对修订后的 R1–R7 复核，未发现剩余阻断项；非阻断的最终命令结果存储建议也已补入 result_json。应用实现与实际 SDK / Docker / 设备验证仍未运行，不能把这次文档复核当作运行时验收。

GitHub Actions 中同一脚本在 Linux 上运行，实际结果以仓库的 Documentation checks 为准。该检查不加载 pi、不调用模型、不启动 Docker、不构建手机 App；这段历史记录对应当时尚未开始应用阶段的状态，当前 S07 已有单独运行证据。

## Bash 兼容要求修订（历史轮次）

2026-09-12，用户明确要求服务器 pi 保留与本地 TUI 相似的 Bash 使用体验。基于[上轮提交 c306439](https://github.com/cynos-ai/pi-remote/commit/c3064390322281f17cf7af1c606c2f84dd24ddcc)修订；上轮的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34688951963)。本次不沿用独立代理对旧版本的复核结论。

设计变化：默认原生 Bash、无额外命令过滤 / 审批 / 默认超时，正常后台服务可跨 Run、归档与空闲 worker 回收；前台调度串行不再被表述为整个目录只有一个 OS writer。工具错误交由 pi 继续处理，手机展示配额不改变模型结果或原生输出文件。整容器恢复只用于未完成调用结果不明的故障。

已核对固定 SDK 的 Bash、waitForChildProcess、shell 环境及活动 PID 跟踪源码；未执行 SDK / TUI / Docker / 真机兼容测试。新增 AT31 在 S02、S06、S08、S10、S12 分别验基线、生命周期、输出、手机与部署，S13 必须纳入最终验收。

Windows 本地 `python scripts/check_docs.py` 与 `git diff --check` 通过：11 份 Markdown，13 个阶段，13 条需求，31 个验收场景，8 个 Bash/TUI 对照场景，47 个合成事件及 12 张 SQLite 参考表。设计数据结构和核心事件类型未改变，沿用现有 SQL / 合成事件检查；这些结果不代表 FR13 已实现。

## 整体 TUI 体验修订

2026-09-12，用户进一步明确 Bash 只是例子，整个产品应接近本地 TUI，后续遇到真实问题再考虑限制。本轮基于 [65d5b4d](https://github.com/cynos-ai/pi-remote/commit/65d5b4df50cab9b43eaa1974aae8adbe36742797)；该基线的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34690428411)，不是本轮的测试结果。

本轮恢复原生资源默认加载、streaming 中配置 / 扩展命令、先停止再压缩、全阶段可答表单；归档仅改列表，多 Session 默认并行，无额外容量上限及默认空闲回收。旧后续队列暂停不锁新操作，空队列 ready。删除强制 host-control / restart-clean、blocked_scope_key 及容器清理证明，撤回额外 Docker 权限收紧；未知旧命令不自动重投，实际故障按具体问题处理。此前历史评审中的 R4 / R5 / R7 处置按本轮原则替换。

新增 Operation 事件投影与可空 Run 的 Interaction、初始化表单合成示例；同步 SQL 关联约束、协议、开发步骤、FR14 / AT32 和 T01–T08。Operation 保存在现有事件和 live_state 投影中，不增加数据库服务或新表。S02 建立原生能力清单并安排缺失的适配，S06 / S07 / S10 / S12 分别验运行、控制、手机及部署，S13 纳入整体对照。

已核对固定 SDK 的 prompt 扩展命令路径、setModel / setThinkingLevel、compact 及 DefaultResourceLoader / AgentSessionRuntime / SettingsManager 文档；源码核对不等于 SDK 实测。本轮独立设计评审未重新运行；应用、真实 SDK、Docker 和设备验证仍未运行。

Windows 本地使用 Python 3.12.8 / SQLite 3.45.3 执行 `python scripts/check_docs.py` 与 `git diff --check`，均通过：12 份 Markdown，13 个阶段，14 条需求，32 个验收场景及双向阶段映射，8 项 Bash + 8 项整体 TUI 对照，59 个合成事件及 12 张 SQLite 参考表。检查包含 Run / Operation 生命周期、无 Run 初始化表单、非空 / 空队列差异、同项目 Session 并行及交互的同 Session 外键；这些结果不代表应用运行时验收通过。本轮提交的 Linux 结果以对应 GitHub Actions 为准。

## 按新宗旨的独立审核与修订

2026-09-12，按用户要求重新独立审核，基线为 [cf02e91](https://github.com/cynos-ai/pi-remote/commit/cf02e916a148b8125144f6408ccbd81d58b71a8d)，其 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34692163097)。本次新代理不继承旧审核上下文，发现 3 项 P1 和 3 项 P2；详见[独立审核记录](reviews/2026-09-12-tui-principle-review.md)。

修订支持 Operation 归属的无 Run 内容、custom / 用户 Bash、自主 Run 及一命令多 Run、stop 清取完整未消费草稿、旧 target_run_id 优先恢复分类、双向标题和合法 header-only / 非 assistant 历史。补上同 owner 跨 Session 因果、原生 fork / import 先写文件窗口、延迟消息及异步 hook 的独立生命周期，没有增加工具过滤或默认禁用。

Windows 本地 Python 3.12.8 / SQLite 3.45.3 的 `python scripts/check_docs.py` 与 `git diff --check` 已通过：14 份 Markdown、13 个阶段、14 条需求、32 个验收项、8 项 Bash + 8 项整体 TUI 对照、135 条合成事件及 12 张参考表。检查覆盖允许的 Run 因果形状、无 Run 时间线、唯一 Operation、保留的定向 FK 以及合成内容 / 输入恢复；不等于真实 SDK 队列、标题算法或跨 owner 业务校验已实现。

独立代理已复查实际工作树，确认 N1–N6 均已在契约层面修订，未发现剩余阻断项；包括三处衔接问题及异步 hook。最终结论见本轮审核记录，本轮提交的 Linux 检查以对应 Documentation checks 为准。该段为 2026-09-12 审核时的历史状态；此后 S06 已实现，S07 的当前状态见上方表格与 S07 报告。live SDK、Linux 进程、Docker 或手机验证仍按各阶段记录为未运行。

## 后续阶段证据模板

```text
stage: Sxx
status: in_progress | passed | blocked
commit: <实现提交>
environment: <OS / Node / SDK / 设备 / 镜像版本>
commands: <实际运行命令，删除凭据>
results: <通过 / 失败 / not_run 数量与说明>
evidence: <清洗后的报告、日志摘要、截图路径或 CI 链接>
remaining: <尚未验证的内容及原因>
decisions: <对既有设计的必要修正及依据>
next: <下一阶段>
```

本地运行生成的详细报告放 `test-results/`（默认不提交）；只将清洗后的摘要、必要截图和可公开访问的 CI 证据纳入交接。

## 2026-09-22 custom renderer 文本投影

完成 `registerMessageRenderer` / `registerEntryRenderer` 的远程显示适配。renderer 继续只在固定 pi SDK `0.85.1` 的 worker 内执行，使用 SDK dark theme、原生 outputPad 和当前工具展开状态渲染为 80 列纯文本；公共协议只保存 `lines / expanded / width / truncated / failed`，不传函数、Component 或回调。custom message 保留原模型上下文 blocks，renderer 缺失、undefined、异常和 `display:false` 沿原生回退 / 隐藏语义；custom entry 作为不进入模型上下文的 `custom_entry.appended` 独立封存。移动历史与执行页均标注“终端 renderer 文本投影”，snapshot、历史分页和重连恢复同一持久结果。

投影限制为 256 行且总计 32768 字；协议再次验证总量，worker 对超长输出明确标记 truncated。SQLite `user_version` 保持 1：新库允许 `timeline_items.kind=custom_entry`，既有 v1 数据库通过 savepoint 原位重建 CHECK、复制历史并恢复索引；启用 foreign key 的升级回归证明旧行保留且新 kind 可写。能力清单将 `extension.custom-renderers` 更新为 `available / contract_smoke`；任意终端组件、颜色、主题、终端图片、动态视口、跨 custom 共享焦点以及真实设备像素对照仍属于 `tui.terminal-components` 或外部验收，不因此宣称完整 TUI 已通过。

验证环境：WSL Linux、Node 24.19.0、pnpm 10.28.0、pi SDK 0.85.1；扩展测试使用临时 agentDir、合成鉴权且不调用付费模型。

- renderer 聚焦回归：协议、真实 SDK worker 扩展、移动 view-model、SQLite 共 4 个文件 / 39 个测试通过；覆盖成功、undefined、抛错、隐藏、展开 / outputPad、截断、custom entry 非模型归属、snapshot 重放与 v1 升级。
- `pnpm test:unit`：40 个文件 / 279 个测试全部通过。
- `pnpm build:server`、`pnpm lint`、`pnpm typecheck`、`python3 scripts/check_docs.py`：通过；文档检查为 23 个 Markdown、13 阶段、14 FR、32 AT、135 个合成事件和 12 张 SQLite 参考表。
- `pnpm verify:S07`：14 passed / 2 failed；实现、server build、命令合同、原生表单 / Session 进程、lint、typecheck 和 docs 通过。`live-commands`、`parity-tui-commands` 仍因报告源码身份过期失败，本轮没有真实 provider / TUI 配置可重采，未改成 skip 或成功。
- `pnpm verify:S10`：17 passed / 2 not_run；Android / iOS JavaScript 构建、移动合同、lint、typecheck 和 docs 通过。Android 设备 / 模拟器与 Xcode / iOS Simulator 不可用，两个设备项保持 not_run。

本节点提交信息为 `feat: project custom renderers to mobile`，完成后推送 `cynos-ai/pi-remote` 的 `main`。仍未运行真实 provider、交互式原生 TUI、Android / iOS 真机及完整 Docker 组合验收。

## 2026-09-22 V1 常用移动流程范围收口

用户明确 V1 不复刻完整 TUI，以手机常用功能可直接完成为目标。FR14 / AT32 / T01–T08 现按原生工具与 Bash、输入和队列、模型/思考/压缩、Session 管理、图片、标准扩展交互、常用 slash 命令及断线恢复验收。终端像素排版、跨 custom 实例共享终端焦点、聊天区域清屏/重绘、完整主题、硬件光标、全屏/滚动区和所有低频 TUI 快捷键列为非目标，不再阻塞 S13。

能力清单删除过宽的 `tui.terminal-components: needs_adapter`，改为已完成的 `ui.mobile-touch-projections: available / contract_smoke`。其含义限于有界文本投影、触控操作、标准表单及直接手机入口，不宣称完整终端模拟。S02 校验改为要求十项常用流程能力全部存在且没有范围内 `needs_adapter`；手机不再因终端专属视觉效果显示全局未完成警告。完整终端非目标不能用于关闭扩展、工具或标准交互。

本节点只调整范围、能力元数据、验收和验证入口，不修改协议事件、状态机或 SQLite schema。Windows、Node 24.19.0、pnpm 10.28.0 的验证结果：文档检查通过（23 个 Markdown、13 阶段、14 FR、32 AT、8 项 Bash + 8 项常用移动流程、135 个合成事件、12 张表）；全仓 typecheck 与 lint 通过；`pnpm verify:S02` 为 10 passed / 3 failed，其中新能力清单通过，失败仍是 live-sdk、parity-bash-sdk、parity-tui-sdk 报告源码身份过期，未改成 skip 或成功。

额外 Windows 全量单测为 265/279 通过。14 项失败集中在目录 `fsync` 的 EPERM、创建符号链接权限、Windows 绝对路径 staging 及其派生的 artifact/backlog 流程；这些测试以 Linux 为交付环境，本节点没有放宽断言或据此覆盖此前 WSL 40 文件 / 279 项通过的证据。真实 provider 剩余流程、当前源码 Docker/升级/恢复复验及 Android/iOS 真机仍未完成。

## 2026-09-22 常用手机流程收口

手机执行页修复三个实际入口缺口。活动 Run 出现时，普通输入自动切为 steer，并可显式改成 follow-up；Run 结束后恢复 prompt，避免默认普通 prompt 在活动期走到 busy/错误路径。统一输入现在识别 `/`，按名称或中文说明搜索全部 23 个托管内置命令，点击填入后通过 extension_command 执行；自定义扩展命令继续可直接输入，带附件的 slash 会在本地明确拒绝而不丢附件或误投模型。

历史页和实时执行页为工具输出、助手文本、thinking、工具参数及用户 Bash 的 artifactId 增加按需文本预览。客户端带设备鉴权和 `Range: bytes=0-65535` 请求，只读取最多 64 KiB；服务器仍有后续字节时明确提示，不自动下载大文件。失败保留已持久化的展示副本并可重试。协议 schema、数据库和服务端 artifact 归属规则未改变。

验证环境：Windows、Node 24.19.0、pnpm 10.28.0。手机 view-model / API 定向测试 2 文件 14 项通过，覆盖运行态输入模式、slash 名称/说明搜索、鉴权 Range 与截断标记；全仓 typecheck 与 lint 通过。首次 `pnpm verify:S10` 暴露持久命令测试用 POSIX shell 写 Windows 临时路径时未产生副作用文件，改为独立 Node 子进程执行同一真实文件副作用后，定向持久命令测试 8/8 通过。最终 `pnpm verify:S10` 为 17 passed / 2 not_run，移动合同共 9 文件 41 项、协议构建、Android/iOS JavaScript 构建、lint、typecheck 和 docs 均通过；Android 设备/模拟器和 Xcode/iOS Simulator 不可用，两个设备项保持 not_run，阶段状态为 blocked。报告位于 `test-results/s10/report.json`（默认不提交）。

## 2026-09-22 部署与恢复闭环复验

增强 `verify:S12 -- --deployment-only`，把此前只创建 SQLite 项目/Session 的容器生命周期扩展为实际运行 doctor、上传并读取受鉴权 artifact、保存 pi JSONL，并在强制重建 app、正常 stop/up、停机备份及新状态卷恢复后逐项读取原设备凭据、Session、artifact 和 JSONL。另纳入稳定 v1 数据库对 `custom_entry` 约束的原位升级测试，以及真实 Linux 主服务/SDK worker 会话进程恢复测试；后者覆盖会话替换映射窗口的 SIGKILL、持久历史恢复及不自动重放交付不明命令。验收仍使用一次性 Compose 项目、状态卷和工作区，结束后确认无 S12 临时容器残留。

最终在 WSL 2、Node 24.19.0、pnpm 10.28.0、Docker 28.3.3 中从锁文件建立独立 Linux 依赖目录，`pnpm verify:S12 -- --deployment-only` 为 34 passed / 0 failed / 0 not_run。服务器构建、部署/迁移/worker 测试、lint、typecheck、docs、镜像构建、HTTP/HTTPS、非 root 工具链、配对、doctor、持久化、备份与新卷恢复全部通过，报告位于 `test-results/s12-deployment-only/report.json`（默认不提交）。首次直接复用 Windows `node_modules` 的 WSL 运行因缺少 Linux Rolldown binding 失败，隔离依赖后通过；第一次新增 artifact 检查因验收脚本按 text/plain 而非二进制上传返回 400，改为与客户端相同的 octet-stream Buffer 后最终通过。完整 S12 的真实 Bash/TUI Docker 对照、真实 provider 和 Android/iOS 真机仍是独立外部验收，本节点没有用 deployment-only 结果替代。

## 2026-09-22 当前提交真实 DeepSeek 常用链路复验

在提交 `ae57e78`、WSL 2、Node 24.19.0、SDK 0.85.1 上，从 Git 忽略的 `.env` 和专用 agent 目录运行 DeepSeek 单模型有界验收。`live-sdk` 首次普通工具读写通过、thinking 步骤失败且只保存脱敏失败分类；按约定仅重试一次后，AT02 工具读写、`AUTO-SDK-thinking-single` 和汇总 3 项通过，AT03 第二模型、真实重试/settle 及长时间开发 3 项 not_run，报告状态 blocked。`live-commands` 的真实工具往返/同键幂等和空闲配置 2 项通过、完整命令矩阵 6 项 not_run；`live-realtime` 的流式工具和断线 cursor 回放/SQLite 一致性 2 项通过、snapshot 竞态、慢连接 artifact 和设备吊销 3 项 not_run。两份报告均为 blocked 且无 failed。

模型请求名仍为 `deepseek-v4-flash`，按供应商当前映射实际服务为 V4.1-Flash。本轮没有把单模型 thinking smoke 计为 AT03，没有重跑高操作数 controls/compact/configuration/defaults，也没有生成 Bash/TUI 人工对照或设备证据。临时 Linux checkout、专用会话和模型产物已清理；仓库只保留 Git 忽略的脱敏机器报告。

随后为当前源码重新生成五类 target 的 Bash/TUI 证据清单；没有运营者双端采集的 80 项均保持 not_run。`pnpm verify:S02` 最终为 10 passed / 3 not_run / 0 failed：SDK 合同、固定版本、构建和常用能力清单通过，live-sdk 完整矩阵、SDK Bash 对照及 SDK 常用 TUI 行为对照保持 blocked。该结果确认当前报告不再因旧源码指纹失败，但不表示外部验收已经完成。
