# 会话内存管理器：开发说明

## 会话生命周期

`lib/session-controller-adapter.js` 使用安装版 SessionController。仅在自身的 Cordis Context 中拦截 AgentRegistry `create` 和 `resume`，保留原生返回的 `AgentHandle`。`follow` 始终使用被动观察，查看租约随流关闭释放。需要 Agent 的会话操作会占用活动租约，直到原生命令完成。

`lib/idle-agent-manager.js` 在最后一个租约释放后为符合条件的实例安排一次定时器。触发时重新检查句柄、实例、世代、查看者、正在处理的操作、真正的空闲阶段和两个收件队列。最终只调用确切的 `AgentHandle.dispose()`；关闭插件会撤销定时器并等待已经开始的释放，没有扫描循环或强制 GC。

`session-memory-controller` 插入独立的 Host 行，提供同一个 `sessionController` 服务。内置行由私有条件置于待机，保留其浏览器包与 Typert 描述；只有替换不兼容或启动失败并收尾后才放行原生 Host。该集成只在冷启动切换。配置页通过 DSH 自身的配置表单和版本校验写入 `.volatile()` 字段，不直接读写 profile 文件。

未知版本、缺少身份依据或其他插件独立持有的 Agent 不属于回收范围。不要把此机制当成任意第三方插件工作的全局锁。

## PTC 存储与展示

- 会话日志是唯一正文来源。官方 V4 校验后，只对大型 `read` 展示元数据生成有标记的预览和临时详情标识；无自动水合、无正文索引旁文件。
- 详情查询利用 Zstandard 物理帧位置以及日志修订校验按页读取。原生完整存储 API 不混用展示缓存；写入前逐事件恢复原元数据，再由官方 catalog 编码。正常追加保留旧压缩前缀。
- worker 默认老生代限制为 192 MiB，一次传送至多 256 个待确认事件。默认压缩帧上限 64 MiB、单行上限 8 MiB；超限、坏帧和撕裂尾部不静默换成全量解析。这些限制不是进程 RSS 上限。
- V0–V3 迁移和完整导出仍走官方全量路径。现有原生 `read` 行被轻量行替换，保留文件打开、调用检查和分页操作，不复用原生语法高亮或文件右键菜单。
- 存储适配按安装版生成匹配的临时实现，用完随 Cordis Fiber 清理；不修改 DSH 安装文件。会话控制器回收要求 DSH、SessionController 与 AgentLoop 均为 `0.2.2-rc.5` 或更高，并继续校验安装版 API shape；低于基线、版本无效或接口不兼容时使用原生控制器。

## 隔离验证

```powershell
$env:DSH_INSTALL_DIR = '<已安装的 @deepseek-ai/dsh 包目录>'
node --test 'test/*.test.js'
node scripts/check.mjs
```

当前工作树证据：全量隔离测试 `128/128` 通过并正常退出；测试使用当前安装的 DSH `0.2.3-alpha.2`；`scripts/check.mjs` 通过；alpha2 Query/native snapshot focused `15/15`、Adapter/native lifecycle `16/16`、Client 配置 `21/21`、Loader bundle `8/8` 均通过。测试使用隔离 Cordis 树和临时会话日志，不需要当前 profile，也不向远程模型发送请求。回收前后用日志长度、SHA-256 和 `deriveMessages()` 对比完整性；实际 Host 巡检应看在线 Agent 数与 Session 是否脱离注册表，不只看 RSS。

合成约 32.1 MB PTC 行数据的展示扫描保留 4 KiB 预览，没有创建外置 payload 文件；该测试测量的是展示路径的有界传输，不是完整 Host RSS 上限。
