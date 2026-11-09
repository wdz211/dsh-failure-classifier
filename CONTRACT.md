# CONTRACT - dsh-failure-classifier

观测契约。**第一批只观测**：不改重试决策、不拦截、不改动任何既有行为。

---

## 1. 挂在哪儿

```ts
ctx.on("agent/request-error", (payload, next) => Promise<RequestErrorAction>)
```

- 事件签名（已核对上游）：`payload = { agent, turn, step, provider, failure: LlmFailure, retryPolicy: ResolvedRetryPolicy | undefined, signal }`，`next: () => Promise<RequestErrorAction>`，默认实现 resolve `undefined`。
- `agent` 由 `dsh-agent` 的 `agentEvents().waterfall()` 用 `fused(payload)` 注入（`dsh-agent/lib/index.js:243-246`），监听者能直接拿到。
- `RequestErrorAction = { kind: "retry" } | undefined`。**本插件从不构造 action**，只透传。
- agent loop 在 `dispatch.waterfall("agent/request-error", …)` 后读 `action?.kind !== "retry"` 决定是否抛 `LlmError`（`dsh-agent-loop/lib/index.js:1124-1132`）。所以我们返回什么、什么时候返回，直接影响重试链路——因此处理顺序是硬约束：

```
downstream = await next()        // 1. 先下游（llm-retry 先决策）
try { record(payload, failed) }  // 2. 再观测，自身异常只 warn
if (failed) throw downstreamError
return downstream                // 3. 原样返回
```

**绝不二次调用 `next()`**：任务书里的「catch 里 return next()」如果照字面实现，会在观测抛错时把下游再执行一遍（重复调度重试），是更严重的错误。这里的等价安全形态是「`next()` 只调用一次；观测路径独立 try/catch，永不抛出」。

`inject = ["agents"]`（与 shipped `llm-retry` 对齐，保证 agent 服务已就位）。

---

## 2. 事件 schema（会话事件与账本共用同一份 data）

类型：`llm/failure-classified`

```jsonc
{
  "kind": "retry" | "pause" | "stop",
  "code": "TRANSPORT",            // 原始 code，未加引号处理；缺失时为 "UNKNOWN"
  "status": 503,                  // 可选；只有整数才写
  "messageHead": "…",             // 必填；空白折叠为单空格 + 截断到 200 字符
  "providerRetryAfterMs": 90000,  // 可选；只有有限正数才写
  "turn": 3,                      // 可选；整数才写
  "step": 2,                      // 可选；整数才写
  "provider": "deepseek-official" // 可选；非空字符串才写
}
```

**为什么要裁字段**：`session.append()` 用 `snapshotJsonValue` 深拷贝，遇到 `undefined` 会直接抛 `carries non-JSON-serializable data`。所以「值为缺省」时**省略键**，而不是写成 `undefined`。

**为什么截 200 字符**：provider 的错误体可能带整段 HTML/JSON；事件要进会话日志与账本，不能让一次失败把日志撑大。原文另外还能从 `messageHead` 之外的地方查到（本次不做）。

`messageHead` 同时把 `\s+` 折成单空格——事件是 1 行记录，多行错误会把 grep 后的日志排版打散。

---

## 3. 分类表

| kind | code | 说明 |
| --- | --- | --- |
| retry | `TRANSPORT` | 连接中断/终止（本机历史最高频：`terminated`） |
| retry | `TIMEOUT` | 请求超时 |
| retry | `SERVER` | 上游 5xx / 上游饱和 |
| retry | `EMPTY_RESPONSE` | 空响应（shipped 默认可重试码之一） |
| retry | `RATE_LIMIT`（无 Retry-After 或 ≤ 60s） | 短限流 |
| pause | `RATE_LIMIT` 且 `providerRetryAfterMs > 60000` | 上游自己说要等一分钟以上，秒级退避没意义 |
| pause | `QUOTA` | 额度耗尽（需人类处理/等计费恢复） |
| pause | `ACCOUNT_QUOTA` | 账户配额耗尽 |
| stop | `CONTEXT_WINDOW_EXCEEDED` | 上下文超窗，重试同样的请求必然再超 |
| stop | `INVALID_CREDENTIAL` | 凭据无效，重试不会自动变好 |
| stop | `IMAGE_OFFLOAD_REQUIRED` | 需要图片卸载，是流程要求而非抖动 |
| stop | **其他一切未列出的 code** | 未知失败默认确定性处理 |

边界写死并测过：`providerRetryAfterMs === 60000` 仍是 `retry`（严格大于才 `pause`）。

**overrides**（Config）：`{ "<CODE>": "retry" | "pause" | "stop" }`，命中即覆盖上表（包括 RATE_LIMIT 的 Retry-After 提升）。非法值不会被静默吞掉——mount 时打一条 warn 并列出被忽略的项。

**为什么 pause 与 retry 要分开**：这是两件不同的事。`retry` 的对象是「同一秒级退避策略」；`pause` 的对象是「这个策略在此刻不适用」。混在一起会让「上游说自己 5 分钟后再来」被当成普通抖动，退避曲线一路烧钱。第一批只做分类与观测，**不消费** `pause`——见 §6。

---

## 4. 会话事件为什么要「门控」（本批最重要的类型不确定性）

任务书要求「向会话流 append 一条 `llm/failure-classified`」。核对上游后结论是：**这个 build 里无条件 append 会毁会话**。

证据链（安装目录 `resources/app/node_modules/@deepseek-ai/`）：

1. `dsh-session/lib/index.js:79-102` 的 `KNOWN_SESSION_EVENT_TYPES` 是生成出来的词表，包含 `llm/retry`、`llm/retry-started`，**不包含** `llm/failure-classified`；注释（:65-77）明说：词表外的类型读盘时会被拒绝，除非事件信封带 `ignorable: true`（"Downstream (out-of-repo) plugin events are outside this list by construction. The persisted `SessionEvent.ignorable` marker is the compatibility mechanism"）。
2. `dsh-session-persistence/lib/index.js:184`：
   `if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(... refusing to interpret the log ...)`
3. `dsh-session-format-v3-to-v4/lib/index.js` 的 `restoreReleasedV4Artifact` 同样抛
   `format v4 contains unknown event type "…" at seq N`。
4. **写侧不给这个开关**：`dsh-session/lib/index.js:1441-1450` 的 `append(type, data, ...opts)` 只把 `sourceEventSeqs` / `surfaceOp` 拷进信封，`ignorable` 透不过去；写盘侧 `dsh-session-log-deepseek/lib/index.js:43,61-69` 只是**保留**已有的 `ignorable`，不会主动加。

推论：append 当下不会报错（`planSurfaceEvent` 对未知非 surface 类型返回 `undefined`，当 log-only 事件接受），**故障延迟到下次打开这个会话**——表现是「会话打不开 / 日志被拒」，而且极难归因。对「只观测、不改变任何现有行为」这一批，这是不可接受的风险。

**本批的形态**（Config `sessionEvent`）：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 运行时探测 `@deepseek-ai/dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES`：含本类型才写会话事件，否则只写 JSONL 账本并打一条 info 说明 |
| `always` | 强制写会话事件（**只有确认过读盘路径能容忍时才用**） |
| `never` | 完全不写会话事件 |

探测失败（模块解析不到）等同「不知道」，按不写处理——fail closed。

**账本**（第一批的主落盘观测面）：`<journal.dir>/classified-YYYYMMDD.jsonl`，一行一个 §2 的 data（额外带 `time`，下游抛错时带 `downstreamFailed: true`）。目录解析顺序：`journal.dir` → `$DSH_HOME`（或 `$DSH_HOME_DIR`）→ `~/.dsh`，mount 时打一条 `failure-classifier: journal -> <目录>` 便于核对。首次写失败即停用账本并 warn 一次，不会重试刷屏。

---

## 5. 安装与验证（由主代理统一安排，本插件不自行安装）

```bash
# 装（主代理执行）
plugin_manager action=install_bundle target="file:/path/to/dsh-failure-classifier"
# 或 profile 内 pnpm add file: + bundles 追加，按本机既有流程

# 验证（不需要 GUI 认证）
# 1) mount 期日志：failure-classifier: journal -> <目录>
# 2) 失败一次后：failure-classifier: <kind> code=… provider=… turn/step=…/…
# 3) 账本文件有对应行
```

已知约束：**插件 host 半边不热载**——改 `lib/index.js` 必须覆盖到 `<dsh-home>/profiles/desktop/node_modules/dsh-failure-classifier/`（或重装）并重启 DSH；改 `cordis.patch.yml` 里的 config 值则随 bundles 变更热载。

单元验收（不依赖 DSH）：

```bash
node test/selftest.mjs   # 40 断言：13 类 code + 边界 + 缺字段 + overrides + 事件裁剪 + 透传契约
```

---

## 6. 第二批：pause 需要什么前置验证

第一批只把 `pause` **标出来**，没有任何进程真的会「暂停」。要真的消费它，前置条件是：

1. **读盘词表打通**（硬前置，见 §4）。三条路，任选其一并验证：
   a. 上游把 `llm/failure-classified` 加进 `KNOWN_SESSION_EVENT_TYPES`（`gen-persistence-catalog.ts` 生成）；
   b. 上游给 `session.append` 一个「外部事件 / ignorable」入口；
   c. 我们确认「本插件在 compose 里常驻 → 词表能注册」（目前 `dsh-session` 的注释明确说做了相反的取舍，所以不成立）。
   **验证方法**：带事件跑一次 → 关 DSH → 再开该会话，能正常打开且日志无 `refusing to interpret the log`。这一条不过，`sessionEvent` 必须停在 `auto`。
2. **pause 的语义需要一个消费者**。`RequestErrorAction` 只有 `{ kind: "retry" } | undefined`，今天没有「暂停后重放」的通道。可选设计：不阻塞 agent loop（那会占住一个会话），而是在 `turn/end` 之后按 `providerRetryAfterMs` 排一个延迟唤醒；这需要新的调度面（`dsh-schedule`）而不是改 retry 插件。**在得到明确形态之前，不要动 retry 链路。**
3. **分类准确性要先用数据证明**。第一批跑够样本后，用账本统计：同一 `(provider, code)` 连续 `retry` 的次数分布、`QUOTA` 的实际恢复间隔、`RATE_LIMIT` 的 `providerRetryAfterMs` 分布。若 `QUOTA` 的恢复时间中位数是小时级，`pause` 的阈值应来自数据而不是 60 秒这个初始猜测。
4. **误判代价不对称**：把 `retry` 误判成 `pause` 会让人等；把 `stop` 误判成 `retry` 会烧配额/卡死会话。第二批任何「暂停」动作都必须可被用户一键打断（复用既有 abort signal），且默认关闭。

---

## 7. 已知类型不确定性（如实记录）

| 项 | 状态 |
| --- | --- |
| `llm/failure-classified` 会话事件可写性 | **未验证可行**：词表不含 + `append` 无法打 `ignorable`；读盘侧明确拒绝（§4）。当前走 `auto` 门控 |
| `RequestErrorAction` 是否有 pause/stop 变体 | 只有 `{ kind: "retry" } \| undefined`（`dsh-agent-loop` 只判 `action?.kind !== "retry"`） |
| `LlmFailure.offloadImages` / `requestId` | 存在但本批不写进事件（`requestId` 是 branded 字符串，`offloadImages` 与分类无关） |
| `payload.agent.session.append` 在 subagent 会话里是否同样可用 | 未实测；`writeSessionEvent` 对 `append` 缺失/抛错降级并只 warn 一次 |
| `journal` 目录默认值 | `$DSH_HOME` 在插件进程里是否被设置未实测；未设时回落 `~/.dsh`，mount 期日志会打印实际路径，可用 `journal.dir` 固定 |
