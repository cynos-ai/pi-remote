# 2026-09-12 独立设计评审与修订记录

评审对象：[初稿提交 29e8026](https://github.com/cynos-ai/pi-remote/commit/29e80269e47fe2a8e93f722ab7184b439580af68)。用户要求独立子代理评审并据此修改一轮；评审代理未参与初稿编写，也未直接编辑文档，主代理逐项核对并落实修订。

范围包括架构、HTTP / WSS / IPC、SQLite / pi JSONL、开发依赖、验收矩阵与 Docker 运维。保留 Linux、Docker Compose、直接加载 pi SDK 的 Node worker、SQLite、React Native / Expo 及单 owner 的既定选择。本轮没有实现应用代码。

后续用户明确要求保留 Bash 与本地 TUI 的体验，现已补入 [Bash 兼容要求](../bash-compatibility.md)。本记录保留当时的评审结论；其中“无第二 writer”“工具清理”现精确定义为未完成调用未知时不自动分派下一前台 Run，不限制已正常返回的后台服务，也不要求每次 Run 后清扫进程或重启容器。此后的兼容修订未冒用本次独立复核结论。

## 评审发现与处置

P1 表示可能静默丢失上下文；P2 表示会导致错误状态、阻塞、重复执行风险或开发阶段无法按顺序完成。以下“已修订”表示文档契约已修改，不代表相应运行时行为已通过测试。

| ID | 优先级 | 原问题 | 本轮处置 | 验证入口 |
| --- | --- | --- | --- | --- |
| R1 | P1 | create 分配路径但空 Session 未必写文件；open 缺失 / 空文件可能静默创建新会话，把历史损坏误当成空初始化 | 已修订：uninitialized / unflushed / persisted；首次落盘前 SQLite 保存已确认配置；映射先获 ACK；重启先认领有效旧文件，损坏 / 缺失持久历史阻断 | S02 / AT02；S06 / AT19；S07 / AT04 |
| R2 | P2 | 幂等查询只在锁外，两个重复请求都 miss 后，后者可能得到 busy、version conflict 或 SQL 错误 | 已修订：锁及事务内先重查幂等，再检查可变状态；唯一键竞态转原收据或 IDEMPOTENCY_CONFLICT | S05、S07 / AT12，使用同步屏障触发真实并发 |
| R3 | P2 | Run 中断后未完成消息 / 工具仍在 liveItems，手机可能一直转圈 | 已修订：run.content_sealed，按 runId 封存 partial 历史；保留片段，工具结果 unknown 且无伪造退出码；与终态、交互关闭和暂停同事务 | S03 / AT06；S04 / AT07、AT08；S06、S11 / AT19 |
| R4 | P2 | 异常任务之后的 follow-up 可能自动运行；重启可能将旧 steer / abort / respond 发给新 worker | 已修订：failed / aborted / interrupted 暂停 Session 队列；queueVersion + 暂停 runId 控制明确恢复；旧控制取消，未分派执行项按暂停状态保留 | S07 / AT15；S06、S11 / AT19 |
| R5 | P2 | session_start / model_select hook 可在无 Run 时请求 UI，但协议要求 runId，可能初始化死等 | 已修订：只桥接 execute 阶段活动 Run；其余阶段立即返回取消值并提示，无 pending Interaction。hook 失败读取实际配置，不声称回滚 setModel | S02 / AT26；S07 / AT04、AT16 |
| R6 | P2 | S11 验容器退出，却依赖尚未实现的 S12；手机测试 TLS 入口也不明确 | 已修订：S08 提供独立 Node 测试 HTTPS / WSS 入口；S11 验 Linux 进程与双端，S12 验 Docker，S13 汇总组合闭环 | AT17、AT19、AT25、AT30；阶段与验收归属双向检查 |
| R7 | P2 | SDK 默认 Bash 已在独立进程组；杀 worker PGID 不能证明工具退出 | 已修订：未知清理持久阻塞工作区；宿主 helper 核验容器与 scope 的预先绑定、实际 stop / wait / inspect、原子清理证据及新 scope；整容器恢复影响其他活动 Run，队列仍暂停 | S02 / AT26；S06、S12 / AT25；S12 / AT19 |

对应契约：[架构](../v1-design.md)、[协议](../protocol-v1.md)、[数据与事务](../data-model.md)、[参考 SQL](../schema-v1.sql)、[开发步骤](../development-plan.md)、[验收矩阵](../acceptance.md)、[部署与清理证明](../deployment.md)。

## R7 的补充独立核对

主代理将清理证明的候选方案单独交给同一评审代理核对。补充意见指出：作用域变化只识别新的执行边界，不能证明旧容器已经停止；尤其第二个容器共用状态卷时，不能凭新的 PID namespace 解锁。

本轮据此增加执行前登记：完整 container ID 与 instanceId / executionScopeKey 的绑定由宿主 Docker inspect 及 /proc 核验。恢复 helper 必须停止绑定的原容器，不能把任意已停止容器的结果当作证据。不增加容器内 Docker socket、签名体系、独立 runner 或跨主机自动接管。

此方案比单纯重启 Node 多一个运维入口，但避免为首版重写全部 Bash 执行器。正常任务和空闲回收不需要此入口；只有清理不明时才阻塞并完整重启 app 容器。该容器的其他活动 Run 也会中断，这是 V1 明确保留的限制。

## SDK 依据

以下依据来自固定 SDK 0.85.1 的 gitHead `d981de1229ef899957bbe968bc8dcda02a21f477`，属于源码核对；实际运行验证仍由 S02 完成。

- [SessionManager](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts)：_setSessionFile 对缺失 / 空文件的行为，newSession 分配路径，_persist 在首次 assistant 之后写入。
- [AgentSession](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts)：bindExtensions 等待 session_start；setModel 修改模型后等待 model_select hook。
- [Bash tool](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/tools/bash.ts)：Linux detached 子进程及正常 abort 的进程树清理。

## 本轮验证与剩余限制

新增[中断与停止的合成事件](../examples/interrupted.json)，包含未完成工具输出、部分文本 / thinking、未完成工具参数和暂停的 follow-up。文档检查增加了 Markdown 表格列数、阶段与 AT 双向归属、partial 封存断言，以及持久状态 / 队列 / 执行作用域 / timeline 外键的参考 SQL 约束检查。

在 Windows、Python 3.12.8、SQLite 3.45.3 上运行 `python scripts/check_docs.py` 和 `git diff --check`。结果记录在 [progress.md](../progress.md)。合成投影检查是设计附件验证，不是未来 S03 reducer 的应用测试。

独立代理已对修订后的 R1–R7 做针对性复核，结论为“此前 R1–R7 已在设计层面闭合，没有发现剩余的阻断性矛盾”。复核另外提出一个非阻断 P3：命令最终 result 的持久化路径应明确。本轮也已补齐 commands.result_json 及其 JSON 约束；最终配置 / 结果独立存储，不覆盖用于幂等重放的初始 response_json。

仍需后续阶段验证：真实 SDK 的文件与 hook 时序、正常 / 强制停止的工具清理、并发命令实现、Docker 恢复 helper、TLS 接入及 Android / iOS 真机。S01–S13 仍全部 not_started。首版仍不承诺 shell 副作用恰好一次、崩溃后原地续跑、跨主机接管、任意 TUI 或公开多租户执行隔离。
