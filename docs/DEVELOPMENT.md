# 开发文档

给要改这个插件的人。里面的宿主事实都是对着 `@deepseek-ai/* 0.2.1-rc.2` 源码核实过的。

## 架构：五层

```
入口          lib/index.js        只做装配：runtime → tools → routes → timer → probe
运行时        lib/runtime.js      配置 / 路径 / 凭据 / GitHub 客户端 / 会话操作 的唯一持有者
调度层        lib/runner.js       定时器与手动触发 → fire() 投递一轮，写执行记录与成本基线
通道层        lib/github.js       只读 REST + Search（错误分类、ETag 缓存、批量查询）
记录层        lib/store.js        seen.md / runs.md / history.jsonl / watch-state / pending
成本层        lib/cost.js         cost-meter 账本 + 会话投影缓存差值
判断层        prompts/digest.md     投给会话 AI 的准则；插件本身不调 LLM
```

目录：

```
lib/
  index.js            插件入口（name / inject / apply / __test__）
  runtime.js          运行时装配
  config.js           DEFAULT_CONFIG + 归一化 + 读写 + publicConfig（脱敏）
  paths.js            DSH_HOME / PLUGIN_HOME / 日报目录 / 版本号
  util.js             JSON 原子写、时间、clamp、well-formed 清洗
  store.js            Markdown 表、history、watch-state、pending
  schedule.js         定时判定 + schedule-state
  cost.js             账本 / 会话成本 / 差值算法
  discovery.js        topicSlug / matchTopicHits / filterUnseen
  repo-ref.js         owner/repo 解析
  github.js           GitHub 客户端 + 错误分类
  credential.js       本机凭据探测（只读）
  sessions.js         会话列表 / 建会话 / 改名 / 唤醒 / prompt 兜底
  wake-message.js     唤醒消息拼装 + 准则读取
  panel-data.js       /status、/config、/panel 的数据组装
  routes.js           4 条 HTTP 路由 + 来源校验 + 请求体读取
  runner.js           fire() + startTimer()
  tools/              7 个工具（schema / info / brief / watch / discover / seen / runs）
  client.js           Web 客户端（设置页 + 侧边栏面板），单文件
tools/smoke-test.mjs  离线冒烟测试
prompts/digest.md       判断准则（随包发布，用户可改）
```

## 宿主事实（别重复踩）

### 1. `ctx.interval` 的单位是毫秒

`@deepseek-ai/cordis-plugin-timer` 的 `interval(callback, delay)` 直接调用原生 `setInterval(callback, delay)`。
写 `60` 不是 60 秒，是 60 毫秒 —— 旧实现就是这么把自己坑了。现在用 `TICK_INTERVAL_MS = 60 * 1000`。

### 2. 会话恢复与投递

`sessionController` 上**没有** `resume` / `activate` / `load` / `open`。
空闲会话被卸载后，正确入口是：

- `sessionController.resolveAgent(sessionId)` → `agent | { error }`（官方恢复入口，内部走 `agents.resume({ resumeSessionId })`）
- `sessionController.prompt({ sessionId, content, requestId })` → 内部先 resolveAgent 再 admit（投递兜底）
- `ctx.get('agents').resume({ resumeSessionId })` 也走官方工厂，但需要 `agentOptions` / `setup`，插件一般拿不到。

本插件的投递顺序：`agents.get()` → `resolveAgent` → `prompt` → 复用失败回退新建一次。

### 3. 新建 / 改名

- `sessionController.create({ workspaceId } | { cwd })` → `{ sessionId }`；只给 cwd 时不会写进 workspace 的 sessionIds（实测踩过）。
- `sessionController.rename({ sessionId, title })` 可用；`setTitle` 不存在。

### 4. 路由

`ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler(req, res) })` 返回 disposer，
**必须包进 `ctx.effect`**，否则插件重载后 `duplicate exact route`。
路由没有自动前缀、没有鉴权，来源校验要插件自己做（`requestRejection`）。
冷启动时 `ctx.get('webServer')` 可能是 undefined，用 `ctx.inject(['webServer'], cb)` 等。

### 5. 客户端

`exports['./client']` 由 `window.__ModuleLoader__.load({ id, factory })` 消费，
**只认单文件 classic script**；入口同步相对 ESM import 不支持（同包异步 chunk 需要构建，本插件不用）。
factory 的 `require` 只能解析平台冻结模块（react 等 11 项）与已注册 bundle。
客户端 inject 只能写真实服务（本插件只有 `slots`）；写 `styles` / `React` 会让 web boot 卡死。
factory 体里任何 throw 都会让 web boot 判定 entry failed，所以整段包 try/catch。

### 6. 热重载

- 客户端：`dsh-client-hmr` 每 500ms stat bundle，改 `lib/client.js` 约 0.5 秒后浏览器热替换。
- Host 半：桌面端 HMR 只监听 profile manifest/patch，**默认不监听 linked 包源码**。
  改 `lib/*.js` 后要触发一次 profile 重组（改 profile 的 `package.json` / `cordis.patch.yml`、或用插件页禁用/启用），
  重组时按 inode/mtime/size 比对并替换 entry。
- `apply` 里任何异常都不许外抛：抛了 = entry failed，整个插件起不来。失败写 `apply-probe.json`。

## 数据契约

| 文件 | 位置 | 写入方 | 说明 |
| --- | --- | --- | --- |
| config.json | ~/.dsh/github-digest | host | 设置页存的值；token 明文只在这 |
| seen.md | ~/.dsh/github-digest | host（工具） | 判重表，Markdown 表格 |
| runs.md | ~/.dsh/github-digest | host（工具） | 执行记录，Markdown 表格 |
| history.jsonl | ~/.dsh/github-digest | host（run_add） | 面板结构化数据，超 1MB 截到最近 500 条 |
| watch-state.json | ~/.dsh/github-digest | host（brief/discover） | 每仓库 pushedAt/checkedAt、discoverCursor |
| pending-run.json | ~/.dsh/github-digest | host | 本轮临时数据；fire 时写成本基线，run_add 清掉 |
| schedule-state.json | ~/.dsh/github-digest | host | lastRunDate / lastFireAt / lastFireReason |
| apply-probe.json | ~/.dsh/github-digest | host | 加载探针，排障用 |
| YYYY-MM-DD.md | <工作区>/.github-digest | **会话** | 日报；必须落在会话工作区内，否则每轮弹权限审批 |

旧版日报在 `~/.dsh/github-digest/out/`，面板仍会兼容读取，但不再写入。

## 测试

```bash
npm test
```

全离线：`DSH_HOME` 指向临时目录，GitHub 请求全部用假 fetch，不碰真实数据。
覆盖：配置归一、调度判定、Markdown 表、history、pending、GitHub 客户端、凭据探测、发现纯函数、成本、
会话索引、路径、唤醒消息、工具 execute、4 条路由、fire 全流程（含恢复/prompt 兜底）、面板 payload、
客户端静态契约、文档与包一致性。

## 发版

见 [RELEASING.md](../RELEASING.md)。三个容易漏的点：

1. `npm pack --dry-run` 核清单：不能带 `config.json` / `seen.md` / `runs.md` / `history.jsonl`；
2. `files` 白名单必须包含 `lib`（客户端 bundle 在 `lib/client.js`，漏了插件激活失败）；
3. `package.json` 不能有 `private: true`。
