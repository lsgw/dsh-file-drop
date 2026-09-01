# dsh-file-drop

DeepSeek Harness Web 持久插件：把非图片文件或目录拖入会话，取得原始路径，或上传到工作区后把落盘路径插入输入框草稿。

## 入口与模式

- 拖拽到窗口任意位置：捕获非图片文件/目录拖拽并显示处理状态；纯图片拖拽继续交给 DSH 原生附件流程。多 composer 时按事件目标、指针和焦点归属，无法唯一归属的空白区域拖拽不会误写其他草稿。
- 回形针按钮：打开系统文件选择器，支持多选。
- 上传模式：桌面壳路径、uri-list 路径优先；没有原始路径时上传到 `<会话工作区>/.dsh-drops/`。
- 搜索定位模式：文件和目录都通过 locate protocol v2 搜索并校验原始内容，不复制文件。

pending 状态不会自动消失；只有成功或失败等终态会在 3.5 秒后收起。异步完成前会重新读取当前草稿和光标，并校验会话、模式 revision 与操作取消信号，避免旧任务覆盖新输入。

## 上传边界

- 单文件不超过 25MiB；一次最多处理 500 个顶层文件或 32 个根目录。
- 单个目录最多 500 个文件、10000 个总条目、32 层，解码后总计不超过 64MiB。
- upload protocol v2 支持显式目录 marker，因此会保留空的嵌套子目录；客户端在每次含 marker 的上传前刷新并等待 settings 能力，明确兼容或降级到旧 Host。
- 每个会话工作区的 `.dsh-drops` 累计上限为 1GiB 和 10000 个文件系统条目；统计与写入位于同一个物理路径锁内。
- 文本只有在严格 UTF-8 解码后能逐字节往返时才使用 text payload；BOM 会保留，非法 UTF-8 自动使用严格 base64，禁止静默改写。
- Host 在写盘前验证网络字节、JSON、声明大小、base64、相对路径、文件/目录前缀冲突和清洗后碰撞。
- 目录使用固定短临时名和 staging/backup 原子替换；同名单文件使用编号新文件，不覆盖已有文件。永久名按 UTF-16 与 UTF-8 component 预算截断并保留扩展名。
- `.dsh-drops`、staging、backup 和目标路径中的 symlink/junction 会被拒绝。clear 先原子隔离再后台删除，并返回 `cleanupPending` / `cleanupError`；重启遗留 quarantine 仍计入 size 与累计配额。

## 定位边界

- protocol v2 的 metadata 阶段签发 challenge；后续阶段绑定 phase、会话、活动工作区、文件身份、候选和目录采样集合。
- challenge 支持同请求并发复用和 30 秒幂等回放；数量、单记录、每会话、全局字节以及同时运行的 locator 数量都有上限。
- metadata 递归搜索使用跨全部根的 20000 条目和 5 秒硬预算；递归、目录指纹及 Host 配额扫描运行于最多 4 个短生命周期子进程。超时会强制终止并等待 `close`；无法确认回收时保留占用槽位，避免残留进程被无限累积。
- OS 索引按行流式收集 100 个候选，达到输出/时间上限后同样等待进程回收。系统命令使用可信绝对路径、固定非工作区 cwd 和最小环境；POSIX 文件名前使用 `--`。Windows PowerShell 回退会按文件/目录选择 `-File` 或 `-Directory`。
- Everything CLI 不再通过工作区或普通 PATH 自动发现；需要时将 `DSH_FILE_DROP_EVERYTHING_CLI` 设置为已审查的 `es.exe` 绝对路径。
- 内容校验失败后，第二轮 metadata 会排除服务器签发的失败候选，再在同一有界范围内继续寻找嵌套原件。
- full 指纹最多自动读取 8 个候选；目录结构/内容指纹最多自动读取 16 个候选，超过后降级为人工选择。
- 超过 10000 条目或 32 层的截断目录不会自动判定 found；direct/indexed 候选中的 symlink/junction 不会被读取。
- 搜索授权范围有意包含当前 DSH 进程中的活动工作区、系统文件索引和常用搜索根，可能读取当前工作区之外的候选。

## 会话与本地信任边界

- 当前 DSH Session 使用 `header.cwd`，同时兼容旧版 `meta.cwd`；工作区必须是有界绝对路径。
- 显式空白、非字符串或不存在的 `sessionId` 返回 400/404，不回退到全局目录；无会话清理必须发送 `{ "global": true }`。
- 浏览器跨站 Origin / Sec-Fetch-Site 请求会被拒绝。为兼容本地 CLI，无 Origin 请求仍被允许，因此同一系统账号下的本地调用者属于信任边界。
- 纯 Node 路径 API 无法彻底消除同一系统账号恶意进程制造的瞬时 reparse-point TOCTOU；写入前后的重复 lstat/realpath 检查用于缩小窗口。

## 文件

- `client.js`：拖拽、回形针、状态、草稿插入和 settings UI。
- `index.js`：Host 路由、同源校验和物理路径锁。
- `host-safety.js`：请求配额、会话、目录协议、原子落盘与清理。
- `locate/locator.js`：平台搜索与多阶段内容校验。
- `locate/isolate.js` / `isolate-runner.js`：并发受限、可强制终止的文件系统隔离任务。
- `locate/secure-locator.js`：challenge、会话绑定、并发与内存预算。
- `test/*.test.mjs`：客户端纯函数、Host 路由/文件系统和真实 locator 回归测试。

## 安装与验证

当前 profile 使用 pnpm patched dependency 固定修改。源码更新后执行：

```sh
npm test
node --test --test-concurrency=1 test/*.test.mjs
```

客户端修改在 Web 资源刷新后生效；Host 模块修改需要下一次正常重启 `dsh web`。
