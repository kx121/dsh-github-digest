# dsh-github-digest

> 你的 GitHub 关注清单，每天有人替你看一遍，只告诉你「变了什么、要不要跟」。

一个 DeepSeek Harness（`dsh`）插件。定时唤醒一个会话，去扫你关注的仓库，挑出值得看的变更写成日报。
**只读，不碰 GitHub 的任何写操作。**

## 它和别的 GitHub 插件有什么不一样

| | 热榜 / RSS 类插件 | dsh-github-digest |
| --- | --- | --- |
| 关注对象 | 全生态榜单 / 你订阅的 feed | **你指定的仓库 + 你关心的主题** |
| 做什么 | 抓下来、排名、摘要 | 抓下来，**判断值不值得看、要不要跟** |
| 输出 | 排行 / 标题列表 | 「变了什么 + 对你的影响 + 成本」 |
| 判断体 | 插件里的摘要器 | 你正在用的那个会话（带你自己的上下文） |

它不试图做「GitHub 热榜」。它做的是**你关心的事有没有变化**。

## 怎么工作

```
定时器（60 秒一跳，到点才动）
   └─ 把一轮日报任务投进你选的会话（自动唤醒空闲会话）
        └─ 会话里的 AI 调插件的工具：
             gh_digest_info     配置与额度
             gh_digest_brief    粗筛：一次 Search 拿 40 个仓库的元信息
             gh_digest_watch    细读：只对筛出来的仓库拉 releases / commits / README
             gh_digest_discover 按主题发现新项目
             gh_digest_seen_*   判重：这个版本看过没
             gh_digest_run_add  执行记录 + 面板数据
        └─ 按自带准则判断 → 写日报 → 记判重表 → 写执行记录
```

判断逻辑不在插件里，在 `prompts/digest.md`：**能解决具体问题、有可跑的代码、版本有实际变化**才值得看，star 高不算理由。这份准则随插件发布，可以自己改。

## 安装

```bash
# 从 GitHub 装
dsh plugin --profile desktop add github:kx121/dsh-github-digest

# 或直接装 Release 里的 tarball
dsh plugin --profile desktop add https://github.com/kx121/dsh-github-digest/releases/download/v0.2.1/dsh-github-digest-0.2.1.tgz
```

装完重启 DSH，侧边栏出现「GitHub 日报」，设置页出现「GitHub 日报设置」。

## 30 秒配好

1. 设置 → **GitHub 日报设置** → 「关注仓库」填仓库全名，一行一个：

   ```
   deepseek-ai/deepseek-harness
   ollama/ollama
   ```

   不想填仓库也行：在「主题 / 关键词」里填 `dsh-plugin`、`mcp` 之类，一行一个，插件会自动扫新项目。

   下面还有个「我的背景」，一句话说清你在做什么（比如「做 DSH 插件和自动化脚本，关注成本、稳定性」）。
   判断「对你有没有用」时模型会先看它；不填就按主题和关注仓库推断。

2. 「目标会话」留空 = 每轮自动新建或复用当天的日报会话；也可以指定一个固定会话。

3. 「定时」选每天，时间填 `12:30`（谷时，模型便宜一半）。

4. 点「保存」，再点「立即跑一轮」。结果在侧边栏「GitHub 日报」里看，日报写进
   `<工作区>/.github-digest/YYYY-MM-DD-N.md`（N 是当天第几轮）。

不用配 token 也能跑。插件会自动从本机找已有的 GitHub 凭据，找不到就匿名跑。

## 限速：先说清楚，不然第一次就会踩

| | 每小时 REST 额度 | 每分钟搜索额度 |
| --- | --- | --- |
| 不填 token | 60 | 10 |
| 填只读 token | 5000 | 30 |

**一轮到底花几次请求**：

| 阶段 | 请求数 | 说明 |
| --- | --- | --- |
| 粗筛（不管几个仓库） | **1 次** | 一次 Search 批量拿全部仓库的元信息 |
| 细读（每个仓库） | 1–2 次 | releases + commits，只对筛出来的调 |
| 有推送时才拉 releases | — | 没推送的仓库直接跳过 |
| **一轮合计** | **约 3–14 次** | 1 次粗筛 + 最多 6 条收取（每条 1–2 次） |

所以不填 token 的 60 次/小时，按默认 6 条算够跑 4–15 轮。填了 token 是 5000 次/小时，基本不用管这件事。

### 省额度的手段

1. **用上 token（最有效）**。GitHub 给认证请求 5000 次/小时。两条来路：
   - 设置页填一个只读 Fine-grained token，只勾 `Public repositories`；
   - **什么都不做** —— 插件启动时会自己去本机找：环境变量 `GITHUB_TOKEN` / `GH_TOKEN` → `gh auth token` → gh 的 `hosts.yml` → `~/.git-credentials` → 系统凭据管理器（`git credential fill`，git / GitHub Desktop / Visual Studio 登录过的都在这里）。找不到就匿名跑。
2. **`pushed_at` 短路**。仓库自上次检查以来没有推送，就不再去问 releases。12 小时内有效，防止漏掉不伴随代码推送的 release。
3. **批量元信息**。粗筛用一次 Search 请求拿回全部关注仓库的元信息，不是每个仓库打一次 `/repos`。
4. **本轮缓存**。粗筛拿到的元信息 / releases 直接给 watch 复用，同一轮不重复请求。

> 别指望 ETag 省配额：304 确实省流量，但**实测仍然扣配额**（6 次请求里含 1 次 304，`X-RateLimit-Remaining` 照样从 30 掉到 25），跟官方文档写的不一样。省额度只能靠少发请求。

> 不建议也不要做的：多账号轮换、代理池换 IP、爬 HTML 页面。前两个违反 GitHub 服务条款，第三个会随页面改版失效。

## 成本：一轮花多少 token

GitHub 的数据量确实大，所以这个插件做了三件事：**先粗筛再细读**、**按判重表只返回新版本**、**正文截断**。

| 场景 | 上下文增量 | 钱（官方空闲价） |
| --- | --- | --- |
| 粗筛 40 个仓库（brief） | ≈ 2–3k token | 可忽略 |
| 细读 1 个仓库（watch，正文截 600 字） | ≈ 1.5k token | 可忽略 |
| **默认配置一轮**（6 条以内、不读 README） | **≈ 8–12k token** | ≈ 0.01–0.02 元 |
| 每天一轮、一个月 | ≈ 300–400k | **≈ 0.3–0.5 元** |

三个开关（设置页都有）：

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| 读 README | 关 | 一个 README 两三千字，是单轮最大的 token 来源 |
| release 正文截断 | 600 字符 | 够判断「改了什么」，不读完整个 changelog |
| 每轮最多看几个仓库 | 40 | 粗筛本身不贵，贵在细读；收取上限才是成本的闸门 |

> **日报会自己开一个会话，并且当天复用同一个。** 日报写进文件、结果进侧边栏面板，你不需要去那个会话里看。
> 想固定用某个会话，在设置页「目标会话」里指定，之后永远用它。

## 侧边栏面板

点侧边栏「GitHub 日报」：

- 消耗：本轮费用 / 日报累计 / 今日全部（含其他会话）/ 各项目体量
- 日报记录：每轮一条，带项目编号、推荐程度、变化 / 影响 / 建议
- 筛选：按推荐程度、按时间（今天 / 3 天 / 7 天）
- 来源分栏：全部 / 发现 / 关注。发现模式扫到的项目和关注仓库的记录分开看
- 历史搜索：按项目名和「是什么 / 变化 / 影响 / 建议」全文模糊搜，空格分隔多个词按「全部命中」算。搜的是整个 history.jsonl（最多 500 轮），不只是面板上的最近 20 轮。命中的词会高亮出来
- 字号滑块：记录区文字 0.85×–1.6× 缩放。偏好存在本机浏览器里（localStorage），不进配置文件，不影响面板其它区域
- 四栏标签是小气泡（是什么 / 变化 / 影响 / 建议各自一个低饱和配色），扫记录时一眼能分清是哪一栏
- 关注按钮：每条项目右边点一下就加进关注列表，再点取消。只改本机配置，不对 GitHub 发写请求
- GitHub 热门：今日 / 本周 / 本月三档榜单，展开才拉，30 分钟缓存。数据走 `api.github.com`，不依赖 `github.com` 网页（后者在国内经常直连不通）
- 关注视图顶部列出所有关注仓库和上次检查结果（未发现更新 / 有新推送 / 很久没动静 / 尚未检查），不用翻记录就知道哪些没动
- 「立即跑一轮」直接触发

## 日报长什么样

```markdown
# GitHub 日报 2026-10-22

额度：42/60｜模式：定时｜关注仓库 3 个｜粗筛 3 个、细读 2 个

## 值得看

### 1. owner/repo ★1.2k
- **是什么**：一句话说清这东西是干嘛的（首次收录必写）
- **变了什么**：v2.1.0（10-20），新增 xxx，删掉了 yyy
- **为什么值得看**：具体一句，说清解决什么问题
- **要不要跟**：建议 + 成本

## 跳过的

- owner/another：只改了 CI 配置

## 异常

- 无
```

没有值得看的，就写「本轮没有值得看的」，不凑数。

## 数据存在哪

```
~/.dsh/github-digest/
  config.json          设置页存的值（含 token，权限只给当前用户）
  seen.md              判重表：仓库 / 处置 / 理由 / 首次看到
  runs.md              执行记录：时间 / 触发 / 结果 / 关注 / 收取 / 跳过 / 额度 / 备注
  history.jsonl        面板用的结构化记录（含成本、项目明细）
  watch-state.json     每个仓库上次检查时间、发现模式的主题游标
  pending-run.json     本轮临时数据（成本基线 / 粗筛缓存）
  apply-probe.json     插件加载探针（排障用）
<工作区>/.github-digest/
  YYYY-MM-DD-N.md      日报（N 是当天第几轮；必须落在工作区内，否则每轮弹权限审批）
```

## 安全边界

- **只读**：所有请求都是 GET。不发 issue、不点 star、不改仓库、不操作 PR。
- **token 只用于提高限速**：不写入日志、设置页不回显明文，只显示来源和前后各 4 位。自动探测到的 token 只进内存（5 分钟重读一次）。
- **投递的消息**用官方 `createUserMessage` 构造，保证会话格式合法。
- **HTTP 路由**有来源校验：只接受本机回环地址，跨站请求直接 403。

## FAQ

**Q：必须填 token 吗？**
不用。插件会先自动去本机找，找不到就匿名跑。匿名 60 次/小时，一轮 3–14 次，定时一天一次永远碰不到上限。

**Q：能监控私有仓库吗？**
能，但要填一个有权限的 token。

**Q：能发 issue 或点 star 吗？**
不能，这个插件只读。要写操作用别的插件。

**Q：定时到点但我电脑睡了怎么办？**
6 小时内的到点任务会补跑一次（`CATCH_UP_MINUTES = 360`）。超过就等明天。

**Q：定时那一轮失败（比如没配会话）怎么办？**
当天不再自动重试，失败原因写在设置页「上次运行」里。修好后点「立即跑一轮」补一次。

**Q：面板里出现「判重表读不出来」怎么办？**
那是 `seen.md` 被占用或损坏。插件不会把它当成「没记录过」（否则会重复收），先把文件修好再跑。

**Q：能只手动跑、不定时吗？**
可以。定时选「只手动」，之后只点「立即跑一轮」。

## 开发

```bash
npm test        # 离线冒烟测试（不连网、不碰真实数据）
```

架构、宿主 API 事实、踩坑记录见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，发版流程见 [RELEASING.md](RELEASING.md)。

## English

**dsh-github-digest** is a [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that wakes a session on a schedule,
scans the GitHub repos and topics you care about, decides what is actually worth reading, and writes a daily report.
It is **read-only** — it never creates issues, stars repos, or pushes anything.

- 7 tools: `gh_digest_info`, `gh_digest_brief`, `gh_digest_watch`, `gh_digest_discover`, `gh_digest_seen_query`, `gh_digest_seen_add`, `gh_digest_run_add`.
- One Search request for the whole watch list (up to 40 repos), then 1–2 requests per repo that actually changed.
- Works without a token (60 requests/hour) and auto-detects existing GitHub credentials on the machine.
- The judging rules live in `prompts/digest.md` and are shipped with the plugin — change them to fit your taste.
- Sidebar panel: cost per round, cumulative cost, per-project token volume, run history with filters.

**Install**

```bash
dsh plugin --profile <profile> add github:kx121/dsh-github-digest
```

**Configuration** lives in Settings → GitHub Digest. Data: `~/.dsh/github-digest`; daily reports: `<workspace>/.github-digest/YYYY-MM-DD-N.md`.

**License**: MIT.

## 许可

MIT。
