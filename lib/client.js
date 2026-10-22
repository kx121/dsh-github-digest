/**
 * github-digest —— Client 半（Web 设置页 + 侧边栏日报面板）
 *
 * 形态：静态客户端模块，按 window.__ModuleLoader__.load 约定注册一个惰性 factory。
 * 平台只加载单个 client.js（entry 不能同步 require 相对文件），所以设置页与面板都在本文件里，
 * 通过「纯工具 → 样式 → 基础组件 → 页面」分层保持可读性。
 *
 * ⚠️ factory 体里任何 throw 都会让 web boot 判定 entry failed，用户看到「应用无法启动」。
 *    所以整个 factory 包一层 try/catch，炸了返回空插件。
 * ⚠️ 客户端 inject 只能写真实服务（这里只有 slots）。styles / React / host 是形参，不是服务。
 */
window.__ModuleLoader__.load({
  // 这个 id 必须等于 package.json 的 name。宿主按包名找 factory：对不上会被判
  // 「脚本执行了但没注册」，加载器回落到单文件 URL 再执行一遍，第二次注册抛
  // duplicate，web boot 判 entry 未激活 —— 用户看到「应用无法启动」。
  id: 'dsh-github-digest',
  factory(require) {
    try {
      const React = require('react')
      const h = React.createElement
      const { useState, useEffect, useCallback, useRef } = React

      // ── 纯工具 ────────────────────────────────────────────────────────
      const fmtNum = (n) => {
        const v = Number(n) || 0
        if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M'
        if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
        return String(v)
      }
      const fmtMoney = (n) => '¥' + (Number(n) || 0).toFixed(4)

      /** 记录里的时间是 "2026-10-22 02:46:45"，直接 Date.parse 在 Chromium 不稳，先换分隔符。 */
      const parseAtMs = (value) => {
        const parsed = Date.parse(String(value || '').replace(/-/g, '/'))
        return Number.isFinite(parsed) ? parsed : 0
      }
      /** 时间筛选的起点；'all' 返回 0 表示不限。 */
      const timeFloorMs = (mode) => {
        if (mode === 'today') {
          const start = new Date()
          start.setHours(0, 0, 0, 0)
          return start.getTime()
        }
        if (mode === '3d') return Date.now() - 3 * 86400000
        if (mode === '7d') return Date.now() - 7 * 86400000
        return 0
      }

      /** 慢-快-慢（easeInOutCubic）。不用 scrollTo({behavior:'smooth'})：那个先快后慢、时长不可控。 */
      const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
      function smoothScrollTo(el, target, duration) {
        if (!el) return
        const start = el.scrollTop
        const delta = target - start
        if (!delta) return
        try {
          if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            el.scrollTop = target
            return
          }
        } catch (err) {
          /* 忽略 */
        }
        const begin = (window.performance && window.performance.now) ? window.performance.now() : Date.now()
        const step = (now) => {
          const progress = Math.min(1, Math.max(0, (now - begin) / duration))
          el.scrollTop = start + delta * easeInOut(progress)
          if (progress < 1) window.requestAnimationFrame(step)
        }
        window.requestAnimationFrame(step)
        // rAF 在后台标签页会被暂停，兜底直接落位。
        window.setTimeout(() => {
          if (Math.abs(el.scrollTop - target) > 2) el.scrollTop = target
        }, duration + 120)
      }

      /** 一行一个 / 逗号分隔。多词主题（ai agent）内部空格保留。 */
      const splitList = (text) => String(text || '').split(/[\r\n,，]+/).map((s) => s.trim()).filter(Boolean)
      const joinLines = (list) => (Array.isArray(list) ? list : []).join('\n')

      const TRIGGER_LABELS = { manual: '手动', schedule: '定时', plugin: '插件', api: '接口' }
      const RESULT_LABELS = { ok: '成功', partial: '部分完成', failed: '失败' }
      const labelOf = (map, value) => map[String(value || '')] || String(value || '')
      const VERDICT_FILTERS = [
        ['all', '全部推荐度'],
        ['worth', '值得看'],
        ['watch', '观察'],
        ['skip', '跳过'],
      ]
      const TIME_FILTERS = [
        ['all', '全部时间'],
        ['today', '今天'],
        ['3d', '近 3 天'],
        ['7d', '近 7 天'],
      ]
      const SOURCE_FILTERS = [
        ['all', '全部'],
        ['discover', '发现'],
        ['watch', '关注'],
      ]
      // 日报记录字号：纯界面偏好，存 localStorage，不进配置文件（也不跨设备）。
      const FONT_SCALE_KEY = 'github-digest:font-scale'
      const FONT_SCALE_MIN = 0.85
      const FONT_SCALE_MAX = 1.6

      /**
       * 条目来源：优先用 items_json 里写的 source（新数据），
       * 老数据没这个字段，就按「现在还在不在关注列表里」反推。
       * 反推会认错（关注后又取消的，历史条目会被归到发现），所以新数据一律带 source。
       */
      function itemSource(item, watchSet) {
        const declared = String((item && item.source) || '').toLowerCase()
        if (declared === 'watch' || declared === 'discover') return declared
        const repo = String((item && item.repo) || '').toLowerCase()
        return repo && watchSet && watchSet.has(repo) ? 'watch' : 'discover'
      }

      // 查询词里的标点一律当分隔符。跟服务端 panel-data.js 的 splitQuery 规则保持一致，改一边记得改另一边。
      const QUERY_PUNCT = new Set([
        '，', ',', '、', '。', '；', ';', '：', ':', '！', '!', '？', '?',
        '（', '(', '）', ')', '【', '[', '】', ']', '{', '}', '《', '》', '<', '>',
        '"', "'", '‘', '’', '“', '”', '·', '…', '—', '–', '\\', '|', '~',
      ])

      /** 把查询串切成词：空白和标点都当分隔符。 */
      function splitQuery(query) {
        const words = []
        let buf = ''
        for (const ch of String(query == null ? '' : query)) {
          if (/\s/u.test(ch) || QUERY_PUNCT.has(ch)) {
            if (buf) {
              words.push(buf)
              buf = ''
            }
            continue
          }
          buf += ch
        }
        if (buf) words.push(buf)
        return words
      }

      // 正则里需要转义的字符。逐字符过一遍，不写转义用的正则 —— 省得又踩一次嵌套坑。
      const NEED_ESCAPE = ['$', '{', '}', '(', ')', '[', ']', '\\', '.', '*', '+', '?', '^', '|']

      /**
       * 把命中的词包成 <mark>，返回可交给 React 的节点数组。
       * 用 split + 捕获组切，不拼 HTML 字符串 —— 搜索词来自输入框，拼串就等于开了个注入口子。
       * 词按长度倒序拼，避免短词先把长词切开（搜 "dsh dsh-plugin" 时）。
       */
      function highlight(text, terms) {
        const raw = String(text == null ? '' : text)
        const list = Array.isArray(terms) ? terms.map((term) => String(term || '').trim()).filter(Boolean) : []
        if (!raw || !list.length) return raw
        const escaped = list
          .map((term) => Array.from(term).map((ch) => (NEED_ESCAPE.includes(ch) ? '\\' + ch : ch)).join(''))
          .sort((a, b) => b.length - a.length)
        let re
        try {
          re = new RegExp('(' + escaped.join('|') + ')', 'ig')
        } catch {
          return raw
        }
        const parts = raw.split(re)
        if (parts.length < 2) return raw
        const nodes = []
        for (let i = 0; i < parts.length; i += 1) {
          if (!parts[i]) continue
          // split 带捕获组时，奇数下标是命中段。
          nodes.push(i % 2 === 1 ? h('mark', { key: 'hl' + i, className: 'gd-hl' }, parts[i]) : parts[i])
        }
        return nodes
      }

      /** 推荐程度按项目、时间按轮次、来源按分栏；条件同时生效，筛空的轮次整轮隐藏。 */
      function filterHistory(history, verdictFilter, timeFilter, sourceFilter, watchSet) {
        const floorMs = timeFloorMs(timeFilter)
        const visibleRuns = []
        let totalItemCount = 0
        let shownItemCount = 0
        for (const run of Array.isArray(history) ? history : []) {
          const all = Array.isArray(run.items) ? run.items.map((item, index) => ({ item, index })) : []
          totalItemCount += all.length
          if (floorMs && parseAtMs(run.at) < floorMs) continue
          let shown = all
          if (sourceFilter !== 'all') shown = shown.filter((entry) => itemSource(entry.item, watchSet) === sourceFilter)
          if (verdictFilter !== 'all') shown = shown.filter((entry) => String(entry.item.verdict || 'skip') === verdictFilter)
          if (shown.length === 0 && (sourceFilter !== 'all' || verdictFilter !== 'all')) continue
          shownItemCount += shown.length
          visibleRuns.push({ run, shown })
        }
        return {
          visibleRuns,
          totalItemCount,
          shownItemCount,
          filterActive: verdictFilter !== 'all' || timeFilter !== 'all' || sourceFilter !== 'all',
        }
      }

      /** 凭据状态一句话：已连接（来源 · 掩码）／匿名。 */
      function describeCredential(cred) {
        if (!cred || !cred.present) return '匿名访问'
        return '已连接 · ' + (cred.sourceLabel || '未知来源') + (cred.masked ? ' · ' + cred.masked : '')
      }

      // ── 样式 ──────────────────────────────────────────────────────────
      const CSS = [
        '.gd-wrap{display:flex;flex-direction:column;gap:18px;padding:4px 2px 32px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);}',
        '.gd-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
        '.gd-title{font-size:15px;font-weight:600;margin:0;}',
        '.gd-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin:2px 0 0;}',
        '.gd-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
        '.gd-group>h3{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0;padding:8px 10px 8px 14px;font-size:12px;font-weight:600;letter-spacing:.4px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
        '.gd-group-label{flex:0 0 auto;}',
        '.gd-filterbar{display:flex;align-items:center;gap:6px;flex:0 1 auto;font-weight:400;letter-spacing:0;}',
        '.gd-filter{font:inherit;font-size:11px;font-weight:400;padding:2px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;cursor:pointer;max-width:120px;}',
        '.gd-filter:focus{border-color:var(--dsw-alias-brand-primary);}',
        '.gd-filter-sum{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;}',
        '.gd-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);}',
        '.gd-row:first-of-type{border-top:0;}',
        '.gd-row-main{flex:1 1 auto;min-width:0;}',
        '.gd-row-label{font-size:13px;}',
        '.gd-row-hint{color:var(--dsw-alias-label-secondary);font-size:calc(12px * var(--gd-fs,1));margin-top:2px;}',
        '.gd-row-ctl{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding-top:2px;}',
        '.gd-wide{display:block;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);}',
        '.gd-wide:first-of-type{border-top:0;}',
        '.gd-input,.gd-textarea,.gd-select{width:100%;box-sizing:border-box;padding:6px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;}',
        '.gd-input:focus,.gd-textarea:focus,.gd-select:focus{border-color:var(--dsw-alias-brand-primary);}',
        '.gd-textarea{min-height:96px;max-height:240px;resize:vertical;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);line-height:1.5;}',
        '.gd-num{width:96px;}',
        '.gd-switch{position:relative;display:inline-flex;align-items:center;width:36px;height:20px;flex:0 0 auto;border-radius:999px;border:0;background:var(--dsw-alias-border-l2);cursor:pointer;padding:2px;transition:background .12s;}',
        '.gd-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}',
        '.gd-knob{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .12s ease;}',
        '.gd-switch[aria-checked="true"] .gd-knob{transform:translateX(16px);}',
        '.gd-switch:disabled{opacity:.5;cursor:not-allowed;}',
        '.gd-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 14px;font:inherit;font-size:13px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
        '.gd-btn:disabled{opacity:.5;cursor:not-allowed;}',
        '.gd-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:600;}',
        '.gd-btn-sm{padding:4px 10px;font-size:12px;}',
        '.gd-note{padding:8px 12px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
        '.gd-note[data-kind="ok"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
        '.gd-note[data-kind="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
        '.gd-note[data-kind="err"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
        '.gd-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:12px;}',
        '.gd-kv dt{color:var(--dsw-alias-label-secondary);}',
        '.gd-kv dd{margin:0;word-break:break-all;}',
        '.gd-mono{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;}',
        '.gd-table{width:100%;border-collapse:collapse;font-size:12px;}',
        '.gd-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;}',
        '.gd-table td{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;}',
        '.gd-table tr:last-child td{border-bottom:0;}',
        '.gd-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
        '.gd-spacer{flex:1 1 auto;}',
        '.gd-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
        '.gd-pill{font-size:calc(11px * var(--gd-fs,1));padding:2px 8px;border-radius:999px;border:1px solid currentColor;}',
        /* 面板高度由 JS 量视口算出来（宿主侧边栏容器不给确定高度），面板本身不滚。 */
        '.gd-panel{display:flex;flex-direction:column;box-sizing:border-box;gap:0;padding:0;overflow:hidden;}',
        '.gd-panel>.gd-top{flex:0 0 auto;padding:14px 16px 10px;}',
        '.gd-scroll{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:18px;padding:0 16px 24px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable;}',
        '.gd-scroll>*{flex:0 0 auto;}',
        '.gd-scroll::-webkit-scrollbar{width:12px;height:12px;}',
        '.gd-scroll::-webkit-scrollbar-track{background-image:repeating-linear-gradient(to bottom,rgba(255,255,255,0.28) 0px,rgba(255,255,255,0.28) 1px,transparent 1px,transparent 8px);background-size:6px 100%;background-position:center;background-repeat:no-repeat;background-color:transparent;border-left:1px solid rgba(255,255,255,0.06);}',
        '.gd-scroll::-webkit-scrollbar-thumb{background-color:rgba(255,255,255,0.5);border-radius:6px;}',
        '.gd-scroll::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,0.78);}',
        '.gd-scroll::-webkit-scrollbar-thumb:active{background-color:rgba(255,255,255,0.9);}',
        '.gd-scroll::-webkit-scrollbar-corner{background:transparent;}',
        '.gd-costrow{display:flex;gap:32px;flex-wrap:wrap;}',
        '.gd-steps{margin:6px 0 10px;padding-left:20px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;}',
        '.gd-steps li{margin:2px 0;}',
        '.gd-cred{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px;}',
        '.gd-cred-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:rgba(255,255,255,0.22);}',
        '.gd-cred-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 6px rgba(62,207,142,0.55);}',
        '.gd-details{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}',
        '.gd-details>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none;list-style:none;outline:none;}',
        '.gd-details>summary::-webkit-details-marker{display:none;}',
        '.gd-details>summary::before{content:"▸";display:inline-block;margin-right:6px;}',
        '.gd-details[open]>summary::before{content:"▾";}',
        '.gd-details[open]>summary{margin-bottom:10px;}',
        '.gd-costnum{font-size:17px;font-weight:600;line-height:1.3;}',
        '.gd-runs{padding-right:0;}',
        '.gd-run{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-base);}',
        '.gd-run-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
        '.gd-run-time{font-weight:600;font-size:calc(12px * var(--gd-fs,1));}',
        '.gd-items{margin-top:8px;display:flex;flex-direction:column;gap:8px;}',
        '.gd-item{border-left:2px solid var(--dsw-alias-brand-primary);padding-left:10px;}',
        '.gd-item-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
        '.gd-item-idx{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:5px;font-size:calc(11px * var(--gd-fs,1));font-weight:600;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);background:rgba(255,255,255,0.1);color:var(--dsw-alias-label-secondary);flex:0 0 auto;}',
        '.gd-item-repo{font-weight:600;font-size:calc(12px * var(--gd-fs,1));}',
        '.gd-item-line{font-size:calc(12px * var(--gd-fs,1));color:var(--dsw-alias-label-secondary);margin-top:2px;}',
        '.gd-item-line b{color:var(--dsw-alias-label-primary);font-weight:600;}',
        /* 四栏标签：低饱和色 + 同色系半透明气泡。染色负责「分得清」，气泡负责「看得见」；
           正文仍是次要色，所以标签只占一小块，不会抢过内容。 */
        /* 四栏标签：低饱和色 + 同色系半透明气泡，四栏各一个色，扫的时候一眼分得清。 */
        '.gd-item-line[data-k] b{display:inline-block;padding:1px 7px;margin-right:5px;border-radius:5px;line-height:1.5;font-weight:600;}',
        '.gd-item-line[data-k="what"] b{color:#82a0bd;background:rgba(130,160,189,.15);}',
        '.gd-item-line[data-k="changed"] b{color:#7fae8b;background:rgba(127,174,139,.15);}',
        '.gd-item-line[data-k="impact"] b{color:#bd9a63;background:rgba(189,154,99,.15);}',
        '.gd-item-line[data-k="action"] b{color:#9a8ec6;background:rgba(154,142,198,.15);}',
        /* 来源切换：发现 / 关注分栏显示 */
        '.gd-seg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;}',
        '.gd-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
        '.gd-seg button{font:inherit;font-size:11px;padding:3px 10px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;}',
        '.gd-seg button[data-on="1"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:600;}',
        /* 条目右侧的关注按钮 */
        '.gd-item-watch{font:inherit;font-size:11px;line-height:1.5;padding:1px 8px;margin-left:auto;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto;}',
        '.gd-item-watch[data-on="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
        '.gd-item-watch:disabled{opacity:.5;cursor:not-allowed;}',
        /* 关注视图顶部的列表 */
        '.gd-watchlist{margin-bottom:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base);}',
        '.gd-watchrow{display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;}',
        '.gd-watchrow:first-child{border-top:0;}',
        '.gd-watchrow-repo{font-weight:600;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.gd-watchrow-state{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary);}',
        '.gd-watchrow-state[data-delta="pushed"]{color:var(--dsw-alias-state-success-primary);}',
        '.gd-watchrow-time{flex:0 1 auto;margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
        '.gd-watchrow .gd-item-watch{margin-left:0;}',
        /* 历史搜索 */
        '.gd-search{flex:1 1 150px;min-width:120px;font:inherit;font-size:11px;padding:3px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;}',
        '.gd-search:focus{border-color:var(--dsw-alias-brand-primary);}',
        '.gd-search::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7;}',
        '.gd-hits{display:flex;flex-direction:column;gap:10px;}',
        /* 搜索命中：亮黄实心底 + 深色字（像浏览器 Ctrl+F 那种），扫结果时一眼能落到词上。 */
        '.gd-hl{background:#ffd666;color:#2b2410;border-radius:3px;padding:0 2px;font-weight:600;}',
        /* 热门榜单 */
        '.gd-trend{padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);}',
        '.gd-trend:first-of-type{border-top:0;}',
        '.gd-trend-rank{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:5px;font-size:calc(11px * var(--gd-fs,1));font-weight:600;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);background:rgba(255,255,255,0.1);color:var(--dsw-alias-label-secondary);flex:0 0 auto;}',
        '.gd-trend-rank[data-top="1"]{background:#ffd666;color:#2b2410;}',
        '.gd-trend-desc{font-size:calc(12px * var(--gd-fs,1));color:var(--dsw-alias-label-secondary);margin-top:2px;}',
        '.gd-hit{border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;}',
        /* 日报记录字号滑块 */
        '.gd-zoom{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;margin-left:auto;}',
        '.gd-zoom input[type="range"]{width:78px;height:14px;margin:0;padding:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;background:transparent;}',
        '.gd-zoom-label{font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary);user-select:none;}',
        '.gd-zoom-label-lg{font-size:13px;}',
      ].join('')

      // ── 基础组件 ──────────────────────────────────────────────────────
      const Note = ({ kind, children }) => h('div', { className: 'gd-note', 'data-kind': kind || 'info' }, children)
      const Group = ({ title, right, children }) => h('section', { className: 'gd-group' }, [
        h('h3', { key: 't' }, [
          h('span', { key: 'lb', className: 'gd-group-label' }, title),
          right || null,
        ]),
        ...(Array.isArray(children) ? children : [children]),
      ])
      const Row = ({ label, hint, children }) => h('div', { className: 'gd-row' }, [
        h('div', { className: 'gd-row-main', key: 'm' }, [
          h('div', { className: 'gd-row-label', key: 'l' }, label),
          hint ? h('div', { className: 'gd-row-hint', key: 'h' }, hint) : null,
        ]),
        h('div', { className: 'gd-row-ctl', key: 'c' }, children),
      ])
      const Toggle = ({ checked, onChange, disabled }) => h('button', {
        type: 'button',
        className: 'gd-switch',
        'aria-checked': checked ? 'true' : 'false',
        disabled: Boolean(disabled),
        onClick: () => onChange(!checked),
      }, h('span', { className: 'gd-knob' }))

      /** 数字输入：本地文本 state，空 / 非法值不向表单写 NaN。 */
      function NumberField({ value, min, max, onChange }) {
        const [text, setText] = useState(String(value == null ? '' : value))
        useEffect(() => {
          setText(String(value == null ? '' : value))
        }, [value])
        return h('input', {
          className: 'gd-input gd-num',
          type: 'number',
          min: min,
          max: max,
          value: text,
          onChange: (event) => {
            setText(event.target.value)
            const next = Number(event.target.value)
            if (event.target.value !== '' && Number.isFinite(next)) onChange(next)
          },
        })
      }

      const CONFIDENCE_LABELS = { high: '把握高', medium: '把握中', low: '把握低' }

      const VerdictBadge = ({ verdict }) => {
        const map = {
          worth: ['值得看', 'var(--dsw-alias-state-success-primary)'],
          watch: ['观察', 'var(--dsw-alias-state-warn-primary)'],
          skip: ['跳过', 'var(--dsw-alias-label-secondary)'],
        }
        const hit = map[verdict] || map.skip
        return h('span', { className: 'gd-pill', style: { color: hit[1] } }, hit[0])
      }

      // 关注视图里每个仓库的状态文案。空字符串 = 这轮还没检查过它。
      const WATCH_DELTA_LABELS = {
        '': '尚未检查',
        first: '首次检查',
        unchanged: '未发现更新',
        pushed: '有新推送',
        dormant: '很久没动静',
      }

      /** 关注视图顶部：当前关注列表 + 每个仓库上次检查的结果。 */
      const WatchListCard = ({ repos, state, busy, onToggle }) => {
        const list = Array.isArray(repos) ? repos : []
        if (!list.length) {
          return h(Note, null, '还没关注任何仓库。切到「发现」视图，点项目右边的「+ 关注」就能加进来。')
        }
        const info = state && typeof state === 'object' ? state : {}
        return h('div', { className: 'gd-watchlist' }, list.map((repo) => {
          const row = info[repo] || {}
          const delta = String(row.lastDelta || '')
          const tag = WATCH_DELTA_LABELS[delta] || '尚未检查'
          return h('div', { className: 'gd-watchrow', key: repo }, [
            h('span', { className: 'gd-watchrow-repo', title: repo }, repo),
            h('span', { className: 'gd-watchrow-state', 'data-delta': delta }, tag),
            h('span', { className: 'gd-watchrow-time' },
              row.checkedAt ? '上次检查 ' + String(row.checkedAt).slice(5, 16) : '还没检查过'),
            h('button', {
              type: 'button',
              className: 'gd-item-watch',
              'data-on': '1',
              disabled: busy === repo,
              title: '取消关注后，下次日报不再扫它',
              onClick: () => void onToggle(repo),
            }, busy === repo ? '处理中…' : '取消关注'),
          ])
        }))
      }

      /** GET 一个 JSON 接口，返回 { data, error, reload }。 */
      function useJson(path) {
        const [data, setData] = useState(null)
        const [error, setError] = useState(null)
        const reload = useCallback(async () => {
          try {
            const res = await fetch(path, { cache: 'no-store' })
            const payload = await res.json()
            if (payload && payload.ok) {
              setData(payload)
              setError(null)
            } else {
              setError((payload && (payload.message || payload.error)) || ('HTTP ' + res.status))
            }
          } catch (err) {
            setError('连不上插件路由：' + String((err && err.message) || err))
          }
        }, [path])
        useEffect(() => {
          void reload()
        }, [reload])
        return { data, error, reload }
      }

      // ── 设置页 ────────────────────────────────────────────────────────
      function SettingsPage() {
        const { data, error, reload } = useJson('/github-digest/config')
        const [form, setForm] = useState(null)
        const [topicsText, setTopicsText] = useState('')
        const [reposText, setReposText] = useState('')
        const [tokenInput, setTokenInput] = useState('')
        const [busy, setBusy] = useState('')
        const [msg, setMsg] = useState(null)

        useEffect(() => {
          if (!data) return
          setForm({ ...data.config })
          setTopicsText(joinLines(data.config.topics))
          setReposText(joinLines(data.config.watch_repos))
        }, [data])

        const patch = (key, value) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
        const patchSchedule = (value) => patch('schedule', value)

        const postJson = async (path, body) => {
          const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          return { res, payload: await res.json() }
        }

        const save = async () => {
          if (!form) return
          setBusy('save')
          setMsg(null)
          try {
            const body = {
              ...form,
              watch_repos: splitList(reposText),
              topics: splitList(topicsText),
            }
            delete body.tokenConfigured
            // token 输入框为空 = 不修改；服务端不会把空串当清空。
            if (tokenInput.trim()) body.token = tokenInput.trim()
            const { res, payload } = await postJson('/github-digest/config', body)
            if (!payload.ok) {
              setMsg({ kind: 'err', text: '保存失败：' + (payload.message || payload.error || res.status) })
            } else {
              setTokenInput('')
              setMsg({ kind: 'ok', text: '已保存' })
              void reload()
            }
          } catch (err) {
            setMsg({ kind: 'err', text: '保存请求失败：' + String((err && err.message) || err) })
          } finally {
            setBusy('')
          }
        }

        const runNow = async () => {
          setBusy('run')
          setMsg(null)
          try {
            const { res, payload } = await postJson('/github-digest/run-now')
            if (payload.ok) {
              setMsg({ kind: 'ok', text: '已唤醒会话' + (payload.created ? '（新建）' : '') + '。日报会写进 ' + ((data && data.paths && data.paths.outDir) || '工作区 .github-digest') + '，跑完点「重新读取」刷新状态。' })
              void reload()
            } else {
              setMsg({ kind: 'err', text: payload.message || payload.error || ('HTTP ' + res.status) })
            }
          } catch (err) {
            setMsg({ kind: 'err', text: '请求失败：' + String((err && err.message) || err) })
          } finally {
            setBusy('')
          }
        }

        const clearToken = async () => {
          setBusy('token')
          setMsg(null)
          try {
            const { res, payload } = await postJson('/github-digest/config', { clear_token: true })
            if (payload.ok) {
              setMsg({ kind: 'ok', text: '凭据已清除，回到匿名模式（60 次/小时）' })
              void reload()
            } else {
              setMsg({ kind: 'err', text: '清除失败：' + (payload.message || payload.error || res.status) })
            }
          } catch (err) {
            setMsg({ kind: 'err', text: '请求失败：' + String((err && err.message) || err) })
          } finally {
            setBusy('')
          }
        }

        if (!form || !data) {
          return h('div', { className: 'gd-wrap' }, [
            h('style', { key: 's' }, CSS),
            h('p', { key: 't', className: 'gd-sub' }, '正在读设置…'),
            error ? h(Note, { key: 'e', kind: 'err' }, error) : null,
            msg ? h(Note, { key: 'm', kind: msg.kind }, msg.text) : null,
          ])
        }

        const status = data.status || {}
        const cred = status.credential || { present: false, sourceLabel: '', masked: '' }
        const sessions = Array.isArray(data.sessions) ? data.sessions : []
        const runs = (status.recentRuns || []).slice().reverse()

        return h('div', { className: 'gd-wrap' }, [
          h('style', { key: 's' }, CSS),

          h('div', { className: 'gd-top', key: 'top' }, [
            h('div', { key: 'l' }, [
              h('h2', { className: 'gd-title' }, 'GitHub 日报设置'),
              h('p', { className: 'gd-sub' },
                '定时唤醒一个会话去扫你关注的仓库，挑出值得看的变更写日报。只读，不碰 GitHub 写操作。',
                ' 建议单独开一个会话专门跑日报 —— 工具返回的仓库数据会留在会话上下文里。'),
            ]),
            h('div', { className: 'gd-inline', key: 'r' }, [
              h(Toggle, { checked: form.enabled, onChange: (next) => patch('enabled', next) }),
              h('button', {
                type: 'button',
                className: 'gd-btn gd-btn-primary gd-btn-sm',
                disabled: busy === 'run',
                onClick: () => void runNow(),
              }, busy === 'run' ? '唤醒中…' : '立即跑一轮'),
            ]),
          ]),

          msg ? h(Note, { key: 'msg', kind: msg.kind }, msg.text) : null,
          error ? h(Note, { key: 'err', kind: 'err' }, error) : null,

          h(Group, { key: 'st', title: '运行状态' }, [
            h('div', { className: 'gd-wide', key: 'kv' }, h('dl', { className: 'gd-kv' }, [
              h('dt', { key: 'k1' }, '开关'), h('dd', { key: 'v1' }, form.enabled ? '开' : '关'),
              h('dt', { key: 'k2' }, '关注仓库'), h('dd', { key: 'v2' }, String(status.watchCount || 0) + ' 个'),
              h('dt', { key: 'k3' }, '凭据'), h('dd', { key: 'v3' }, describeCredential(cred) + (cred.present ? '（5000 次/小时）' : '（60 次/小时）')),
              h('dt', { key: 'k4' }, '上次运行'), h('dd', { key: 'v4' }, (status.lastFireAt || '还没跑过') + (status.lastFireReason ? '｜' + status.lastFireReason : '')),
              h('dt', { key: 'k5' }, '上次定时日'), h('dd', { key: 'v5' }, status.lastRunDate || '还没到过点'),
              h('dt', { key: 'k6' }, '判重表'), h('dd', { key: 'v6' }, status.seenReadable ? String(status.seenRows) + ' 条' : '读不出来（异常）'),
              h('dt', { key: 'k7' }, '日报目录'), h('dd', { key: 'v7', className: 'gd-mono' }, (data.paths && data.paths.outDir) || ''),
              h('dt', { key: 'k8' }, '数据目录'), h('dd', { key: 'v8', className: 'gd-mono', style: { fontSize: 11 } }, (data.paths && data.paths.home) || ''),
            ])),
          ]),

          h(Group, { key: 'repo', title: '关注仓库（每行一个 owner/repo）' }, [
            h('div', { className: 'gd-wide', key: 'w' }, [
              h('textarea', {
                className: 'gd-textarea',
                value: reposText,
                spellCheck: false,
                placeholder: 'deepseek-ai/deepseek-harness\nollama/ollama',
                onChange: (event) => setReposText(event.target.value),
              }),
              h('div', { className: 'gd-row-hint', style: { marginTop: 6 } },
                '留空也没关系：只要下面填了关键词，就会自动按关键词扫新项目。'),
            ]),
          ]),

          h(Group, { key: 'discover', title: '关键词 / 发现模式' }, [
            h(Row, {
              key: 'd1',
              label: '额外扫新项目',
              hint: '填了主题但没填关注仓库时，这一项自动生效，不用打开',
            }, h(Toggle, { checked: form.discover_enabled, onChange: (next) => patch('discover_enabled', next) })),
            h('div', { className: 'gd-wide', key: 'd2' }, [
              h('div', { className: 'gd-row-label' }, '主题 / 关键词'),
              h('div', { className: 'gd-row-hint', style: { marginBottom: 6 } },
                '一行一个，例如 ai agent、mcp、dsh-plugin。多词主题写在一行里，空格不会被拆开。'),
              h('textarea', {
                className: 'gd-textarea',
                style: { minHeight: 72 },
                value: topicsText,
                spellCheck: false,
                placeholder: 'dsh-plugin\nai agent\nmcp',
                onChange: (event) => setTopicsText(event.target.value),
              }),
            ]),
            h('div', { className: 'gd-wide', key: 'd2b' }, [
              h('div', { className: 'gd-row-label' }, '我的背景（可选）'),
              h('div', { className: 'gd-row-hint', style: { marginBottom: 6 } },
                '一句话说清你在做什么、关心什么。判断「对你有没有用」时模型会先看它；留空就按主题和关注仓库推断。'),
              h('textarea', {
                className: 'gd-textarea',
                style: { minHeight: 58 },
                value: form.profile_note || '',
                spellCheck: false,
                placeholder: '例如：做 DSH 插件和自动化脚本，关注成本、稳定性、部署方式；不碰前端框架',
                onChange: (event) => patch('profile_note', String(event.target.value).slice(0, 600)),
              }),
            ]),
            h(Row, { key: 'd3', label: '最少 star', hint: '默认 0 = 不限。想找小众项目就别设太高，50 以上会把新项目全筛掉' },
              h(NumberField, { value: form.min_stars, min: 0, max: 500000, onChange: (next) => patch('min_stars', next) })),
            h(Row, { key: 'd4', label: '只看最近几天创建', hint: '找新项目时用，0 表示不限' },
              h(NumberField, { value: form.discover_created_within_days, min: 0, max: 365, onChange: (next) => patch('discover_created_within_days', next) })),
          ]),

          h(Group, { key: 'when', title: '定时与投递' }, [
            h(Row, { key: 'r1', label: '定时', hint: '到点唤醒会话跑一轮。建议选谷时（12:00-14:00 或 18:00 之后），模型价格便宜一半' }, [
              h('select', {
                className: 'gd-select',
                style: { width: 130 },
                value: form.schedule.mode,
                onChange: (event) => patchSchedule({ ...form.schedule, mode: event.target.value }),
              }, [
                h('option', { key: 'm', value: 'manual' }, '只手动'),
                h('option', { key: 'd', value: 'daily' }, '每天'),
                h('option', { key: 'w', value: 'weekdays' }, '指定星期'),
              ]),
              h('input', {
                className: 'gd-input',
                type: 'time',
                style: { width: 120 },
                value: form.schedule.at,
                onChange: (event) => patchSchedule({ ...form.schedule, at: event.target.value }),
              }),
            ]),
            form.schedule.mode === 'weekdays'
              ? h('div', { className: 'gd-wide', key: 'wk' }, [
                h('div', { className: 'gd-row-hint', style: { marginBottom: 6 } }, '选星期（不选 = 每天）'),
                h('div', { className: 'gd-inline' }, ['日', '一', '二', '三', '四', '五', '六'].map((name, idx) => {
                  const on = (form.schedule.weekdays || []).includes(idx)
                  return h('button', {
                    key: idx,
                    type: 'button',
                    className: 'gd-btn gd-btn-sm',
                    style: on ? { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' } : undefined,
                    onClick: () => {
                      const set = new Set(form.schedule.weekdays || [])
                      if (set.has(idx)) set.delete(idx)
                      else set.add(idx)
                      patchSchedule({ ...form.schedule, weekdays: [...set].sort((a, b) => a - b) })
                    },
                  }, name)
                })),
              ])
              : null,
            h(Row, { key: 'r2', label: '目标会话', hint: '投到这个会话执行。列表是全部未归档会话，按最近活动排；留空 = 每轮自动新建' }, [
              h('select', {
                className: 'gd-select',
                style: { width: 220 },
                value: form.target_session_id,
                onChange: (event) => patch('target_session_id', event.target.value),
              }, [
                h('option', { key: 'none', value: '' }, '（不指定，自动新建或复用当天的）'),
                ...sessions.map((session) => h('option', { key: session.id, value: session.id }, session.title || session.id.slice(0, 12))),
                form.target_session_id && !sessions.some((session) => session.id === form.target_session_id)
                  ? h('option', { key: 'cur', value: form.target_session_id }, '（当前已选，但本机找不到：' + form.target_session_id.slice(0, 8) + '）')
                  : null,
              ]),
            ]),
          ]),

          h(Group, { key: 'scale', title: '每轮规模' }, [
            h(Row, { key: 'r3', label: '每轮收取上限', hint: cred.present ? '往报告里放几条。每条要细读一次，1-2 次请求。有 token 时额度不是瓶颈，这条控制的是报告长度和本轮费用' : '往报告里放几条。每条要细读一次（1-2 次请求），6 条约 8 次请求，匿名额度（60 次/小时）能跑 7 轮' },
              h(NumberField, { value: form.max_items_per_run, min: 1, max: 20, onChange: (next) => patch('max_items_per_run', next) })),
            h(Row, { key: 'r3b', label: '每轮最多看几个仓库', hint: cred.present ? '粗筛用一次批量查询拿全部元信息，多看几个几乎不花额度；真正花额度的是上面那条「收取」。上限 60 = 关注仓库上限' : '粗筛用 1 次请求批量拿元信息，40 个和 20 个的配额差是 0；真正花配额的是上面那条「收取」' },
              h(NumberField, { value: form.max_repos_per_run, min: 1, max: 60, onChange: (next) => patch('max_repos_per_run', next) })),
            h(Row, { key: 'r3coldmin', label: '冷门配额', hint: '每轮至少收几条 star 少的项目。0 = 不限，按平时标准走；想专门挖冷门就设 2-3 条' },
              h(NumberField, { value: form.cold_pick_min, min: 0, max: 20, onChange: (next) => patch('cold_pick_min', next) })),
            h(Row, { key: 'r3coldmax', label: '冷门线（star ≤）', hint: '多少 star 以下算冷门。默认 500；这个数决定了「冷门」的门槛' },
              h(NumberField, { value: form.cold_pick_max_stars, min: 0, max: 200000, onChange: (next) => patch('cold_pick_max_stars', next) })),
          ]),

          h(Group, { key: 'env', title: '运行环境' }, [
            h('div', { className: 'gd-wide', key: 'r3c' }, [
              h('div', { className: 'gd-row-label' }, '工作区'),
              h('div', { className: 'gd-row-hint', style: { marginBottom: 6 } },
                '自动新建的日报会话归到这个工作区。留空 = 自动挑宿主的默认工作区。日报写在该工作区的 .github-digest 下。'),
              h('input', {
                className: 'gd-input',
                value: form.workspace || '',
                placeholder: 'C:\\Users\\...\\default-workspace',
                onChange: (event) => patch('workspace', event.target.value),
              }),
            ]),
            h(Row, {
              key: 'r3d',
              label: '每轮新开会话',
              hint: '默认关（当天复用同一个会话）。打开后每轮成本绝对精确，代价是会话数变多',
            }, h(Toggle, { checked: form.fresh_session_per_run, onChange: (next) => patch('fresh_session_per_run', next) })),
          ]),

          h(Group, { key: 'read', title: '读什么' }, [
            h(Row, {
              key: 'r3e',
              label: '粗筛时顺带拉 releases',
              hint: '默认关。关着时粗筛只花 1 次请求；打开后粗筛顺带把新版本标题也拿回来（每仓库多 1 次请求）。下面「读 releases」管的是细读阶段',
            }, h(Toggle, { checked: form.brief_fetch_releases, onChange: (next) => patch('brief_fetch_releases', next) })),
            h(Row, { key: 'r4', label: '读 README', hint: '关掉更省额度，但判断会变浅' },
              h(Toggle, { checked: form.read_readme, onChange: (next) => patch('read_readme', next) })),
            h(Row, { key: 'r5', label: '读 releases', hint: '新版本是判断的主依据' },
              h(Toggle, { checked: form.read_releases, onChange: (next) => patch('read_releases', next) })),
            h(Row, { key: 'r6', label: '读 commits', hint: '没发 release 的项目靠它看变化' },
              h(Toggle, { checked: form.read_commits, onChange: (next) => patch('read_commits', next) })),
            h(Row, { key: 'r7', label: 'release 正文截断', hint: '正文直接进模型上下文，单位字符。600 是「够判断、不烧 token」的折中；调到 1200 以上判断更准，但每轮更贵' },
              h(NumberField, { value: form.release_body_chars, min: 200, max: 3000, onChange: (next) => patch('release_body_chars', next) })),
          ]),

          h(Group, { key: 'tok', title: 'GitHub 访问凭据' }, [
            h('div', { className: 'gd-wide', key: 'w' }, [
              h('div', { className: 'gd-cred' }, [
                h('span', { key: 'd', className: 'gd-cred-dot', 'data-on': cred.present ? '1' : '0' }),
                h('span', { key: 't' }, describeCredential(cred) + (cred.present ? '（5000 次/小时）' : '（60 次/小时）')),
              ]),
              h('div', { className: 'gd-row-hint' },
                cred.present
                  ? '只读够用：插件只发 GET 请求，不发 issue、不点 star、不改仓库。token 只存本机，页面上只显示前后各 4 位。'
                  : '不用做任何事。匿名每小时 60 次，一轮用 3-8 次，定时一天一次永远碰不到上限。'),
              h('details', { className: 'gd-details', key: 'more' }, [
                h('summary', null, cred.present ? '更换或清除 token' : '想更快？填一个只读 token（可选）'),
                h('ol', { className: 'gd-steps' }, [
                  h('li', { key: 'a' }, '打开 github.com/settings/tokens?type=beta'),
                  h('li', { key: 'b' }, '点 Generate new token，名字随便填，选 Public repositories (read-only)'),
                  h('li', { key: 'c' }, 'Expiration 选 90 天或 No expiration，点 Generate token'),
                  h('li', { key: 'd' }, '复制生成的那串（github_pat_... 或 ghp_... 开头），粘到下面'),
                ]),
                h('div', { className: 'gd-row-hint', style: { marginBottom: 8 } },
                  '不想填也行。插件启动时会自己去本机找：环境变量 GITHUB_TOKEN / GH_TOKEN、gh 命令行、gh 配置文件、.git-credentials、系统凭据管理器（git / GitHub Desktop / Visual Studio 登录过的都在这里）。找到就用，找不到就匿名跑。'),
                h('div', { className: 'gd-inline' }, [
                  h('input', {
                    key: 'i',
                    className: 'gd-input',
                    type: 'password',
                    style: { width: 320 },
                    value: tokenInput,
                    placeholder: cred.present ? '已配置（留空 = 不修改）' : 'github_pat_... 或 ghp_...',
                    onChange: (event) => setTokenInput(event.target.value),
                  }),
                  cred.present
                    ? h('button', {
                      key: 'c',
                      type: 'button',
                      className: 'gd-btn gd-btn-sm',
                      disabled: busy === 'token',
                      onClick: () => void clearToken(),
                    }, '清除')
                    : null,
                ]),
              ]),
            ]),
          ]),

          h('div', { className: 'gd-actions', key: 'act' }, [
            h('button', {
              type: 'button',
              className: 'gd-btn gd-btn-primary',
              disabled: busy === 'save',
              onClick: () => void save(),
            }, busy === 'save' ? '保存中…' : '保存'),
            h('button', { type: 'button', className: 'gd-btn', disabled: Boolean(busy), onClick: () => void reload() }, '重新读取'),
            h('span', { className: 'gd-spacer' }),
            h('span', { className: 'gd-row-hint' }, '改完记得点保存'),
          ]),

          h(Group, { key: 'runs', title: '最近执行记录' }, [
            h('div', { className: 'gd-wide', key: 't' },
              runs.length === 0
                ? h(Note, null, '还没有执行记录。跑一轮后这里会出现。')
                : h('table', { className: 'gd-table' }, [
                  h('thead', { key: 'h' }, h('tr', null, ['时间', '触发', '结果', '关注', '收取', '跳过', '额度', '备注'].map((cell) => h('th', { key: cell }, cell)))),
                  h('tbody', { key: 'b' }, runs.map((run, index) => h('tr', { key: index }, [
                    h('td', { key: 't' }, run.time),
                    h('td', { key: 'g' }, labelOf(TRIGGER_LABELS, run.trigger)),
                    h('td', { key: 'r' }, labelOf(RESULT_LABELS, run.result)),
                    h('td', { key: 'w' }, String(run.watched)),
                    h('td', { key: 'k' }, String(run.kept)),
                    h('td', { key: 's' }, String(run.skipped)),
                    h('td', { key: 'q' }, run.quota),
                    h('td', { key: 'n' }, run.note),
                  ]))),
                ])),
          ]),
        ])
      }

      // ── 侧边栏：日报面板 ──────────────────────────────────────────────
      const SidebarIcon = () => h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }, [
        h('path', { key: 'a', d: 'M4 5h16v14H4z' }),
        h('path', { key: 'b', d: 'M4 9h16' }),
        h('path', { key: 'c', d: 'M8 3v4M16 3v4' }),
        h('circle', { key: 'd', cx: 9, cy: 13, r: 1.2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'e', cx: 13, cy: 13, r: 1.2, fill: 'currentColor', stroke: 'none' }),
      ])

      function DigestPanel() {
        const { data, error, reload } = useJson('/github-digest/panel')
        const [busy, setBusy] = useState('')
        const [msg, setMsg] = useState(null)
        const [verdictFilter, setVerdictFilter] = useState('all')
        const [timeFilter, setTimeFilter] = useState('all')
        // 来源分栏：all 全部 / discover 发现 / watch 关注
        const [sourceFilter, setSourceFilter] = useState('all')
        // 关注列表放本地状态：点按钮后立刻变样，不用等整页重拉。
        const [watchList, setWatchList] = useState(null)
        const [watchBusy, setWatchBusy] = useState('')
        // 历史搜索：输入框内容 → 防抖后的词 → /search 的结果
        const [searchText, setSearchText] = useState('')
        const [searchQuery, setSearchQuery] = useState('')
        const [searchHits, setSearchHits] = useState(null)
        const [searchBusy, setSearchBusy] = useState(false)
        // 输入法组词中：拼音还没变成汉字。这时候不许拿半截拼音去搜。
        const [composing, setComposing] = useState(false)
        // 热门榜单：默认收起，展开才拉（Search 有独立限速，别为了没人看的区白打请求）。
        const [trendingOpen, setTrendingOpen] = useState(false)
        const [trendingWindow, setTrendingWindow] = useState('week')
        const [trending, setTrending] = useState(null)
        const [trendingBusy, setTrendingBusy] = useState(false)
        const [trendingError, setTrendingError] = useState('')
        // 只读一次配置里的默认值：用户手动切过时间窗之后，面板刷新不该把它改回去。
        const trendingTouched = useRef(false)
        // 记录区字号倍率。读不出来就按 1（原始大小）走，不因为存储异常把面板搞坏。
        const [fontScale, setFontScale] = useState(() => {
          try {
            const value = Number(window.localStorage.getItem(FONT_SCALE_KEY))
            return Number.isFinite(value) && value >= FONT_SCALE_MIN && value <= FONT_SCALE_MAX ? value : 1
          } catch {
            return 1
          }
        })
        const panelRef = useRef(null)
        const fitRef = useRef(Number.POSITIVE_INFINITY)
        const jumpedRef = useRef(false)

        /**
         * 面板高度：宿主的侧边栏容器不给确定高度，纯 CSS 的 max-height / calc(100vh) 不生效（实测）。
         * 改成量真实布局：面板顶边到窗口底还剩多少；顺带向上探 6 层祖先，遇到更小的边界就用它。
         * 设完高度后 .gd-panel 自己不滚，滚动交给 .gd-scroll，滚动条落在侧边栏最右缘。
         */
        useEffect(() => {
          const el = panelRef.current
          if (!el || typeof el.getBoundingClientRect !== 'function') return
          const bornAt = Date.now()
          let stop = false
          const measure = () => {
            const rect = el.getBoundingClientRect()
            if (!rect || !Number.isFinite(rect.top)) return 0
            let limit = window.innerHeight - rect.top - 10
            let node = el.parentElement
            for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) {
              const box = node.getBoundingClientRect()
              if (!box || !(box.height > 0)) continue
              if (box.height >= window.innerHeight - 2) continue
              const style = window.getComputedStyle ? window.getComputedStyle(node) : null
              const padBottom = style ? (parseFloat(style.paddingBottom) || 0) : 0
              const room = box.bottom - rect.top - padBottom - 4
              if (room > 0 && room < limit) limit = room
            }
            return limit
          }
          const fit = () => {
            if (stop) return
            const limit = Math.floor(measure())
            if (!(limit > 200)) return
            // 挂载后 900ms 内允许自适应放大（首帧量出来可能偏小），之后只收紧，防止来回抖。
            const fresh = Date.now() - bornAt < 900
            const next = fresh ? limit : Math.min(fitRef.current, limit)
            fitRef.current = next
            el.style.height = next + 'px'
            el.style.maxHeight = next + 'px'
          }
          const remeasure = () => {
            fitRef.current = Number.POSITIVE_INFINITY
            fit()
          }
          // 打开面板时缓动落到「日报记录」顶上：消耗区滚上去，记录区独享一屏。只跳一次。
          const jump = () => {
            if (jumpedRef.current) return
            const scroller = el.querySelector('.gd-scroll')
            const anchor = el.querySelector('.gd-runs')
            const target = anchor && anchor.closest ? (anchor.closest('.gd-group') || anchor) : null
            if (!scroller || !target) return
            const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 4
            if (delta > 1) smoothScrollTo(scroller, delta, 560)
            jumpedRef.current = true
          }
          fit()
          const raf = requestAnimationFrame(fit)
          const timer = setTimeout(() => {
            fit()
            jump()
          }, 400)
          window.addEventListener('resize', remeasure)
          return () => {
            stop = true
            cancelAnimationFrame(raf)
            clearTimeout(timer)
            window.removeEventListener('resize', remeasure)
          }
        }, [data])

        // 服务端返回的关注列表同步进本地状态（首次加载 / 点刷新时）。
        useEffect(() => {
          if (data && Array.isArray(data.watchRepos)) setWatchList(data.watchRepos)
        }, [data])

        const watchRepos = Array.isArray(watchList)
          ? watchList
          : (data && Array.isArray(data.watchRepos) ? data.watchRepos : [])
        const watchSet = new Set(watchRepos.map((item) => String(item).toLowerCase()))

        useEffect(() => {
          try {
            window.localStorage.setItem(FONT_SCALE_KEY, String(fontScale))
          } catch {
            /* 隐私模式 / 存储被禁时写不进去，不影响本次使用 */
          }
        }, [fontScale])

        // 输入停下 320ms 才发请求，别每敲一个字打一次接口。
        // 输入法组词期间一律跳过：否则打「bili」时会把 "bi" 当查询词，
        // 组词时一直显示「找到 0 条」，选完字结果才整批跳出来，很突兀。
        useEffect(() => {
          if (composing) return undefined
          const next = searchText.trim()
          if (!next) {
            setSearchQuery('')
            setSearchHits(null)
            return undefined
          }
          const timer = setTimeout(() => setSearchQuery(next), 320)
          return () => clearTimeout(timer)
        }, [searchText, composing])

        // 配置里的默认时间窗只在第一次拿到面板数据时生效。
        useEffect(() => {
          if (trendingTouched.current) return
          if (data && data.trending && data.trending.window) setTrendingWindow(data.trending.window)
        }, [data])

        // 榜单数据走服务端代理（api.github.com 国内通常直连可达，不需要梯子）。
        useEffect(() => {
          if (!trendingOpen) return undefined
          let cancelled = false
          setTrendingBusy(true)
          setTrendingError('')
          fetch('/github-digest/trending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              window: trendingWindow,
              limit: (data && data.trending && data.trending.limit) || 15,
            }),
          })
            .then((res) => res.json())
            .then((payload) => {
              if (cancelled) return
              if (payload && payload.ok) setTrending(payload)
              else setTrendingError((payload && (payload.message || payload.code)) || '拉榜单失败')
            })
            .catch((err) => {
              if (!cancelled) setTrendingError('请求失败：' + String((err && err.message) || err))
            })
            .finally(() => {
              if (!cancelled) setTrendingBusy(false)
            })
          return () => {
            cancelled = true
          }
        }, [trendingOpen, trendingWindow])

        // 搜索放在服务端：面板只有最近 20 轮，更早的记录只有 history.jsonl 里有。
        useEffect(() => {
          if (!searchQuery) return undefined
          let cancelled = false
          setSearchBusy(true)
          fetch('/github-digest/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: searchQuery, limit: 50 }),
          })
            .then((res) => res.json())
            .then((payload) => {
              if (cancelled) return
              setSearchHits(payload && payload.ok && Array.isArray(payload.hits) ? payload.hits : [])
            })
            .catch(() => {
              if (!cancelled) setSearchHits([])
            })
            .finally(() => {
              if (!cancelled) setSearchBusy(false)
            })
          return () => {
            cancelled = true
          }
        }, [searchQuery])

        /** 关注 / 取消关注。只动本机 config.json 的 watch_repos，不对 GitHub 发任何写请求。 */
        const toggleWatch = async (repo) => {
          const name = String(repo || '')
          if (!name) return
          const wanted = !watchSet.has(name.toLowerCase())
          setWatchBusy(name)
          setMsg(null)
          try {
            const res = await fetch('/github-digest/watch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repo: name, op: wanted ? 'add' : 'remove' }),
            })
            const payload = await res.json()
            if (!payload.ok) {
              setMsg({ kind: 'err', text: payload.message || payload.error || ('HTTP ' + res.status) })
            } else {
              if (Array.isArray(payload.repos)) setWatchList(payload.repos)
              setMsg({ kind: 'ok', text: name + ' · ' + (payload.message || (wanted ? '已加入关注' : '已取消关注')) })
            }
          } catch (err) {
            setMsg({ kind: 'err', text: '关注请求失败：' + String((err && err.message) || err) })
          } finally {
            setWatchBusy('')
          }
        }

        const runNow = async () => {
          setBusy('run')
          setMsg(null)
          try {
            const res = await fetch('/github-digest/run-now', { method: 'POST' })
            const payload = await res.json()
            if (payload.ok) {
              setMsg({ kind: 'ok', text: '日报已启动（' + (payload.created ? '新建了会话' : '投到指定会话') + '）。跑完刷新这里就能看到结果。' })
              setTimeout(() => void reload(), 1500)
            } else {
              setMsg({ kind: 'err', text: payload.message || payload.error || ('HTTP ' + res.status) })
            }
          } catch (err) {
            setMsg({ kind: 'err', text: '请求失败：' + String((err && err.message) || err) })
          } finally {
            setBusy('')
          }
        }

        if (!data) {
          return h('div', { className: 'gd-wrap gd-panel', ref: panelRef }, [
            h('style', { key: 's' }, CSS),
            h('div', { key: 'b', className: 'gd-scroll', style: { paddingTop: 14 } }, [
              h('p', { key: 't', className: 'gd-sub' }, '正在读日报数据…'),
              error ? h(Note, { key: 'e', kind: 'err' }, error) : null,
              msg ? h(Note, { key: 'm', kind: msg.kind }, msg.text) : null,
            ]),
          ])
        }

        const cost = data.cost || {}
        const sessions = Array.isArray(cost.sessions) ? cost.sessions : []
        const history = Array.isArray(data.history) ? data.history : []
        const total = cost.total || null
        const latestRun = history[0]
        const latestVolume = latestRun && latestRun.repoVolume && Number(latestRun.repoVolume.total) > 0 ? latestRun.repoVolume : null
        const latestCostRow = history.find((row) => row && row.cost) || null
        const latestCost = latestCostRow ? latestCostRow.cost : null
        const cumulative = data.cumulative && data.cumulative.rounds > 0 ? data.cumulative : null
        const costFor = (sessionId) => {
          if (!sessionId) return null
          return sessions.find((session) => session.id === sessionId) || null
        }
        const filtered = filterHistory(history, verdictFilter, timeFilter, sourceFilter, watchSet)
        // 搜索结果同样吃来源 / 推荐度 / 时间三个筛选，省得搜完还得再挑一遍。
        const searchTerms = searchQuery ? splitQuery(searchQuery) : []
        const searchFloorMs = timeFloorMs(timeFilter)
        const filteredHits = (Array.isArray(searchHits) ? searchHits : []).filter((hit) => {
          if (!hit) return false
          if (sourceFilter !== 'all' && itemSource(hit, watchSet) !== sourceFilter) return false
          if (verdictFilter !== 'all' && String(hit.verdict || 'skip') !== verdictFilter) return false
          if (searchFloorMs && parseAtMs(hit.at) < searchFloorMs) return false
          return true
        })

        return h('div', { className: 'gd-wrap gd-panel', ref: panelRef }, [
          h('style', { key: 's' }, CSS),

          h('div', { className: 'gd-top', key: 'top' }, [
            h('div', { key: 'l' }, [
              h('h2', { className: 'gd-title' }, 'GitHub 日报'),
              h('p', { className: 'gd-sub' },
                '关注 ' + String(data.watchCount) + ' 个仓库｜定时 ' +
                (data.schedule && data.schedule.mode === 'manual' ? '只手动' : ((data.schedule && data.schedule.at) || '12:30')) +
                '｜' + (data.enabled ? '已开启' : '已关闭')),
            ]),
            h('div', { className: 'gd-inline', key: 'r' }, [
              h('button', {
                type: 'button',
                className: 'gd-btn gd-btn-primary gd-btn-sm',
                disabled: busy === 'run',
                onClick: () => void runNow(),
              }, busy === 'run' ? '启动中…' : '立即跑一轮'),
              h('button', { type: 'button', className: 'gd-btn gd-btn-sm', onClick: () => void reload() }, '刷新'),
            ]),
          ]),

          h('div', { className: 'gd-scroll', key: 'body' }, [
            msg ? h(Note, { key: 'msg', kind: msg.kind }, msg.text) : null,
            error ? h(Note, { key: 'err', kind: 'err' }, error) : null,

            h(Group, { key: 'cost', title: '消耗' }, [
              h('div', { className: 'gd-wide', key: 'round' },
                latestCost
                  ? h('div', { className: 'gd-costrow' }, [
                    h('div', { key: 'a' }, [
                      h('div', { className: 'gd-costnum' }, (latestCost.exact === false ? '≈' : '') + fmtMoney(latestCost.costCny)),
                      h('div', { className: 'gd-row-hint' }, latestCost.exact === false
                        ? '本轮费用（期间另有 ' + String(latestCost.turnsDelta || 0) + ' 次交互，数值含它们）'
                        : '本轮费用（' + String(latestCostRow.at || '').slice(0, 16) + '）'),
                    ]),
                    h('div', { key: 'b' }, [h('div', { className: 'gd-costnum' }, fmtNum(latestCost.input)), h('div', { className: 'gd-row-hint' }, '本轮输入 token')]),
                    h('div', { key: 'c' }, [h('div', { className: 'gd-costnum' }, fmtNum(latestCost.output)), h('div', { className: 'gd-row-hint' }, '本轮输出 token')]),
                    h('div', { key: 'd' }, [h('div', { className: 'gd-costnum' }, fmtNum(latestCost.cacheRead)), h('div', { className: 'gd-row-hint' }, '本轮缓存读')]),
                  ])
                  : h(Note, null, '还没有带成本数据的记录。跑一轮后这里会有「本轮费用 / token」。')),
              h('div', { className: 'gd-wide', key: 'cum' },
                cumulative
                  ? h('div', { className: 'gd-costrow' }, [
                    h('div', { key: 'a' }, [h('div', { className: 'gd-costnum' }, fmtMoney(cumulative.costCny)), h('div', { className: 'gd-row-hint' }, '日报累计费用（' + String(cumulative.rounds) + ' 轮）')]),
                    h('div', { key: 'b' }, [h('div', { className: 'gd-costnum' }, fmtNum(cumulative.input + cumulative.output)), h('div', { className: 'gd-row-hint' }, '累计输入+输出 token')]),
                    h('div', { key: 'c' }, [h('div', { className: 'gd-costnum' }, fmtNum(cumulative.cacheRead)), h('div', { className: 'gd-row-hint' }, '累计缓存读')]),
                  ])
                  : h('div', { className: 'gd-row-hint' }, '还没有累计数据')),
              total
                ? h('div', { className: 'gd-wide', key: 'today' },
                  h('div', { className: 'gd-costrow' }, [
                    h('div', { key: 'a' }, [h('div', { className: 'gd-costnum' }, fmtMoney(total.costCny)), h('div', { className: 'gd-row-hint' }, '今日全部（含其他会话）')]),
                    h('div', { key: 'b' }, [h('div', { className: 'gd-costnum' }, fmtNum(total.input)), h('div', { className: 'gd-row-hint' }, '今日输入 token')]),
                    h('div', { key: 'c' }, [h('div', { className: 'gd-costnum' }, fmtNum(total.output)), h('div', { className: 'gd-row-hint' }, '今日输出 token')]),
                    h('div', { key: 'd' }, [h('div', { className: 'gd-costnum' }, String(total.calls)), h('div', { className: 'gd-row-hint' }, '调用次数')]),
                  ]))
                : h('div', { className: 'gd-wide', key: 'today' }, h(Note, null, cost.reason || '没检测到 cost-meter')),
              latestVolume
                ? h('div', { className: 'gd-wide', key: 'vol' }, [
                  h('div', { className: 'gd-costrow' }, [
                    h('div', { key: 'a' }, [h('div', { className: 'gd-costnum' }, fmtNum(latestVolume.total)), h('div', { className: 'gd-row-hint' }, '本轮估算 token（' + String(latestVolume.count) + ' 个项目）')]),
                    h('div', { key: 'b' }, [h('div', { className: 'gd-costnum' }, fmtNum(latestVolume.avg)), h('div', { className: 'gd-row-hint' }, '平均每项目')]),
                    latestVolume.top
                      ? h('div', { key: 'c' }, [
                        h('div', { className: 'gd-costnum gd-mono', style: { fontSize: 13 } }, fmtNum(latestVolume.top.tokens)),
                        h('div', { className: 'gd-row-hint' }, '最贵：' + String(latestVolume.top.repo)),
                      ])
                      : null,
                  ]),
                ])
                : null,
            ]),

            h(Group, {
              key: 'hist',
              title: '日报记录',
              right: h('div', { key: 'hf', className: 'gd-filterbar' }, [
                h('select', {
                  key: 'vf',
                  className: 'gd-filter',
                  value: verdictFilter,
                  title: '按推荐程度筛选项目',
                  onChange: (event) => setVerdictFilter(event.target.value),
                }, VERDICT_FILTERS.map((pair) => h('option', { key: pair[0], value: pair[0] }, pair[1]))),
                h('select', {
                  key: 'tf',
                  className: 'gd-filter',
                  value: timeFilter,
                  title: '按时间筛选记录',
                  onChange: (event) => setTimeFilter(event.target.value),
                }, TIME_FILTERS.map((pair) => h('option', { key: pair[0], value: pair[0] }, pair[1]))),
              ]),
            }, [
              // --gd-fs 挂在这个块上：记录区和搜索结果的字号跟着它走，面板其它部分不受影响。
              h('div', { className: 'gd-wide', key: 'h', style: { '--gd-fs': String(fontScale) } }, [
                h('div', { className: 'gd-seg-row', key: 'segrow' }, [
                  h('div', { className: 'gd-seg', key: 'src' }, SOURCE_FILTERS.map((pair) => h('button', {
                    key: pair[0],
                    type: 'button',
                    'data-on': sourceFilter === pair[0] ? '1' : '0',
                    onClick: () => setSourceFilter(pair[0]),
                  }, pair[1]))),
                  h('input', {
                    key: 'q',
                    className: 'gd-search',
                    type: 'search',
                    placeholder: '搜项目名 / 是什么 / 变化 / 影响 / 建议',
                    value: searchText,
                    onCompositionStart: () => setComposing(true),
                    onCompositionEnd: (event) => {
                      setComposing(false)
                      // 有些浏览器组词结束时不再补发 change，这里补一次，保证选中的汉字进搜索词。
                      setSearchText(event.currentTarget.value)
                    },
                    // 组词中失焦（点到别处）也可能收不到 compositionend，兜一下，别把 subsequent 搜索全卡住。
                    onBlur: () => setComposing(false),
                    onChange: (event) => setSearchText(event.target.value),
                  }),
                  h('label', { key: 'zoom', className: 'gd-zoom', title: '日报记录字号，记住到本机' }, [
                    h('span', { key: 'sm', className: 'gd-zoom-label' }, 'A'),
                    h('input', {
                      key: 'range',
                      type: 'range',
                      min: String(FONT_SCALE_MIN),
                      max: String(FONT_SCALE_MAX),
                      step: '0.05',
                      value: String(fontScale),
                      onChange: (event) => setFontScale(Number(event.target.value)),
                    }),
                    h('span', { key: 'lg', className: 'gd-zoom-label gd-zoom-label-lg' }, 'A'),
                  ]),
                ]),
                searchQuery ? null : sourceFilter === 'watch'
                  ? h(WatchListCard, {
                    key: 'wl',
                    repos: watchRepos,
                    state: data.watchState,
                    busy: watchBusy,
                    onToggle: toggleWatch,
                  })
                  : null,
                searchQuery
                  ? h('div', { key: 'sr' }, [
                    h('div', { key: 'rs', className: 'gd-filter-sum' },
                      searchBusy
                        ? '搜索中…'
                        : '「' + searchQuery + '」找到 ' + String(filteredHits.length) + ' 条' +
                          (Array.isArray(searchHits) && searchHits.length >= 50 ? '（只列前 50 条，加个词缩小范围）' : '')),
                    filteredHits.length === 0
                      ? h(Note, { key: 'none' }, searchBusy ? '正在搜索…' : '没有匹配的项目。换个词，或者把上面的筛选放宽。')
                      : h('div', { key: 'list', className: 'gd-hits' }, filteredHits.map((hit, index) => {
                        const hitRepo = String(hit.repo || '')
                        const hitWatched = watchSet.has(hitRepo.toLowerCase())
                        const hitPending = watchBusy === hitRepo
                        return h('div', { className: 'gd-hit', key: hitRepo + '@' + String(hit.at || '') + '@' + index }, [
                          h('div', { className: 'gd-item-head' }, [
                            h('span', { className: 'gd-item-repo' }, highlight(hitRepo, searchTerms)),
                            hit.stars != null ? h('span', { className: 'gd-row-hint' }, '★' + fmtNum(hit.stars)) : null,
                            h(VerdictBadge, { verdict: String(hit.verdict || 'skip') }),
                            h('span', { className: 'gd-row-hint' }, String(hit.at || '').slice(0, 16)),
                            itemSource(hit, watchSet) === 'watch'
                              ? h('span', { className: 'gd-pill', style: { color: 'var(--dsw-alias-label-secondary)' } }, '关注')
                              : null,
                            hitRepo
                              ? h('button', {
                                type: 'button',
                                className: 'gd-item-watch',
                                'data-on': hitWatched ? '1' : '0',
                                disabled: hitPending,
                                title: hitWatched ? '点一下取消关注' : '加入关注仓库',
                                onClick: () => void toggleWatch(hitRepo),
                              }, hitPending ? '…' : (hitWatched ? '已关注' : '+ 关注'))
                              : null,
                          ]),
                          hit.what ? h('div', { className: 'gd-item-line', 'data-k': 'what' }, [h('b', { className: 'gd-tag' }, '是什么'), highlight(hit.what, searchTerms)]) : null,
                          hit.whatChanged ? h('div', { className: 'gd-item-line', 'data-k': 'changed' }, [h('b', { className: 'gd-tag' }, '变化'), highlight(hit.whatChanged, searchTerms)]) : null,
                          hit.impact ? h('div', { className: 'gd-item-line', 'data-k': 'impact' }, [h('b', { className: 'gd-tag' }, '影响'), highlight(hit.impact, searchTerms)]) : null,
                          hit.action ? h('div', { className: 'gd-item-line', 'data-k': 'action' }, [h('b', { className: 'gd-tag' }, '建议'), highlight(hit.action, searchTerms)]) : null,
                        ])
                      })),
                  ])
                  : null,
                searchQuery || !filtered.filterActive ? null : h('div', { key: 'sum', className: 'gd-filter-sum' },
                  '显示 ' + String(filtered.shownItemCount) + ' / ' + String(filtered.totalItemCount) +
                  ' 个项目 · ' + String(filtered.visibleRuns.length) + ' 轮记录'),
                searchQuery ? null : filtered.visibleRuns.length === 0
                  ? h(Note, { key: 'empty' },
                    sourceFilter === 'watch'
                      ? (watchRepos.length
                        ? '关注的项目在现有记录里还没有条目。上面列了每个项目的上次检查结果，下次日报跑完就会有。'
                        : '还没关注任何仓库，切到「发现」视图点「+ 关注」。')
                      : (filtered.filterActive ? '当前筛选下没有记录。' : '还没有记录。点上面的「立即跑一轮」，或等定时触发。'))
                  : h('div', { className: 'gd-runs', key: 'list' }, filtered.visibleRuns.map((row) => {
                    const run = row.run
                    const sessionCost = costFor(run.sessionId)
                    return h('div', { className: 'gd-run', key: String(run.at || '') + String(run.sessionId || '') }, [
                      h('div', { className: 'gd-run-head' }, [
                        h('span', { className: 'gd-run-time' }, run.at || ''),
                        h('span', { className: 'gd-pill' }, labelOf(TRIGGER_LABELS, run.trigger)),
                        h('span', {
                          className: 'gd-pill',
                          style: run.result === 'ok' ? { color: 'var(--dsw-alias-state-success-primary)' } : { color: 'var(--dsw-alias-state-warn-primary)' },
                        }, labelOf(RESULT_LABELS, run.result)),
                        h('span', { className: 'gd-row-hint' }, '扫 ' + String(run.watched == null ? 0 : run.watched) + ' 个 · 收 ' + String(run.kept == null ? 0 : run.kept) + ' 条 · 跳过 ' + String(run.skipped == null ? 0 : run.skipped)),
                        run.cost
                          ? h('span', { className: 'gd-row-hint' }, (run.cost.exact === false ? '≈' : '') + '本轮 ' + fmtMoney(run.cost.costCny) + ' · ' + fmtNum(run.cost.input + run.cost.output) + ' token' + (run.cost.exact === false ? '（含并发）' : ''))
                          : null,
                        sessionCost ? h('span', { className: 'gd-row-hint' }, '会话今日 ' + fmtNum(sessionCost.input + sessionCost.output) + ' token · ' + fmtMoney(sessionCost.costCny)) : null,
                      ]),
                      row.shown.length
                        ? h('div', { className: 'gd-items' }, row.shown.map((slot) => {
                          const item = slot.item
                          const repoName = String(item.repo || '')
                          const watched = watchSet.has(repoName.toLowerCase())
                          const watchPending = watchBusy === repoName
                          return h('div', { className: 'gd-item', key: slot.index }, [
                            h('div', { className: 'gd-item-head' }, [
                              h('span', { className: 'gd-item-idx', title: '在对话里说「第 ' + String(slot.index + 1) + ' 个」就能指向它' }, String(slot.index + 1)),
                              h('span', { className: 'gd-item-repo' }, repoName),
                              item.stars != null ? h('span', { className: 'gd-row-hint' }, '★' + fmtNum(item.stars)) : null,
                              h(VerdictBadge, { verdict: String(item.verdict || 'skip') }),
                              CONFIDENCE_LABELS[String(item.confidence)] ? h('span', { className: 'gd-pill', style: { color: 'var(--dsw-alias-label-secondary)' } }, CONFIDENCE_LABELS[String(item.confidence)]) : null,
                              repoName
                                ? h('button', {
                                  type: 'button',
                                  className: 'gd-item-watch',
                                  'data-on': watched ? '1' : '0',
                                  disabled: watchPending,
                                  title: watched ? '点一下取消关注' : '加入关注仓库：之后每轮日报都会扫它，有新版本才推给你',
                                  onClick: () => void toggleWatch(repoName),
                                }, watchPending ? '…' : (watched ? '已关注' : '+ 关注'))
                                : null,
                            ]),
                            item.what ? h('div', { className: 'gd-item-line', 'data-k': 'what' }, [h('b', { className: 'gd-tag' }, '是什么'), String(item.what)]) : null,
                            item.whatChanged ? h('div', { className: 'gd-item-line', 'data-k': 'changed' }, [h('b', { className: 'gd-tag' }, '变化'), String(item.whatChanged)]) : null,
                            item.impact ? h('div', { className: 'gd-item-line', 'data-k': 'impact' }, [h('b', { className: 'gd-tag' }, '影响'), String(item.impact)]) : null,
                            item.action ? h('div', { className: 'gd-item-line', 'data-k': 'action' }, [h('b', { className: 'gd-tag' }, '建议'), String(item.action)]) : null,
                          ])
                        }))
                        : (run.note ? h('div', { className: 'gd-row-hint' }, run.note) : null),
                    ])
                  })),
              ]),
            ]),

            h(Group, {
              key: 'trending',
              title: 'GitHub 热门',
              right: h('div', { key: 'trh', className: 'gd-filterbar' }, [
                trendingOpen
                  ? h('select', {
                    key: 'w',
                    className: 'gd-filter',
                    value: trendingWindow,
                    title: '时间窗',
                    onChange: (event) => {
                      trendingTouched.current = true
                      setTrendingWindow(event.target.value)
                    },
                  }, [['day', '今日'], ['week', '本周'], ['month', '本月']].map((pair) => h('option', { key: pair[0], value: pair[0] }, pair[1])))
                  : null,
                h('button', {
                  key: 'tg',
                  type: 'button',
                  className: 'gd-btn gd-btn-sm',
                  onClick: () => setTrendingOpen(!trendingOpen),
                }, trendingOpen ? '收起' : '展开'),
              ]),
            }, trendingOpen ? [
              trendingBusy && !trending
                ? h('div', { className: 'gd-wide', key: 'load' }, h(Note, null, '正在拉榜单…'))
                : null,
              trendingError
                ? h('div', { className: 'gd-wide', key: 'err' }, h(Note, { kind: 'err' }, trendingError))
                : null,
              trending && Array.isArray(trending.items) && trending.items.length
                ? h('div', { key: 'list' }, [
                  h('div', { key: 'meta', className: 'gd-wide' }, h('div', { className: 'gd-filter-sum' },
                    (trending.windowLabel || '') + '新建、star 最多的项目 · ' +
                    (trending.cached ? '缓存于 ' + String(trending.fetchedAt || '').slice(11, 16) : '刚拉的') +
                    (trending.totalCount != null ? ' · 池子 ' + String(trending.totalCount) + ' 个' : ''))),
                  ...trending.items.map((item, index) => {
                    const trendRepo = String(item.repo || '')
                    const trendWatched = watchSet.has(trendRepo.toLowerCase())
                    const trendPending = watchBusy === trendRepo
                    return h('div', { className: 'gd-trend', key: trendRepo }, [
                      h('div', { className: 'gd-item-head' }, [
                        h('span', { className: 'gd-trend-rank', 'data-top': index < 3 ? '1' : '0' }, String(index + 1)),
                        h('span', { className: 'gd-item-repo' }, trendRepo),
                        h('span', { className: 'gd-row-hint' }, '★' + fmtNum(item.stars)),
                        item.language ? h('span', { className: 'gd-pill', style: { color: 'var(--dsw-alias-label-secondary)' } }, item.language) : null,
                        h('span', { className: 'gd-row-hint' }, '建 ' + String(item.createdAt || '').slice(5)),
                        trendRepo
                          ? h('button', {
                            type: 'button',
                            className: 'gd-item-watch',
                            'data-on': trendWatched ? '1' : '0',
                            disabled: trendPending,
                            title: trendWatched ? '点一下取消关注' : '加入关注仓库',
                            onClick: () => void toggleWatch(trendRepo),
                          }, trendPending ? '…' : (trendWatched ? '已关注' : '+ 关注'))
                          : null,
                      ]),
                      item.description ? h('div', { className: 'gd-trend-desc' }, item.description) : null,
                    ])
                  }),
                ])
                : (trendingBusy || trendingError
                  ? null
                  : h('div', { className: 'gd-wide', key: 'empty' }, h(Note, null, '这个时间窗里没有够格的项目，换个窗口试试。'))),
            ] : [
              h('div', { className: 'gd-wide', key: 'hint' },
                h(Note, null, '全站最近涨得最快的项目。走 api.github.com，不需要挂梯子。点「展开」拉取')),
            ]),
          ]),
        ])
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          try {
            if (ctx.slots && typeof ctx.slots.inject === 'function') {
              ctx.slots.inject('settings.section', () => ctx.slots.register({
                name: 'settings.section',
                id: 'github-digest',
                order: 61,
                label: 'GitHub 日报设置',
              }, SettingsPage))
              // 侧边栏一栏 + 主面板。只有宿主声明了 sidebar.panellist 才注册，
              // 否则会挂一个点不开的入口。
              ctx.slots.inject('sidebar.panellist', () => {
                try {
                  ctx.slots.register({ name: 'main', key: 'github-digest' }, DigestPanel)
                } catch (err) {
                  /* 面板注册失败不阻塞入口 */
                }
                try {
                  ctx.slots.register({
                    name: 'sidebar.panellist',
                    id: 'github-digest',
                    order: 6,
                    label: 'GitHub 日报',
                  }, SidebarIcon)
                } catch (err) {
                  /* 入口注册失败不影响设置页 */
                }
              })
            }
          } catch (err) {
            /* 注册失败只影响界面，不能影响 web boot */
          }
        },
      }
    } catch (err) {
      return { apply() {} }
    }
  },
})
