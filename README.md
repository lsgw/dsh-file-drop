# dsh-file-drop

DeepSeek Harness Web 持久插件：把文件或目录拖入会话，按模式定位原始路径，或复制到用户级上传目录后把落盘路径插入输入框草稿。

## 入口与模式

- 拖拽到窗口任意位置：上传模式与定位模式都捕获包括图片在内的所有文件和目录，不会交给 DSH 原生附件上传；上传模式统一复制到用户级上传目录，定位模式只定位原始路径。多 composer 时按事件目标、指针和焦点归属，无法唯一归属的空白区域拖拽不会误写其他草稿。
- 回形针按钮：打开系统文件选择器，支持多选。
- 上传模式：文件和目录只复制到 `<DSH_HOME>/.dsh-drops/`，不使用原始路径快捷通道；Windows 默认即 `C:\Users\<用户名>\.dsh\.dsh-drops\`。
- 定位模式：文件和目录只定位、不复制；已有可信原始路径时直接插入，否则通过 locate protocol v2 搜索并校验。

每次拖拽或回形针选择后先从 Host 确认当前模式；确认失败时按定位模式接管并停止处理，提示“未上传”。切换到定位模式立即生效，切换到上传模式须等待 Host 持久化确认。pending 状态不会自动消失；只有成功或失败等终态会在 3.5 秒后收起。异步完成前会重新读取当前草稿和光标，并校验会话、模式 revision 与操作取消信号，避免旧任务覆盖新输入。

## 上传边界

- 不再设置 25MiB 单文件或 64MiB 目录固定上限；单个文件和单个目录可使用用户级上传目录的剩余配额。
- 一次最多处理 500 个顶层文件或 32 个根目录；单个目录最多 500 个文件、10000 个总条目和 32 层。
- upload protocol v3 先提交不含文件内容的结构清单，再以最多 4MiB 的 `application/octet-stream` 请求逐块写入。
- 所有会话共享 `<DSH_HOME>/.dsh-drops`，统一统计累计容量和文件系统条目；默认上限为 10000MiB 和 10000 条目，可在设置页的上传模式下配置。声明大小会在路径锁内预分配 staging，因此并发上传和中断任务也计入配额。
- Host 是模式和配额判定的唯一数据源；定位模式下，upload init/chunk/finish 都会被拒绝，切换到定位模式还会等待半初始化任务并停止活动 staging；临时删除失败不撤销已保存并广播的定位模式，后续 size 读取会重试清理。设置文件仅接受最新完整 schema，损坏或不可读时 fail closed，不会回退上传。达到容量或条目上限时拖拽提示“已达上传配额，需清理 .dsh-drops”。降低上限到当前累计以下是允许的，但清理或提高上限前不能继续上传。
- 设置页以 Host 原子 patch 保存模式或配额，避免多标签页旧快照覆盖其他字段；显示用户级上传目录的两项实际累计。“清空并重置累计”删除 `<DSH_HOME>/.dsh-drops`，完成后容量和条目累计均为 0，不维护脱离磁盘内容的独立计数器。
- Host 验证清单网络字节、声明大小、连续偏移、精确块长度、相对路径、文件/目录前缀冲突和清洗后碰撞；BOM、非法 UTF-8 和任意二进制均按原始字节传输。
- 用户级上传目录最多 16 个活动上传会话；10 分钟无活动会过期。Host 重启或请求中断留下的 staging 会在下一次 init 或 size 读取时回收；删除失败会保留可重试状态。
- 文件完成后从内部 staging 原子重命名；目录使用 staging/backup 原子替换；同名单文件使用编号新文件，不覆盖已有文件。永久名按 UTF-16 与 UTF-8 component 预算截断并保留扩展名。
- `.dsh-drops`、staging、backup 和目标路径中的 symlink/junction 会被拒绝。clear 先取消活动会话，再原子隔离并后台删除，返回 `cleanupPending` / `cleanupError`；重启遗留 quarantine 仍计入 size 与累计配额。

## 定位边界

- protocol v2 的 metadata 阶段签发 challenge；后续阶段绑定 phase、会话、活动工作区、文件身份、候选和目录采样集合。
- challenge 支持同请求并发复用和 30 秒幂等回放；数量、单记录、每会话、全局字节以及同时运行的 locator 数量都有上限。
- metadata 阶段只使用 Node `fs/promises` 在当前/其他活动 Session 工作区以及 Desktop、Documents、Downloads 等可信根中做有界递归扫描；最多访问 20000 个条目，硬预算为 10 秒。
- 递归扫描、目录指纹和 Host 配额扫描运行于最多 4 个短生命周期 Node 子进程。超时会强制终止并等待 `close`；无法确认回收时保留占用槽位，避免残留进程被无限累积。
- 不调用 Everything、PowerShell、plocate、mdfind 或其他系统索引命令，也不探测固定磁盘、挂载点或后台索引。
- 内容校验失败后，第二轮 metadata 会排除服务器签发的失败候选，再在同一组可信根内继续寻找嵌套原件。
- full 指纹最多自动读取 8 个候选；目录结构/内容指纹最多自动读取 16 个候选，超过后降级为人工选择。
- 超过 10000 条目或 32 层的截断目录不会自动判定 found；扫描和候选验证都不会跟随 symlink/junction。
- 搜索范围来自 Host 根据 Session 生成的可信工作区根，并补充固定的用户 Desktop、Documents、Downloads 目录；不再扩展到系统文件索引或其他平台专属搜索根。
- 目录相对路径的线协议只使用 `/` 分隔；POSIX 文件名中的 `\` 保持为普通字符，Windows 对非法的 `\` 组件直接拒绝，避免跨平台静默改写目录结构。

## 会话与本地信任边界

- 定位搜索仍从当前 DSH Session 的 `header.cwd` 获取工作区；上传仅校验 session 绑定，落盘目录不读取或跟随工作区路径。
- 上传或定位请求中的显式空白、非字符串或不存在的 `sessionId` 返回 400/404；size 请求体必须为 `{}`，清理用户级上传目录必须发送 `{ "global": true }`。
- 浏览器跨站 Origin / Sec-Fetch-Site 请求会被拒绝。无 Origin 的本地 CLI 请求仍被允许，因此同一系统账号下的本地调用者属于信任边界。
- 纯 Node 路径 API 无法彻底消除同一系统账号恶意进程制造的瞬时 reparse-point TOCTOU；写入前后的重复 lstat/realpath 检查用于缩小窗口。

## 定位架构

- `src/locate/` 只使用 Node `fs/promises` 完成路径扫描、目录结构读取和指纹校验，不依赖平台 adapter 或系统索引命令。
- `src/shared/node-path.js` 使用 Node 原生 `path` 规则统一路径身份；Windows 的大小写处理只保留为路径安全键的一部分，不形成独立平台实现层。
- `src/locate/isolate.js` 使用普通 Node 子进程执行可终止的文件系统任务，和定位算法本身解耦。
- GitHub Actions 在 Windows、Ubuntu 与 macOS 上运行同一套 Node 文件系统测试及 npm 打包检查。

## 文件

仓库保留完整源码和测试；npm 安装包只携带生成的 `client.js`、Host 运行源码、元数据与文档，不携带 `src/client/`、`scripts/` 和 `test/`。

- `client.js`：由 esbuild 生成的单一 DSH Web bundle，不直接编辑。
- `index.js`：只导出 Host 公共入口。
- `src/client/view.js`：冻结的当前 UI、三个 React 组件和 CSS。
- `src/client/runtime.js`、`api.js`、`drop-controller.js`：客户端状态、请求与拖拽编排。
- `src/client/upload-strategy.js` / `locate-strategy.js`：机械隔离的上传与定位流程。
- `src/shared/contract.js`：浏览器与 Host 共用的路由、协议版本、配额和错误常量。
- `src/host/`：薄路由/HTTP 壳、设置、上传状态机、安全落盘与清理。
- `src/locate/`：候选编排、challenge、指纹和可终止隔离任务。
- `src/shared/node-path.js`：Node 原生路径规范化和路径身份键。
- `test/*.test.mjs`：UI/架构契约、客户端、设置、Host、Node 定位与安全回归测试。

## 安装与验证

当前 profile 使用 pnpm patched dependency 固定修改。源码更新后执行：

```sh
npm ci
npm run build
npm test
node --test --test-concurrency=1 test/*.test.mjs
npm run verify:package
npm run verify:tarball
```

验证通过后，将真实 tarball 解包得到的 `package/` 内容镜像到 `pnpm patch dsh-file-drop@1.0.0` 返回的工作目录，再在 profile 根目录执行：

```sh
pnpm patch-commit <patch-work-directory>
pnpm install --frozen-lockfile
node <source-repository>/scripts/verify-package.mjs node_modules/dsh-file-drop
```

`verify-package.mjs` 应同时对源码目录、tarball 解包目录、patch-work 和最终 `node_modules/dsh-file-drop` 通过。客户端修改在 Web 资源刷新后生效；Host 模块修改需要下一次正常重启 `dsh web`。
