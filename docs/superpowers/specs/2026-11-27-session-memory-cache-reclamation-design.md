# 会话历史缓存空闲回收规格

状态：待用户审阅。本文获批后再编写实施计划；尚未修改产品代码。

## 问题与证据

DSH 0.2.3-alpha.2 的 `SessionObservationReader.read()` 对冷会话执行完整持久化读取、调用 `sessions.prepare()`，并将 prepared `Session` 与冻结的完整 `events` 存入 reader cache。lease 的 `Symbol.dispose()` 只减少 entry 引用数；`evictPastCapacity()` 仅在缓存条目数超过容量时驱逐。因此 alpha4 presentation reader 容量为 1 时，唯一的大会话 lease 归零后仍留在 cache Map 内。`inspectSession()` 虽然在读取后释放 lease，目前没有删除该 entry。

`SessionStore.prepare()` 构造 detached Session，不会把它放入 live Session store。ProjectionRegistry 的 session cell 使用 WeakMap，不是该 Session 的独立强引用根。Idle-Agent manager 只处理具有明确所有权的 live AgentHandle，不会清理 passive Query cache。

另一个强引用根位于 PTC presentation worker：`sources` Map 默认可持有最多两个 `DiskHistoryReader`，每个 reader 有 seq 到物理 frame 的索引，单 reader 允许最多 200,000 个条目。source 在被其他文件挤出或 Worker 关闭前没有 idle expiry。worker 的 `references`/`knownTokens` 保留分页 token 所需的小型校验元数据，受现有 50,000 reference 上限约束。

现场大 Session 案例中，普通 user/assistant 内容与完整 tool result 明显大于可裁剪的 PTC `meta.lines`。alpha4 preview 只处理超过 32 KiB 阈值的 PTC 行数据，因此这项展示优化不能代表整个 Session 的缓存限额；本升级聚焦最后一个 viewer/consumer 退出后的强引用释放。

## 目标

- 当 alpha4 创建的 passive prepared-session observation 不再被任何 lease 使用时，完整事件对象图在有限 idle grace 后不再被 Query cache 强引用。
- Session 没有 Agent 也能触发 Query-cache eviction；不得把清理依赖于 Agent lifecycle。
- PTC worker 的大 DiskHistoryReader index 在无请求后关闭、清空，但 marker token 在有效的当前 UI 生命周期中仍可用于按需从原日志重新扫描。
- 活跃 lease、并发查看、取消、session revision 更新、worker scan 或 detail read 期间，不提前清理对象或破坏结果。
- 不删除、裁剪、外置或改写原始 session 日志；不调用强制 GC；不承诺 OS RSS/Private Bytes 在 V8 释放对象后立即下降。

## 非目标

- 不实现整场 Session 的分页冷读，不消除第一次打开 101k-event session 的瞬时构造成本。
- 不设定整个 DSH Host 的 RSS 硬上限，不清理普通模型上下文、live Session、第三方插件缓存或进程级高水位。
- 不删除 durable projection checkpoint、session files 或 PTC token 对应的源数据。
- 不改变 native Controller Remote/authorization API，不热切换当前 Host。

## 方案

### Query prepared cache

为 alpha4 presentation reader 及显式 full-observation 路径加入 lease-aware idle eviction。所有向消费者返回的 observation lease 均经兼容包装：保持原有字段、`retain()` 和幂等 dispose 语义；retain 产生的 lease 也纳入同一 lease 计数。`inspectSession()` 内部读取则在 getter 完成并释放其 lease 后进入相同的空闲流程。

最后一个 lease 释放时，启动默认 30 秒、`unref()` 的 per-entry idle timer。该 session 在 grace 期间再次被观察时撤销 timer 并复用缓存。timer 到期仅当以下条件全部满足时删除 entry：reader 仍是本 alpha4 adapter 所拥有的 reader；cache 对应该 session 的仍是创建 timer 时捕获的同一 entry/revision；该 entry 的活动 lease 数为零；没有进行中的相关读取。session ID 被新版 entry 替换后，旧 timer 不得删除新版 entry。

对 alpha2 reader shape 做明确检查。若无法证明 entry identity、revision 或 lease 数语义与已测试 shape 相符，则只跳过 eviction 并发出一次不含 session ID/正文的 warning；不得误删活动 entry。Query fiber teardown 清理 idle timers 并清空 alpha4 私有 cache；已有 lease 自己持有的数据可在其 dispose 后自然失去引用。

full-observation 路径使用原生 Query reader 的另一份 cache，必须套用相同的 lease 生命周期规则。不能只清 alpha4 presentation cache 而遗留 full cache。

### PTC worker source/index cache

为 `sources` Map 中的 `DiskHistoryReader` 加入默认 60 秒 idle expiry。每次 `freshReader()` 命中或新建 source 时更新 last-used 时间；expiry 仅在 worker 无活动 operation 且 scan/read 已结束时关闭 reader、清空物理索引并移除 source。worker 的 operation queue 忙时不关闭 reader，改为延迟检查。新请求在 expiry 后到达时沿用现有 `freshReader()` 从未修改的原日志重建 reader/index。

保留 `references`/`knownTokens` 的现有校验语义和 50,000 上限：source index 过期不代表 token 过期；这些较小记录使已有 preview marker 可以在下次详情请求时重新定位源日志。Worker shutdown 继续清除 timers、readers 和 maps。

### 诊断与可见性

提供仅含计数、不含 session ID 或正文的运行指标：Query prepared cache entry/event 数、活动 lease 数、eviction 次数；worker source readers/index entries、reference count、expiry eviction 次数。指标用于复核回收条件，不能将其包装成精确 V8 retained bytes。若某一 cache shape 未验证，记录一次有限 warning，不循环刷日志。

## 默认参数

- Query idle grace：30,000 ms；lease 归零后开始，重新读取时重置。
- Worker source/index idle TTL：60,000 ms；每次 source 命中或详情读取时重置。
- 保留现有 Query cache capacity 1、worker maxSources 2、maxReferences 50,000 与 Worker 192 MiB old-generation limit；本变更不调高任何限制。

## 验收标准

1. 一个 cold prepared session 的 presentation lease 释放后，cache entry 在 grace 内保留；grace 到期且 refs 为零后 entry 消失。
2. 两个并发 lease 中只释放一个时不驱逐；最后一个释放后按 TTL 清理。timer 触发前重新观察会取消旧 eviction。
3. revision 替换后，旧 timer 不得删除新版 cache entry。
4. `inspectSession()` 的 modern reader 路径以及 `observeFullSession()` 的原生 reader 路径均在最后 lease 释放后回收；retain/重复 dispose 不得造成过早或漏回收。
5. Query adapter dispose 清理 timers；活动 lease 仍可正常读到其原 observation，dispose 后才释放其引用。
6. Worker source reader 在空闲 TTL 后关闭并清空 index；detail page 请求在 expiry 后能重扫原日志并返回相同页；active scan/read 不会被 timer 中断。
7. PTC source 内容 hash、V4 校验结果和持久化文件长度不变；没有写入外置 payload 或修改 session file。
8. 所有测试使用 fake clock/小型合成事件；不以 OS RSS 立即下降作为测试断言，不在 production 路径调用 GC。
9. 当前 DSH 0.2.3-alpha.2 的 Query、native JSONL、Controller、fallback focused tests 和全量插件测试通过；bundle self-check 通过。

## 风险与取舍

- idle grace 期间对象仍被有意保留；到期后 V8 才能回收其不可达对象，Windows working set 仍可能维持高水位。
- 驱逐后再次查看会重新扫描/解码大型 session，增加冷读延迟及短时 CPU/内存峰值；这是用重复 I/O 换取空闲后的驻留上限。
- detail request 在 worker index 过期后需要重新扫描源日志。过期不得使有效 marker 失效。
- DSH alpha2 的 observation reader 是内部结构；任何未识别的 layout 必须 fail-safe 地跳过 eviction，而不能冒险删活动 entry。
- idle Agent timeout 是另一种资源生命周期，保持原样；它不是 passive Query cache eviction 的代理。

## 发布与部署

实现应将本地包版本从 `0.1.0-alpha.4` 提升至 `0.1.0-alpha.5`，保持 private/package link 安装方式及公开 Git 仓库分支，不发布 registry tarball。Host 端改动只在冷启动后生效；不得对当前运行中的 Host 执行 HMR/手动清 cache。
