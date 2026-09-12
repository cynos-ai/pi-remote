# 开发进度与验证证据

最后更新：2026-09-12。

## 当前状态

产品和开发交接文档已编写；应用尚未实现。参考 SQL 和示例事件属于设计附件，不是已经部署的业务实现。以下应用阶段全部未开始，不能直接运行其规划的 pnpm 脚本。

已完成一轮[独立设计评审与修订](reviews/2026-09-12-design-review.md)：7 项发现已落实到契约、参考 schema 和分步验证，具体结论及限制见记录。

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| S01 | not_started | 工程、依赖和 CI 基础 |
| S02 | not_started | 真实 pi SDK 验证 |
| S03 | not_started | 公共协议与事件 reducer |
| S04 | not_started | 数据库、事件和投影事务 |
| S05 | not_started | 鉴权、项目和会话 API |
| S06 | not_started | worker、调度与恢复 |
| S07 | not_started | 命令和交互桥接 |
| S08 | not_started | WSS、快照及断线回放 |
| S09 | not_started | 移动端连接、列表与历史 |
| S10 | not_started | 移动端过程、命令与表单 |
| S11 | not_started | 双端弱网与 Linux 进程故障闭环 |
| S12 | not_started | Docker、容器清理证明、部署与备份 |
| S13 | not_started | 真实 Linux / Android / iOS 发布验收 |

## 本次设计交付的检查

初稿 [29e8026](https://github.com/cynos-ai/pi-remote/commit/29e80269e47fe2a8e93f722ab7184b439580af68) 的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34687052151)。

2026-09-12 评审修订轮，在 Windows、Python 3.12.8、SQLite 3.45.3 上执行 `python scripts/check_docs.py` 与 `git diff --check`，均通过：10 份 Markdown 及链接 / 表格，13 个阶段，12 条需求，30 个验收场景及双向阶段归属，47 个合成事件，12 张 SQLite 参考表及完整性约束，MIT 许可证。

独立代理针对修订后的 R1–R7 复核，未发现剩余阻断项；非阻断的最终命令结果存储建议也已补入 result_json。应用实现与实际 SDK / Docker / 设备验证仍未运行，不能把这次文档复核当作运行时验收。

GitHub Actions 中同一脚本在 Linux 上运行，实际结果以仓库的 Documentation checks 为准。该检查不加载 pi、不调用模型、不启动 Docker、不构建手机 App；所有应用阶段仍为 not_started。

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
