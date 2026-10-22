# Changelog

## 0.1.0 — 2026-10-22

首个公开版本。

### 功能

- 定时唤醒会话跑一轮 GitHub 值班：粗筛 → 细读 → 按准则判断 → 写日报 → 记判重表 / 执行记录。
- 7 个工具：`gh_duty_info` / `gh_duty_brief` / `gh_duty_watch` / `gh_duty_discover` / `gh_duty_seen_query` / `gh_duty_seen_add` / `gh_duty_run_add`。
- 关注仓库模式 + 按主题发现模式（主题轮换、判重过滤、冷门配额）。
- 侧边栏面板：本轮 / 累计 / 今日消耗、每项目体量、值班记录、推荐程度与时间筛选、平滑滚动。
- 设置页：仓库、主题、定时、目标会话、工作区、读取开关、冷门配额、只读 token（含本机凭据自动探测）。
- 成本核算：dsh-cost-meter 账本 + 会话投影缓存差值；并发污染时标记 `≈`，不假装精确。
- 日报写进 `<工作区>/.github-duty/`，避免会话写入工作区外触发权限审批。

### 判断质量

- 新增「我的背景」（`profile_note`）：设置页一句话说明用户在做什么，注入唤醒消息，作为「对你有没有用」的第一依据。
- `items_json` 新增 `confidence`（`high` / `medium` / `low`），面板显示「把握」徽标；拿不准的结论不再和确定结论混在一起。
- `topicHits` 在仓库没填 topics 时退回名字 / 描述做词边界匹配（新项目很大比例不填 topics，只比 topics 会让判断依据失效）。
- 报告文件名统一为 `YYYY-MM-DD-N.md`，`gh_duty_info` 直接返回 `todayRuns` 与 `runIndexHint`，不让模型自己数轮次。

### 判重与配额

- `run_add` 收尾时自动补记判重表：`items_json` 里已处理的仓库按 verdict 补，发现模式看过但没处理的候选补成「跳过」。实测漏记会让下一轮原样再出现同一批候选，白烧一次 Search 和一轮判断。
- 有 token 后 `max_repos_per_run` 上限从 50 放宽到 60（= 关注仓库上限），设置页两条提示按凭据状态切换。

### 相对内部早期实现

- 定时器改为真正的 60 秒（宿主 `ctx.interval` 是毫秒制，旧实现实际 60ms 一跳）。
- 空闲会话改用官方 `sessionController.resolveAgent` 恢复，失败时用 `sessionController.prompt` 兜底；「当天复用」不再退化成每轮新建。
- 设置页主题输入保留多词主题（`ai agent` 不再被拆成两个词）。
- 设置页不再回显 token 明文，只显示来源与掩码。
- 工具错误结构统一为 `ok/code/message/hint`；坏 JSON 请求返回 400。
- 修复 `run_add` 引用不存在字段、发现模式主题语义、README / 准则与默认值不一致等一批文档与实现漂移。
- 模块化重写宿主与客户端（配置 / 存储 / 成本 / 调度 / 会话 / 工具 / 路由 / 面板分层）。

### 测试

离线冒烟测试覆盖配置、调度、存储、GitHub 客户端、凭据探测、成本、发现、工具 execute、4 条路由、fire 全流程、面板 payload、客户端静态契约与文档一致性。跑法：`npm test`。
