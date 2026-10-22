# 发版流程

## 发布到哪

当前实际只发 **GitHub Release**：tarball 挂在 Release 资产上，市场收录 PR 直接引用该 URL，
npm 上没有这个包（`npm view` 404 是正常的）。下面第 5、8 步的 npm 部分是可选备用路径，只发 Release 时跳过。

## 0. 前置

- npm 账号，且**命令行**已登录：`npm whoami --registry=https://registry.npmjs.org/`
- 网页登录 ≠ 命令行登录，后者要的是 token。

## 1. 改版本

- `package.json` 的 `version`（与 git tag 一致：`v0.2.0` ↔ `0.2.0`）
- `CHANGELOG.md` 加一段，只写使用者能感知的变化

## 2. 跑测试

```bash
npm test
```

必须 0 失败。

## 3. 隐私核对（别省这一步）

```bash
npm pack --dry-run
```

逐项看清单：

- **不能出现**：`config.json`（里面有 token）、`seen.md`、`runs.md`、`out/`、`history.jsonl`、本机绝对路径、任何 `.env`
- **必须出现**：`lib/`（含 `client.js`，漏了客户端 bundle 插件会激活失败）、`prompts/digest.md`、`cordis.patch.yml`、`package.json`、`README.md`、`LICENSE`、`CHANGELOG.md`、`icon.svg`、`locale/*.json`
- `package.json` 里**不能有** `private: true`（会直接阻止 publish）
- `files` 白名单不能包含运行时数据文件
- `lib/client.js` 里 `__ModuleLoader__.load({ id })` 的 id **必须等于 `package.json` 的 `name`**；
  对不上 = web boot 崩溃，装完应用起不来

## 4. 提交与打 tag

```bash
git add -A
git commit -m "release: v0.2.0"
git tag -a v0.2.0 -m "dsh-github-digest 0.2.0"
git push origin main && git push origin v0.2.0
```

## 5. 发布

```bash
npm publish
```

`publishConfig.registry` 已指向官方源。网络不稳时 `ECONNRESET` 直接重试。

## 6. 发布后验证（别只看退出码）

```bash
npm view dsh-github-digest version --registry=https://registry.npmjs.org/
npm pack dsh-github-digest@0.2.0 --dry-run
```

再打开包页面看：README 渲染、icon、repository 链接、版本号与 tag 一致。

然后**重启宿主**验证：没有新的 `crash-*-web-boot.log`，设置页「GitHub 日报设置」和侧边栏「GitHub 日报」都能打开。
只看 `apply-probe.json` 是 `apply-ok` 不够 —— 那只代表 host 半。

## 7. GitHub Release

选 tag，标题写版本号，正文贴 CHANGELOG 那一段。仓库加 topic `dsh-plugin`（生态检索按它找）。

## 8. 回滚（有限）

- `npm unpublish dsh-github-digest@X.Y.Z`：仅 72 小时内，且该版本号永久不可复用
- 超过 72 小时只能 `npm deprecate` 再发修复版
- 所以第 3 步的核对比事后回滚便宜得多
