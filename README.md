# DSH 会话内存管理器

`@local/dsh-session-memory-manager@0.1.0-alpha.3` 是本地试用包，包含 alpha.2 的 PTC 原日志分页和 Web 会话内存管理。它不会删除、裁剪或外置会话日志，也不会恢复旧的独立查看页。

## 会话内存

- 浏览历史是被动读取，不会仅因打开会话就启动 Agent。发消息等需要 Agent 的操作仍走 DSH 原生恢复流程，使用同一个会话。
- 在 **插件管理 → DSH 会话内存管理器 → 会话控制器配置** 中可选关闭、1 分钟、5 分钟或 15 分钟，默认 5 分钟。保存只更新这个设置，不重新挂载服务。
- 只有能确认由 Web 控制器持有原始句柄的 Agent 才能回收。最后一个查看者离开后，Agent 还必须处于空闲、两个收件队列都为空，且没有正在处理的会话操作。运行中、维护中、子 Agent、启动时配置的 Agent 和归属不明的 Agent 不回收。
- 回收释放的是内存中的 Agent 和关联资源。再次操作时从原日志恢复。V8 可能保留已分配的页，因此系统显示的进程内存不一定立刻下降。

## PTC 历史

- 对历史 `read` 子调用，超过 32 KiB 的行展示数据只保留至多 4 KiB 的预览；点“从原会话日志读取详情”后才分页读原文。浏览器每页最多 64 KiB，只保留当前页和有限的返回游标。
- 浏览器详情不会进入模型上下文。工具参数、最终 `tool/result`、普通模型消息保持原样；只有显式调用 `ptc_history_read` 才会把请求的一页作为工具结果交给模型，每页最多 48 KiB。
- 首次冷打开仍需扫描日志。完整导出走原生全量读取，新产生的大 PTC 结果在当前运行周期也仍可能占内存。这不是整个 Host 的内存上限。

## 验证证据

当前工作树已完成：

- 全量隔离 Node 测试：`128/128` 通过，进程正常退出；测试使用当前安装的 DSH `0.2.3-alpha.2`。
- 针对 alpha2 的 Query reader、session list projection、native JSONL snapshot 和 Loader fallback：focused tests 全部通过；其中实际 native query/list 与 snapshot 集成 `15/15`，Controller/AgentLoop 生命周期 `16/16`。
- `scripts/check.mjs`：通过运行时语法、显式导出、API 基线、locale 元数据和 SVG 检查。
- Adapter 与真实安装版 AgentLoop/Registry 原生生命周期：`16/16` 通过；包含被动 follow、TTL 回收、日志 SHA/长度保持、同一 durable Session 恢复、首次 prompt、重复 request 去重，以及 minted-ID create 的 registry lease/首个 activity refresh。
- Plugin Manager Client 配置：`21/21` 通过；包含 wrapper churn、CAS revision、重复保存和 Host 先发布新 revision 的情况。
- Loader/原生 Client/Typert 回退组合：`8/8` 通过；含不兼容版本、部分初始化失败、最低版本门槛、volatile `1 → 5 → 15 → 0` 和干净关闭。
- 合成约 32.1 MB PTC 行数据的展示扫描：仅保留 4 KiB 预览，未写外置 payload 文件；该结果不是完整 Host RSS 上限。

这些是隔离测试和临时合成日志证据，不是当前 profile 的现场验收。真实 GUI 渲染、冷启动切换和用户控制的数日试用仍待单独完成。

## 冷启动试用与回滚

会话控制器适配的最低版本基线为 DSH `0.2.2-rc.5`；更高版本会继续做安装版 API 结构校验，低于基线、结构不兼容或替换初始化失败时回退到原生控制器并保留原生浏览器模块。PTC 存储适配仍需按安装版 shape 校验；Release changelog 和版本范围本身不代表每个后续版本都已完成现场验收。

请在有维护窗口时完整退出使用目标 profile 的 DSH Host，通过 DSH 官方插件管理方式从本地目录安装新版并移除旧包的启用项，随后冷启动。不要在运行中的 Host 热切换，也不要同时启用 alpha.2 和 alpha.3。回滚同样先退出 Host，再切回 alpha.2 或恢复原生配置。无需移动或修改会话文件。

验证命令和实现细节见 [DEVELOPMENT.md](DEVELOPMENT.md)，许可和来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。当前开发工作树不等于已经切换的 Host；真实 GUI 和冷启动验收独立进行。
