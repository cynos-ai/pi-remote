# 远程编辑器命令与快捷键状态

适用固定 pi SDK 0.85.1 的托管 CustomEditor。这里描述编辑器入口，不把后端 SDK 已有能力等同于手机入口已完成。手机统一输入识别 `/`，并提供下列 23 个托管命令的名称/说明搜索；自定义扩展命令仍可直接输入。运行时 `/hotkeys` 展示当前编辑器实际加载的键位和这份能力清单对应的提示。

## 已接入入口

| 命令 | 行为与边界 |
| --- | --- |
| `/session` | 当前原生会话统计、消息/工具数量、token、模型费用分组及缓存重复计费信息；分页显示，不生成模型消息 |
| `/name [标题]` | 查看当前标题或通过 SDK 修改；原生事件同步手机标题 |
| `/copy` | 显示最后助手文本供手机选择复制；不操作服务器剪贴板、不提交编辑结果；超过 32768 字符明确提示展示上限，可导出完整内容 |
| `/export [路径]` | 原生 HTML 默认导出，`.jsonl` 后缀导出当前分支 JSONL；支持原生引号路径；文件在服务端，未上传或公开分享 |
| `/changelog` | 固定 SDK 更新记录，可滚动和翻页查看完整文本 |
| `/hotkeys` | 当前编辑器加载的原生键位及已接入/待接入命令；原生键位存在不意味着对应远程动作均可用 |
| `/compact [说明]` | 原生手动压缩，不套用 stop 的清队列行为；空历史、取消和 hook 失败沿 SDK 报错，不自动重试 |
| `/quit` | 退出当前远程编辑器及其待答子菜单，保留草稿；后台模型/Bash 继续，可用手机输入框或由扩展重新打开编辑器 |
| `/settings` | 原生设置菜单；V1 显示/启动项边界见常用移动流程文档 |
| `/model [引用]` | 模型选择与精确引用，原生作用域和 hook |
| `/thinking [等级]` | 当前模型思考等级选择，显式保存默认值 |
| `/scoped-models` | 模型范围、排序和显式保存 |
| `/new` | 经受管映射新建会话 |
| `/resume` | 原生历史选择、重命名和确认删除 |
| `/fork` | 原生用户消息选择，恢复草稿且不自动提交 |
| `/clone` | 沿原生 `fork(leafId, {position: "at"})` 复制当前分支并包含末节点；新映射 ACK 后清草稿，不自动提交 |
| `/import 路径` | 确认后校验完整 JSONL、cwd 与归属，经原生复制后映射原生 ID；缺失 cwd 须显式选择当前 owner 已注册项目，持久修订副本；原输入保留 |
| `/reload` | 按原生条件在非生成/非压缩时重载；清理旧 UI/订阅，加载新资源和键位，允许 shutdown/startup hook 表单正常作答 |
| `/tree` | 原生分支导航、标签、复制和摘要 |
| `/trust` | 原生当前目录/父目录信任菜单，保存到 trust.json；worker 重启后读取决定，当前 runtime、同宿主 cwd 缓存及 `/reload` 保持原状态 |
| `/logout` | 原生 provider 搜索/选择，仅移除保存到 auth.json 的凭据并同步本 worker 模型状态；环境变量、models.json、运行时注入凭据、当前模型选择和活动任务不变 |
| `/login [provider]` | 原生 API key / OAuth 方法与 provider 选择；链接/设备码/通知仅临时显示，秘密表单传递回调，SDK 保存 auth.json |
| `/share` | 选择 GitHub Secret Gist 或已注册的 Radius；检查登录、完整导出原文预览、明确确认后上传固定副本；结果未知不重试 |

信息/复制窗口各自复用正在打开的同类窗口；导出、改名和压缩不合并不同提交。所有入口使用独立 Operation，取消窗口不取消无关 Run。失败保留尚未被用户编辑替换的提交草稿。已开始的压缩仍通过 Esc 或手机控制取消，不因编辑器退出而假称已停止。

## 分享及剩余流程边界

23 个托管内置命令均已有入口；完整原生 TUI 不属于 V1，设备验收仍未完成。`/share` 先选择目标：GitHub 使用服务端 gh 的 github.com 登录与原生 Secret Gist HTML 格式；Radius 使用原生凭据、当前分支 JSONL 和 pi.share 系统提示/工具元数据，以 organization 可见性上传。不会因存在 Radius 凭据而跳过目标选择，不会在失败后自动切换目标。

分享预览展示完整待上传文件原文（HTML 为源码，尚无手机 HTML 浏览器预览），支持分页和首尾导航；关闭预览后仍需独立发布确认。确认列出字节数、SHA-256、可见范围与内容范围，Secret Gist 持链接者可访问，不等同于私有授权。导出一次后固定字节，即使会话继续生成也不替换确认内容；临时导出文件读取后删除，待答副本仅在 worker 内存。已浏览的预览页沿普通 UI 通知持久化，分享内容可能含路径、工具结果、图片和系统提示，使用前需检查。结果返回 Gist/查看链接或 Radius 链接，不自动打开；gh 错误细节不进入事件。上传开始后断线、取消、服务崩溃或响应失败可能留下远端内容，提示先检查账号，不自动重试。关闭编辑器或切换 Session 使未确认表单失效，不上传。未新增协议字段或 SQL migration；使用已有独立 Operation、select/confirm 和 custom.render。

退出登录只读取凭据元数据，未知 provider 以原 ID 展示；取消/关闭编辑器不删除，重复打开复用菜单。删除沿 SDK 原生 15 秒鉴权操作期限及编辑器取消信号，成功后更新本 worker 的模型目录、补全和页脚；其他已加载 worker 的内存状态不在此流程中自动广播刷新。SDK 明确报告“凭据已删除但模型同步失败”时单独提示这一结果，不误报成删除失败或自动重试；鉴权异常原文不写入会话事件。真实 OAuth/provider 与设备仍需独立验收。

API key / OAuth 登录使用带 sensitive 标记的专用 input：命令保存脱敏 HMAC、事件/快照不保存回答，手机只缓存请求标识并在提交/后台清空输入。断线后可重填同一内容确认原请求，不能从离线队列自动恢复秘密。原生 auth.json 仍保存凭据；模型默认选择和目录刷新沿原生语义，错误不暴露 credential/cause。OAuth 的链接、设备码、提示文本/账户选择和通知通过独立 no-store 接口在前台临时显示，结束/取消清除，切后台后重新获取；不会自动打开浏览器。SDK 回调原样传入，不新增公网回调/relay。实现和合成 provider 验证不代表真实 OAuth/provider 或设备流程已完成。

`/trust` 保存成功后提示重启该会话 worker，不自行中断任务。同一 runtime 宿主按 cwd 缓存信任决定，new/fork/resume/import 不重复询问已经决定的 cwd；重启重新读取。首次遇到有需信任资源的目录，先加载用户级扩展，再沿原生优先级处理 project_trust hook、保存决定、全局 always/never/ask 回退与询问。支持当前/父目录持久决定、仅本次决定、取消；拒绝或取消仅跳过原生需信任项目资源，不禁止普通对话或 Bash。hook 可在 SDK handle 和映射建立前使用 select/confirm/input/notify，标准交互支持长等待、重连和幂等。没有需信任资源时沿原生语义可信；自定义 SettingsManager/ResourceLoader 或未提供信任 UI 的底层调用保留调用者原有控制路径。损坏信任文件、保存失败和 hook 错误按原生行为呈现，真实设备对照仍单独验收。

导入的原 cwd 不存在时，确认页明确原路径，再用普通 input 选择当前 owner 已注册项目目录；默认预填当前项目，但仍需用户提交。worker 在受管 session 目录用排他创建生成只改 header.cwd 的副本，完整校验 ID/cwd 后将该路径交给固定 SDK，避免再次复制；副本在映射前已经具有持久 cwd，源 JSONL 字节不变。原 cwd 仍存在时不接受重定位，避免无意改变会话归属；未注册、其他 owner、非目录和无效历史在 SDK 切换前拒绝，负向 intent ACK 使当前 runtime 与草稿继续可用。

主服务在副本写成后、映射前崩溃时不重放未知导入；正确 cwd 的孤立副本可由手机“找回历史”显式认领并续聊。映射已提交但 ACK 前崩溃沿既有目标 Session 恢复。intent 拒绝或原生取消且尚未采用副本时删除该排他创建文件；一旦 runtime 采用，即使 bound 结果未知也保留，不删除活动或可找回历史。重载更新资源，但主题/像素等未接入的远程显示设置仍按原有边界处理。

## 快捷键边界

- 空草稿 Ctrl+D、500ms 内双 Ctrl+C 和 `/quit` 使用相同远程退出行为；非空 Ctrl+D 保留原生向前删除。自定义编辑器自己的处理及补全优先级保留。
- `app.message.copy` 使用 `/copy` 的手机复制窗口，尊重用户重映射；不假称系统剪贴板已写入。
- `app.message.followUp` 在模型生成或压缩时按原生 `streamingBehavior: "followUp"` 排队并清空草稿，空闲时走普通提交；提交失败只在草稿未被后续编辑时恢复。`app.message.dequeue` 原子取回 SDK 的 steering/follow-up，按原生顺序置于当前草稿之前，不自动重发。编辑器自产项没有外部 Command 身份；与持久输入混合时全部文本照常恢复，但无法精确对应的持久 input 标 unknown，不按文本猜身份。
- `app.editor.external` 在手机打开带当前草稿的完整 editor 表单，保存后回填，取消保留原草稿；不会在服务器启动 `$EDITOR`。`app.thinking.toggle` 保存固定 SDK 的 hideThinkingBlock 设置，并通过可重放通知同步手机思考块显示；redacted 内容仍只显示隐藏标签。
- `app.suspend` 已按远程架构收口为“服务端继续运行”的通知动作；不向共享服务或 worker 发送 SIGTSTP。手机切后台不停止服务器任务。
- `app.clipboard.pasteImage` 已接入 image 表单：当前手机选择并上传真实图片 artifact，服务端校验 owner、Session 与 MIME，worker 校验 PNG/JPEG/GIF/WebP 文件签名后作为 SDK ImageContent 附到下一条模型输入。取消不改草稿，提交失败保留图片；不读取服务器剪贴板或使用文本占位符。
- 信息页沿固定导航键上下滚动、Page Up/Down、Home/End、Enter/Esc 关闭；不是原生交互 TUI 排版或共享焦点的完整替代。

验证以 [开发进度](progress.md) 为准。本地合成 provider 的真实进程测试不替代真实模型、原生 TUI 或 Android/iOS 实机验收。
