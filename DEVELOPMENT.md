# PTC disk history：单日志按需展示（开发中）

基座：240xu/dsh-session-lazy-view 0.3.6，MIT。不是 Reaper 的热修版本。
最低API基线为DSH `0.2.2-rc.5`，package manifest不设上限。每次Host activation从本机安装动态生成临时native适配快照：要求DSH与persistence包版本一致、检查已知类/方法结构；不携带静态native快照，不兼容时fail closed。

## 数据规则

- 大展示原文只在原 session.v4.jsonl.zstd 中，不拆分、不新建payload侧文件、不改写原历史。
- PTC read 的大 meta.lines在官方V4逐事件准入后，内存/GUI观察使用明确标注的普通预览与临时token。
- 不使用getter水合；JSON.stringify只处理预览，只有详情按钮会异步分页读原物理帧。
- 原事件身份、seq、调用配对、content、arguments、错误及模型可见消息保持不变。
- 正式存储默认 open/read仍完整，用于原生日志导出；GUI原生恢复与观察通过显式presentation适配器选择薄视图。
- 写前按事件恢复完整meta，使用官方catalog编码；旧物化日志正常append的既有字节前缀保持不变。
- worker最多192MiB old generation、来源索引2份、引用50000条、页面64KiB；这些不是进程总RSS硬上限。
- 关闭worker使用Cordis effect disposer，不依赖不存在的dispose事件，不使用后台巡检。

## 接入方式

需要在冷启动之前整体替换三个provider：session-persistence-jsonl、agent-loop、session-query-sqlite；详情路由和客户端随bundle启用。不能在正在运行的Host里事后替换基础持久化服务。

每次验证目标DSH版本：

```powershell
$env:DSH_INSTALL_DIR='C:\softwares\node-arm64\node_modules\@deepseek-ai\dsh'
node scripts/check.mjs
node --test "test/*.test.js"
```

Host activation时从当前官方安装动态生成private native backend到系统临时目录，运行时检验包版本和类/方法布局，Fiber dispose时清理临时快照。`scripts/prepare-native.mjs`为独立诊断工具，默认也只写系统临时目录；生成代码保留官方LICENSE与source SHA256，不修改安装版DSH文件。

## 目前验证

- 精确物理帧、跨帧JSONL、压缩数据内magic、checksum、stale修订、Unicode超长行续读、响应字节上限。
- 真实官方存储与query服务：薄/完整cache隔离、模型消息一致、append原始压缩前缀不变。
- 复制子会话后移走父日志，子日志完整原文仍在且内存引用可恢复。
- 详情HTTP边界、主页面点击后才读、上一页游标有界、收起/卸载abort释放。

原生 AgentRegistry/AgentLoop恢复的完整隔离组合已通过（不调用模型）；alpha.2合计92项自动化测试通过。UI的虚拟组件测试尚不等于当前Web GUI冷启动验收。
新 live PTC 结果仍走官方完整发布流程，本版只优化历史冷恢复/查询，新结果要到后续冷加载才转为薄视图；不宣称运行中所有metadata有驻留上限。
原生ZIP使用storage完整read，不会把预览写进ZIP，但显式全量export仍可能需要大量内存。
V0-V3迁移暂走官方完整迁移路径；目标native V4由新路径处理。坏/撕裂尾部不会静默丢弃，presentation路径先拒绝，不承诺优化crash-repair。

## 内存对照记录

相同规模合成单事件：约30.6MiB meta原文。
官方完整读取：主线程GC后增量约31.2MiB，RSS124MiB，耗时286ms。
新展示读取：主线程GC后增量约0.1MiB，4KiB预览，RSS305MiB，耗时2079ms。
该合成单大行测试说明新路径改变了驻留形态，但worker与瞬时解析会增加成本，不能只看主线程heap宣称总内存更小。

用户旧会话独立只读复测（alpha.2）：目标失败会话77,083事件/27,688,077压缩字节，192MiB worker、1GiB诊断主堆下耗时6,623ms，RSS484.3MiB，302个ACK batch，最大batch256；SHA-256前后相同。
64.6MiB大日志20,813事件/1169个长PTC metadata：耗时28,487ms，RSS485.2MiB，主线程GC后heap212.5MiB，82个batch，最大256；SHA-256前后相同。两者均无自动详情读取、源日志写入或外置正文文件。
