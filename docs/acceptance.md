# V1 验收矩阵

这些是必须实现并运行的验收场景，不是已通过的测试结果。阶段完成情况见 [progress.md](progress.md)，实施入口见 [development-plan.md](development-plan.md)。FR 对应 [产品需求](v1-design.md)。

## 环境与证据

- contract：不依赖模型的协议与 reducer 测试。
- linux：真实 Linux 文件、SQLite、Node 子进程及网络客户端。
- live：固定 pi SDK 与实际可用模型，临时工作区，受限请求预算。
- device：真实 Android / iOS 安装包与手机，不用浏览器或 JS 打包替代。
- docker：干净 Linux Docker 主机及持久卷，覆盖容器重建和恢复。

测试 harness 可注入断网、延迟、写入故障和 worker 退出，注入能力只存在于测试构建或进程内依赖注入中，生产不得暴露远程 kill / SQL / 任意调试端点。

## 场景定义

| ID | 需求 | 阶段 | 环境 | 动作与通过条件 |
| --- | --- | --- | --- | --- |
| AT01 | FR11 | S01 | linux | 干净 checkout 安装锁文件、构建所有包、启动 healthz，并输出 Android / iOS JS bundle；版本固定，SDK 依赖只在 agent-pi |
| AT02 | FR04, FR05 | S02 | live | 真实 prompt 读取临时文件、调用工具并写入结果；确认实际文件、工具事件和 pi JSONL；关闭再恢复指定会话，能引用先前唯一测试标记 |
| AT03 | FR05, FR06 | S02 | live + contract | 至少一个模型实际返回 thinking 并显示；另测不支持或 redacted 时诚实呈现；没有原始内容时不能伪造或把签名当文本 |
| AT04 | FR06 | S07 | live | 两个可用模型之间切换，更新有效思考等级；恢复后配置一致；另一 Session 的模型、等级与全局默认不变；unsupported / busy 失败清晰 |
| AT05 | FR07 | S07 | live + linux | 足够历史上手动 compact，显示开始 / 完成，旧历史仍可见，后续会话使用摘要保留信息；取消、历史过短、忙时调用分别正确，不能误停活跃任务 |
| AT06 | FR05, FR09 | S03 | contract | 合成多内容块、工具参数分片、累计输出、重试与最终校准；重复事件不重复文本，缺口暂停，回放与正常流最终状态一致 |
| AT07 | FR09, FR10 | S04 | linux | 事务各写入边界注入失败；事件、seq、Run 与投影同时回滚；重发相同 IPC batch 只提交一次，同号异内容失败，重开 SQLite 状态相同 |
| AT08 | FR09 | S04 | linux | snapshot 截取 S 后持续产生事件，历史分页固定 atSeq；S 时未完成消息稍后完成，旧分页不会重复或遗漏，接续事件与新 snapshot 一致 |
| AT09 | FR01 | S05 | linux | 并发消费配对 token 仅一个成功；过期失败；凭据摘要存储；跨 owner 资源均 404；吊销后 HTTP 失效，WSS 吊销续接到 AT17 |
| AT10 | FR02, FR10 | S05 | linux | 注册真实目录；拒绝不存在、越过允许根、重复、祖先 / 后代重叠与 symlink 绕过；挂载别名和共享 git common dir 的并发边界正确 |
| AT11 | FR02, FR03 | S05 | linux | 新建独立 Session、改名、版本冲突、归档及恢复；重启后持久；旧会话上下文和项目文件保留；运行 / 排队 / 待答时不能归档 |
| AT12 | FR04, FR10 | S05 | linux | 请求已提交但响应丢失后同键重试，资源或命令只创建一次；同键异内容 409；GET command 显示当前进度而非复用旧状态伪装执行 |
| AT13 | FR10 | S06 | linux | 同工作区两个 Session 串行，跨工作区在 2 Run 上限内并行；队列公平、满队列拒绝，空闲 worker 回收，100 个历史 Session 不启动 100 个进程 |
| AT14 | FR04 | S07 | live + linux | 当前 Run 接收 steer，随后 targeted abort；长工具停止得到确认；旧 runId 不会终止新任务；控制通道不被 prompt Promise 阻塞 |
| AT15 | FR04, FR10 | S07 | linux | follow-up 持久化、可取消、按序创建新 Run；重复发送只入队一次；重启只恢复确定未分派队列，不重跑未知结果的命令 |
| AT16 | FR08, FR09 | S07 | live + linux | 四种表单可回答与取消；断线后重现 pending；双设备竞争仅一个回答交付；到期、旧 epoch、worker 退出和重启均关闭过期请求 |
| AT17 | FR01, FR09 | S08 | linux | 回放历史期间持续写事件并反复断开；高水位交接无缺口，重复去重；大于服务高水位的 cursor 拒绝；缓存丢失使用 snapshot 重建；设备吊销使未用 ticket 与既有 WSS 都失效 |
| AT18 | FR09, FR12 | S10, S11 | device | 两平台分别锁屏 60 秒、断网并切换 Wi-Fi / 蜂窝网络；任务继续；恢复后文本、工具、表单和命令收据与服务器一致 |
| AT19 | FR10 | S06, S11 | linux + device | 在 dispatch 前、dispatch 后 / ACK 前、工具执行中、事件提交前后 kill worker / app；unknown / interrupted 显示准确，已发生副作用不自动重复 |
| AT20 | FR05, FR09 | S08 | linux | 高吞吐长输出加暂停读取客户端；发送缓冲有 4 MiB 上限，慢连接 resync，其他连接和任务继续；重复负载内存不持续增长，重连补全已提交事件 |
| AT21 | FR01, FR02, FR03, FR12 | S09, S10 | device | Android 真机配对、列表、历史、新建、改名、归档 / 恢复、命令与表单完整操作；凭据仅在安全存储，长列表可用且读历史不被强制滚动 |
| AT22 | FR01, FR02, FR03, FR12 | S09, S10 | device | iOS 真机完成与 Android 相同流程，覆盖后台恢复和 Keychain；仅 JS export、浏览器预览或模拟器不能通过此最终项 |
| AT23 | FR11 | S12 | docker | 非 root 镜像内真实 Git / bash / Node / Python、读写项目与测试成功；宿主机可正常修改生成文件；无 privileged、无默认 Docker socket 或全盘挂载 |
| AT24 | FR03, FR11 | S12 | docker | 重建 app 容器仍有项目 / Session / 配置；执行一致备份并恢复到新状态卷，继续旧会话、读取旧事件和 artifact；不只验证备份文件存在 |
| AT25 | FR10, FR11 | S06, S12 | linux + docker | TERM、停止超时与父进程退出清理受管理工具；未确认清理时 workspace blocked；第二个主实例拿不到锁；PID 复用不误杀无关进程 |
| AT26 | FR05, FR07 | S02 | live + contract | provider 重试 / 自动压缩产生真实阶段；初次 agent_end 不误报完成，最终错误 / aborted 不报成功；合成故障与至少一次真实正常生命周期都覆盖 |
| AT27 | FR05, FR09 | S08 | linux | 大输出按快照替换并有截断 / artifact 标记；原始内容没保留时明确说明；下载有归属检查、路径校验和 Range，不能读取任意服务器文件 |
| AT28 | FR01, FR11 | S12 | docker + CI | 生产没有测试注入接口；日志与公开提交无真实 token / auth.json / 会话 / 数据库 / 私有代码；HTTPS 与 WSS 可用，错误不泄漏秘密 |
| AT29 | FR04, FR08, FR09, FR12 | S11 | live + device | 两台手机连接同一 Linux 后端：开始真实任务→另一台观察→回答表单→锁屏 / 换网→steer→完成→重启后继续；状态、文本和文件结果一致 |
| AT30 | FR01, FR02, FR03, FR04, FR05, FR06, FR07, FR08, FR09, FR10, FR11, FR12 | S13 | 全部 | AT01–AT29 的必需环境全部通过，干净安装可复现；无 skip / not_run 冒充通过；安装、升级、限制与恢复说明和实际行为一致 |

## 通过标准与报告

跨多个阶段的验收项在各阶段完成该阶段明确列出的子集，例如 S06 验证 AT19 的 Linux 崩溃逻辑，S11 补齐手机展示。阶段报告必须注明已覆盖的子断言；整项最终通过要求所有列出的环境完成。AT21 / AT22 的组件或模拟器子集不能替代真机；SDK mock 也不能替代真实模型与工具调用。

每次执行报告至少包含以下结构，具体 schema 在 S01 建立：

```json
{
  "stage":"Sxx",
  "commit":"IMPLEMENTATION_COMMIT",
  "environment":{"os":"LINUX_VERSION","node":"NODE_VERSION","sdk":"0.85.1","device":"DEVICE_OR_NULL"},
  "checks":[{"id":"AT01","status":"not_run","command":"ACTUAL_COMMAND","evidence":[],"reason":"尚未实现"}],
  "limitations":[]
}
```

状态只能是 passed、failed、not_run；缺少运行条件不算通过。每个 passed 项必须能回溯命令、实际输出 / 断言或设备证据。公共报告删除 token、provider 认证、私人路径和真实代码内容；保留模型 ID、版本及必要行为结论。

S13 检查所有 required IDs 和平台，遇到 missing / failed / not_run 非零退出。一次绿色的普通 CI 不自动代表发布验收通过。
