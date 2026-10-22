# Changelog

## 0.2.0 — 2026-10-22

### 改名

`github-duty` → `dsh-github-digest`。

DSH 生态里已经有四个 `*-duty` 插件（`dsh-telegram-duty`、`dsh-cc98-duty`、`dsh-plugin-feishu-duty`、`dsh-duty-separation-proof`），搜索时混在一起。`digest` 也更贴近这个插件实际干的事：把关注范围内的变化摘出来给你看。

连带改动：

- 工具：`gh_duty_*` → `gh_digest_*`（7 个）
- 路由：`/github-duty/*` → `/github-digest/*`（7 条）
- 插件 id 与包名：`dsh-github-digest`
- 数据目录：`~/.dsh/github-duty` → `~/.dsh/github-digest`
- 工作区日报目录：`.github-duty/` → `.github-digest/`

旧数据不会自动搬。升级前把 `~/.dsh/github-duty` 整个复制成 `~/.dsh/github-digest` 再启动，判重表和执行记录都在里面。

### 界面

- 设置页标题「GitHub 值班表」改为「GitHub 日报设置」，侧边栏「GitHub 值班」改为「GitHub 日报」。

### 修正

- **客户端模块注册 id 改成包名 `dsh-github-digest`。** 改名时漏了这一处：宿主按包名找 factory，
  找不到就把 bundle 再执行一遍，触发 `duplicate factory registration`，web boot 判定 entry 未激活，
  用户看到「应用无法启动」。本版 tarball 已替换，装过旧 tarball 的重新装一次。
- 冒烟测试补断言：客户端模块 id 必须等于包名；CHANGELOG 顶部版本必须等于 package.json；
  README / 设置页标题 / 日报文件名 / 安装命令互相一致。
- 代码清理：删掉未使用的 import 与导出、config 路由里的死变量、`updatePending` 改成原子写。

## 0.1.1 — 2026-10-22

### 面板

- 日报记录加「全部 / 发现 / 关注」来源分栏。`items_json` 新增可选 `source`（`watch` / `discover`）；老数据没有这个字段，按当前关注列表反推。
- 每个条目右侧加关注按钮，点一下写进本机 `watch_repos`，再点取消。只改本地配置，不对 GitHub 发任何写请求。
- 关注视图顶部列出所有关注仓库和上次检查结果：首次检查 / 未发现更新 / 有新推送 / 很久没动静 / 尚未检查。不用翻记录就知道哪些项目没动。
- 新路由 `POST /github-digest/watch`：只增删一个关注仓库，不覆盖其它配置。关注满 60 个返回 `WATCH_FULL`，不再静默截断。
- 日报记录加历史搜索：项目名 + 是什么 / 变化 / 影响 / 建议全文模糊搜，空格分隔多词按 AND 匹配。搜的是服务端 history.jsonl（最多 500 轮），不受面板只显示最近 20 轮的限制；搜索结果同样吃来源 / 推荐度 / 时间三个筛选。
- 字号滑块：记录区（含搜索结果）文字 0.85×–1.6× 缩放。字号走 CSS 变量 `--gd-fs`，面板其它区域不受影响；偏好存 localStorage，不写配置文件。
- 四栏标签改成气泡：是什么（灰蓝）/ 变化（灰绿）/ 影响（灰金）/ 建议（灰紫），文字色 + 同色系 15% 半透明底。只占一小块，正文仍用次要色；标签不再带冒号。
- 新增「GitHub 热门」榜单：今日 / 本周 / 本月三档，列出时间窗内新建、star 最多的项目，每条可以一键加关注。走 `api.github.com` 的 Search 接口自己算，不抓 `github.com/trending` 页面（那个域名在很多网络下直连不通）。默认收起，展开才拉；结果服务端缓存 30 分钟。
- 搜索命中高亮：查的词在项目名和「是什么 / 变化 / 影响 / 建议」里用亮黄实心底 + 深色字标出来（像浏览器 Ctrl+F），多词各标各的。高亮走 React 节点而不是拼 HTML 串；搜索词逐字符转义后进正则，不写转义用的正则字面量。

### 设置页

- 原来挤在一组的「执行设置」拆成四组：定时与投递 / 每轮规模 / 运行环境 / 读什么。
- 补上「release 正文截断」（`release_body_chars`）的设置入口 —— 这个参数后端一直在用，页面上却没有。
- 删掉 `languages`：配置里有、工具返回里有，但没有任何代码读它过滤仓库，是死参数。
- 榜单默认时间窗和条数进 config（`trending_window` / `trending_limit`），面板读它当初始值；不进设置页，避免参数越堆越多。

### 修复

- `gh_digest_brief` 的 watch-state 新增 `lastDelta`（面板据此显示状态）；修掉用户填写的 owner/repo 大小写与 GitHub 返回值不一致时，把检查过的仓库重新当成首次检查的问题。
- 搜索框在输入法组词期间不再发起搜索。之前打拼音时会把 `bi` 当成查询词，组词过程中一直显示「找到 0 条」，选完字结果才整批跳出来。现在监听 `compositionstart` / `compositionend`，组词结束才搜；组词中失焦也会重置状态，不会把后续搜索卡死。
- 搜索时查询串里的标点一律当分隔符：`rea，逆向`、`rea、逆向`、`rea；逆向` 跟 `rea 逆向` 一样能搜到。只切句读符号，`.` `-` `_` `/` `@` 保留下来（版本号和仓库名本身要用，切了 `v1.3.3` 会变成 `v1 3 3`）。

## 0.1.0 — 2026-10-22

首个公开版本。

### 功能

- 定时唤醒会话跑一轮 GitHub 日报：粗筛 → 细读 → 按准则判断 → 写日报 → 记判重表 / 执行记录。
- 7 个工具：`gh_digest_info` / `gh_digest_brief` / `gh_digest_watch` / `gh_digest_discover` / `gh_digest_seen_query` / `gh_digest_seen_add` / `gh_digest_run_add`。
- 关注仓库模式 + 按主题发现模式（主题轮换、判重过滤、冷门配额）。
- 侧边栏面板：本轮 / 累计 / 今日消耗、每项目体量、日报记录、推荐程度与时间筛选、平滑滚动。
- 设置页：仓库、主题、定时、目标会话、工作区、读取开关、冷门配额、只读 token（含本机凭据自动探测）。
- 成本核算：dsh-cost-meter 账本 + 会话投影缓存差值；并发污染时标记 `≈`，不假装精确。
- 日报写进 `<工作区>/.github-digest/`，避免会话写入工作区外触发权限审批。

### 判断质量

- 新增「我的背景」（`profile_note`）：设置页一句话说明用户在做什么，注入唤醒消息，作为「对你有没有用」的第一依据。
- `items_json` 新增 `confidence`（`high` / `medium` / `low`），面板显示「把握」徽标；拿不准的结论不再和确定结论混在一起。
- `topicHits` 在仓库没填 topics 时退回名字 / 描述做词边界匹配（新项目很大比例不填 topics，只比 topics 会让判断依据失效）。
- 报告文件名统一为 `YYYY-MM-DD-N.md`，`gh_digest_info` 直接返回 `todayRuns` 与 `runIndexHint`，不让模型自己数轮次。

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
