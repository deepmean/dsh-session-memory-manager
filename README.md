# PTC 磁盘历史：原日志按需读取

本地实验版：`@local/dsh-ptc-disk-history@0.1.0-alpha.2`。实现说明及第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**只保留原会话日志一份正文，不把展示原文拆成外置文件。** 本版本针对 `tool/ptc-dispatch` 中 `read` 子调用的大 `data.meta.lines`，在原生历史冷恢复和查询时保留有标识的预览；点击详情才从原日志精确定位物理帧并分页读取。

**对模型上下文的影响**：官方 `deriveMessages()` 对 `tool/ptc-dispatch` 返回 `null`，PTC展示 metadata（包括 `meta.lines`）本来就不属于正常模型消息。本插件的普通历史观察只提供醒目标注的薄预览，不会把完整行数据自动注入模型；最终 `tool/result`、正式消息、工具参数与调用身份均保持完整。点击 GUI 详情只在浏览器按页展示，不进入模型上下文。新增 `ptc_history_read` 工具仅在 Agent 显式调用时把请求的那一页作为工具结果交给模型，每页限制 48 KiB，模型可以按返回游标继续读取；它不会自动补齐整份 metadata。原 `session_event_read` 看见的是预览，想恢复原始 PTC read 展示正文应使用该显式分页工具。

## 已实现

- 原生 AgentLoop resume、cold GUI/query、标题和单事件查询接入显式 presentation 模式；不是另开查看页后让原生仍全量恢复。
- 大于 32 KiB 的 PTC read 行展示数据，在内存中只保留最多 4 KiB 的首尾预览和临时 token。原文仍完整保留在原 `.jsonl.zstd`。
- 不使用自动水合 getter，普通 JSON 序列化不会读盘。
- 详情为显式异步分页，单页 JSON 最多 64 KiB，超长 Unicode 行可用字符游标续读。浏览器只保留当前页和最多 100 个上一页游标，收起/卸载即清空并 abort。
- 使用 Zstandard 真实帧结构，不按 magic 字节搜索；内存只保留轻量 seq/帧位置与摘要索引，不写索引 sidecar。
- 官方 V4 行准入、序号、关系和 Session 校验继续执行；损坏/截断日志拒绝，错误不静默回退成高内存 eager。
- 持久化默认 `open/read` 仍返回完整事件，供官方日志导出使用。写入前逐事件恢复完整 meta 并调用官方 catalog 编码，禁止把预览/token 写回日志。
- 原生正常 append 保留旧压缩前缀字节；复制/分叉物化后，子日志拥有完整原文，不依赖父日志继续存在。
- worker 最多保留一个 256 事件 ACK 批次；Host 确认接收后才扫描后续事件，避免worker全历史数组与跨线程完整复制。
- 不同历史 presentation read 在 handle.read 边界串行，减少多个整日志快照同时解码的峰值；正常full API和写入API保持原生语义。
- worker 有限额、队列和超时，使用 Cordis effect disposer 清理，无后台巡检/GC 循环。
- 无会话删除钩子，不清理任何项目/工作区/共享目录。

## 验证证据

当前 Windows ARM64 / Node 27 / DSH `0.2.2-rc.5`：

```powershell
$env:DSH_INSTALL_DIR='C:\softwares\node-arm64\node_modules\@deepseek-ai\dsh'
node --test "test/*.test.js"
node scripts/check.mjs
```

修复版完整回归：**92 项通过，0 失败**；覆盖真实官方 Cordis/Session/AgentRegistry/AgentLoop/query 隔离组合、worker ACK背压、并发 presentation 冷读取串行、按安装版动态native快照及分页界限。未发送模型请求。

对报错中的 `session-6659c2b1-1028-49f6-9585-ebb9b9a01dc6` 做隔离冷扫描：77,083 个事件，worker 上限 192 MiB，主进程显式设为 1 GiB；扫描耗时 6,623 ms、进程 RSS 484.3 MiB、主线程 GC 后 heap 263.2 MiB；302 个 ACK 批次，单批最大 256。源日志 SHA-256 前后均为 `F0B35AF35FCDA6C5F790D71B31D16536DC75D0AE0D0DD6C8940F849F24F76E4D`。此前另一次扫描期间该会话仍在追加，scanner按设计拒绝混合不同revision的快照。

同一份 67,784,180 字节历史样本：20,813 个事件、1,169 个大展示 metadata（原始 `meta.lines` 合计 340,474,294 字节），28,487 ms 扫描；进程 RSS 485.2 MiB，主线程 GC 后 heap 212.5 MiB；82 个 ACK 批次、单批最大 256。源日志 SHA-256 前后均为 `65433ED92C4D311888B2FB874F965516964BFD67335FD504F37693C43ABA00F4`。两次测试都没有详情自动回读、日志写入或外置正文文件。

以上为隔离新进程的单次读样本，不是当前 Host 总内存或硬上限；1 GiB 主堆是基准进程设置，worker仍限制为192 MiB。用户已在 alpha.2 冷启动后确认历史会话可正常打开；详情分页的实际点击展示尚未单独确认。

## 使用边界

1. **必须冷启动接入。** 本 bundle 通过停用官方 JSONL/AgentLoop/query 三个 row、插入替代 provider；在正在运行的 Host 中 HMR 切换这些基础服务会影响所有会话。当前profile尚未启用修复版。
2. 本地包声明 DSH `>=0.2.2-rc.5`，**不设最高版本**。每次Host激活时读取当前 DSH 与 persistence 包，要求版本一致；从当前安装动态生成隔离native适配代码到系统临时目录，检查类/方法布局，退出时清理临时代码。布局变化时fail closed。没有打包或复用0.2.2的静态二进制快照；每个新版本仍需做全套适配验证。
3. **重点是历史冷恢复，不是所有 live 内存。** 新 run_code 结果仍由官方先发布完整 metadata，当前 live 生命周期中可能继续驻留；后续冷重载才使用薄视图。本版不靠事后巡检替换正在使用的事件。
4. **首次冷打开仍需完整扫描/验证原日志。** 一个大 Zstd 物理帧需要从帧起点解压；默认单帧 64 MiB、单行 8 MiB，超限拒绝而不是自动扩大。旧日志样本约需 29 秒，worker 让主循环持续运行，但不是即时打开方案。
5. **完整导出依然可能消耗较多内存。** 官方 ZIP/完整日志导出走普通 full storage API，数据完整，但不会享有 GUI preview 的内存特性。
6. **GUI read row 是轻量回退。** 当前 DSH keyed slot 没有条件 fallback，插件覆盖 read 行以提供分页按钮；路径打开、状态、inspect、展开已有 content 保留，原生高亮和文件右键菜单未复用。浏览器行为已做 VM/React 桩测试，实际页面渲染尚未验收。
7. **V0–V3 迁移沿用官方完整迁移。** 大旧版本日志不承诺同样内存收益；presentation 路径对撕裂尾部先拒绝，未把 crash repair 作为已优化场景。
8. **索引/token 不落盘。** 原日志变化会校验修订；进程重启 token 重新生成。追加后首次详情读取可能重建轻量索引，遇到并发改写会受控拒绝并要求重试。

## 准备与安装

验证命令（每次拟适配新的 DSH 版本都运行）：

```powershell
$env:DSH_INSTALL_DIR='C:\softwares\node-arm64\node_modules\@deepseek-ai\dsh'
node scripts/check.mjs
node --test "test/*.test.js"
```

运行时快照由插件在Host启动时从该Host的安装生成到系统临时目录；退出Fiber时清理。源码包不携带特定DSH版本的官方native二进制副本。诊断脚本 `scripts/prepare-native.mjs` 也默认在系统临时目录生成检查快照。

部署修复版前完整退出 DSH Web/Desktop/headless，再通过官方插件管理器安装并启用本地bundle。完成冷启动后，工具read行出现“从原会话日志读取详情”分页按钮；正式GUI页面与会话切换需用新Host确认。

本目录是本地链接源码；使用链接安装后应保留，不要在 Host 运行中修改它。

## 读写和权限

- 读取：原始会话压缩日志、安装版官方模块和版本/摘要；详情路由只允许当前官方 owner 身份访问，不接收任意磁盘路径。
- 写入：仅用户正常创建/追加/分叉时，由官方单写者 lease/原子发布协议写完整会话日志；新懒读模块自身不拆分、外置、裁剪或删除原文。
- 没有安装生命周期脚本、第三方下载、后台巡检、强制 GC、凭据读取或对外网络请求。浏览器只同源请求 owner-only 详情路由。
- 卸载/回退也应先完整退出 Host，再移除本 bundle并重启，让原三项 provider 恢复；不要对基础provider做运行中热切换。

实现模块与原理记录见 [DEVELOPMENT.md](DEVELOPMENT.md)。原离线精简工具在兄弟目录保持原有仅裁逐 token 回放的功能，23 项回归已通过；它没有启用被取消的外置模式。
