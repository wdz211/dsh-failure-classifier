# dsh-failure-classifier

> Observes agent request errors and classifies LLM failures into retry / pause / stop — observation only, pass-through.

## 这是什么

模型请求失败是个混合体：有时候是几秒级的网络抖动，等一会儿就好；有时候是额度烧光了，再怎么
退避也不会好；还有时候是上下文超窗这种**确定性**失败，重试只是把同一个错误再犯一遍。这三种在
错误码上经常长得差不多，但该做的事完全相反。

本插件挂在 DSH 的 `agent/request-error` 瀑布流上，把每一次失败归到三类之一：
`retry`（秒级抖动，值得再试）/ `pause`（能自愈但要人的时间尺度，继续秒级退避只是烧配额）/
`stop`（确定性失败，重试不会改变结果）。分类结果写三处：一条会话事件（门控，见下）、一行日志、
一份本地 JSONL 观测账本。

**第一批只做观测。** 它站在既有 `llm-retry` 的**下游**：先 `await next()` 拿到下游的重试决定，
把那个决定**原样**（同一个对象、不重写、不重排）返回给 agent loop。不拦截、不改变重试决策、
不改动任何既有行为。`pause` 这一档目前**只被记录，不被消费**——把"要不要暂停"的权力留给下一批，
因为那一步会真的改变行为。

设计契约（事件签名、字段裁剪、门控证据链、错误处理顺序）写在 `CONTRACT.md` 里，那份是硬约束，
不是散文。

## 前置条件

**这是 DeepSeek Harness Desktop 的插件，不是独立的 npm 库。** 它需要宿主提供 cordis `ctx` 与
`agents` 服务（`export const inject = ['agents']`，与 shipped 的 `llm-retry` 对齐，保证 agent 服务
已就位）。没有宿主就没有可以挂的瀑布流。

`schema` 依赖是**懒加载**的：`@deepseek-ai/schemastery` 解析不到时 `Config` 导出 `undefined`，
Loader 跳过校验，`apply()` 里再逐项补默认值——所以这个包从裸 checkout 里也 import 得起来
（测试就是这么跑的）。

## 安装

把仓库目录 link/junction 进 profile 的 `node_modules`，再在 `cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: failure-classifier
      name: 'dsh-failure-classifier'
      config:
        overrides: {}
        sessionEvent: auto
        journal:
          enabled: true
          dir: ''
```

目录示例（`<dsh-home>` 是 DSH 家目录）：

```
<dsh-home>/profiles/desktop/node_modules/dsh-failure-classifier  ->  <本仓库>
```

**插件 host 半边不热载**：改 `lib/index.js` 必须覆盖运行态副本并重启 DSH；只改 `cordis.patch.yml` 里的
config 值则随 bundles 变更热载。

## 配置

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `overrides` | `{ [CODE]: 'retry'\|'pause'\|'stop' }` | `{}` | 逐码覆盖内置分类表（包括 RATE_LIMIT 的 Retry-After 提升）。非法值不会被静默吞掉——mount 时打一条 warn 并列出被忽略的项 |
| `sessionEvent` | `auto` \| `always` \| `never` | `auto` | `auto` = 运行时探测会话事件词表，**认得本类型才写**，否则只写 JSONL 账本；`always` = 强制写（只有确认过读盘路径能容忍时才用）；`never` = 完全不写 |
| `journal.enabled` | bool | `true` | 观测账本开关 |
| `journal.dir` | string | `''` | 账本目录；空串按 `$DSH_HOME` → `$DSH_HOME_DIR` → `~/.dsh` 解析，mount 时打 `failure-classifier: journal -> <目录>` 便于核对 |

## 分类表

| kind | code | 为什么 |
|---|---|---|
| `retry` | `TRANSPORT` / `TIMEOUT` / `SERVER` / `EMPTY_RESPONSE` | 几秒级抖动，同一套退避策略大概率就好 |
| `retry` | `RATE_LIMIT`（无 Retry-After，或 ≤ 60s） | 短限流，等一会儿再试是合理的 |
| `pause` | `RATE_LIMIT` 且 `providerRetryAfterMs > 60000` | 上游自己说要等一分钟以上，秒级退避没意义 |
| `pause` | `QUOTA` / `ACCOUNT_QUOTA` | 额度耗尽，等计费/账户恢复，属人的时间尺度 |
| `stop` | `CONTEXT_WINDOW_EXCEEDED` / `INVALID_CREDENTIAL` / `IMAGE_OFFLOAD_REQUIRED` | 确定性失败：重试同一个请求必然再失败 |
| `stop` | **其他一切未列出的 code** | 未知失败默认按确定处理——宁可早停，也不无限重试 |

边界写死并测过：`providerRetryAfterMs === 60000` 仍是 `retry`（**严格大于**才 `pause`）。

## 对外能力

**它不注册任何工具。** 能力只有两处可观测的落点：

1. **日志**：每次失败一行 `failure-classifier: <kind> code=<code> provider=<provider> turn/step=<t>/<s>`；
   mount 期一行 `failure-classifier: journal -> <目录>`。
2. **账本**：`<journal.dir>/classified-YYYYMMDD.jsonl`，每次失败追加一行，字段：

```jsonc
{
  "kind": "retry",                // retry | pause | stop
  "code": "TRANSPORT",            // 原始 code；缺失时为 "UNKNOWN"
  "status": 503,                  // 可选；只有整数才写
  "messageHead": "…",             // 必填；空白折叠为单空格 + 截断到 200 字符
  "providerRetryAfterMs": 90000,  // 可选；只有有限正数才写
  "turn": 3, "step": 2,           // 可选；整数才写
  "provider": "deepseek-official",// 可选；非空字符串才写
  "time": "2026-01-01T00:00:00.000Z",
  "downstreamFailed": true        // 仅下游抛错时出现
}
```

**为什么裁字段**：会话事件走 `snapshotJsonValue` 深拷贝，遇到 `undefined` 会直接抛
`carries non-JSON-serializable data`。所以"值为缺省"时**省略键**，而不是写成 `undefined`。

## 已知限制

- **会话事件是门控的，这是本批最重要的类型不确定性。** 这个 build 的
  `KNOWN_SESSION_EVENT_TYPES` 里**没有** `llm/failure-classified`；无条件 append 当下不报错，
  故障会延迟到**下次打开这个会话**——表现是"会话打不开/日志被拒"，而且极难归因。
  所以默认 `sessionEvent: auto` 时**不会**往会话日志里写事件，只用 JSONL 账本。完整证据链见
  `CONTRACT.md` §4。
- **只观测，不消费。** `pause` 被分类出来但没有下游动作；重试决策仍然完全由既有 `llm-retry` 决定。
  "让 pause 真的暂停"是下一批的事。
- **绝不二次调用 `next()`。** 观测路径独立 try/catch、永不抛出；下游抛错时"先记账、再原样抛回"。
  照字面把 `catch 里 return next()` 实现会在观测出错时把下游再执行一遍（重复调度重试），
  比观测漏记严重得多。
- **账本首次写失败即停用并 warn 一次**，不重试、不刷屏——观测设施坏掉不能变成新的故障源。
- **`messageHead` 截 200 字符**：provider 的错误体可能带整段 HTML/JSON，一次失败不该把日志撑大。
- **host 半边不热载**：改 `lib/index.js` 必须覆盖运行态副本并重启 DSH（原因在 `CONTRACT.md` §5）。

## 开发

```bash
node test/selftest.mjs    # 40 条断言：13 类 code + 边界 + 缺字段 + overrides + 事件裁剪 + 透传契约
node -e "import('./lib/index.js').then(m=>console.log(Object.keys(m)))"   # 导出正常
```

单测自带一个假 `ctx`，验证的是**契约而不是输出字符串**：`next()` 只被调用一次、返回值按引用透传、
下游抛错时先记账再原样抛回、账本不可写也绝不阻塞决定。全部离线，不需要 DSH。

（一个细节：测试里"账本不可写"那条用例刻意把 journal 指向 `<repo>/package.json/nope`——
一个在文件下面建目录的路径。仓库里 `package.json` 是文件时 mkdir 会失败，正好是这条用例要的效果。）

## 许可

MIT。无第三方上游代码，故无 ATTRIBUTION.md。
