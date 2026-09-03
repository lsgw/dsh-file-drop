# dsh-file-drop

DeepSeek Harness Web 持久插件：把文件或目录拖入会话，按模式定位原始路径，或复制到用户级上传目录后把落盘路径插入输入框草稿。

## 入口与模式

- 拖拽到窗口任意位置：上传模式与定位模式都捕获包括图片在内的所有文件和目录，不会交给 DSH 原生附件上传；同一批顶层文件和目录会按标准 File System Handle 的实际 kind 完整分类处理，避免目录伪 File 重复。多 composer 时按事件目标、指针和焦点归属，无法唯一归属的空白区域拖拽不会误写其他草稿。
- 回形针按钮：打开系统文件选择器，支持多选。
- 上传模式：文件和目录只复制到 `<DSH_HOME>/.dsh-drops/`，不使用原始路径快捷通道；Windows 默认即 `C:\Users\<用户名>\.dsh\.dsh-drops\`。
- 定位模式：文件和目录只定位、不复制；仅依据 File 元数据和标准目录句柄，通过 locate protocol v2 搜索并校验。
- 目录拖拽依赖标准 `DataTransferItem.getAsFileSystemHandle()`；不支持该 API 的浏览器仍可处理文件拖拽，但不会处理目录拖拽。
- 定位模式设置页支持“授权外部搜索根”：输入当前 Host 所在环境中的绝对目录路径，Host 验证真实目录后持久化；最多授权 16 个根，可随时撤销。授权记录独立保存到 `<DSH_HOME>/dsh-file-drop-search-roots.json`，不改变原有模式和配额设置文件。路径必须是 Host 所在机器的路径；标准 Web 目录句柄不提供可交给 Host 的绝对路径，因此这里不伪装成原生目录选择器。

每次拖拽或回形针选择后先从 Host 确认当前模式；确认失败时按定位模式接管并停止处理，提示“未上传”。切换到定位模式立即生效，切换到上传模式须等待 Host 持久化确认。pending 状态不会自动消失；只有成功或失败等终态会在 0.5 秒后收起。异步完成前会重新读取当前草稿和光标，并校验会话、模式 revision 与操作取消信号，避免旧任务覆盖新输入。

## 上传边界

- 不再设置 25MiB 单文件或 64MiB 目录固定上限；单个文件和单个目录可使用用户级上传目录的剩余配额。
- 一次最多处理 500 个顶层文件和 32 个根目录，两项上限独立且超限会明确拒绝；单个目录最多 500 个文件、10000 个总条目和 32 层。
- Host 强制 upload protocol v3：先提交不含文件内容的结构清单，再以最多 4MiB 的 `application/octet-stream` 请求逐块写入；Host 请求体读取限时 30 秒，客户端等待 chunk 响应限时 45 秒，停滞请求会退出并尝试取消 staging。
- 所有会话共享 `<DSH_HOME>/.dsh-drops`，统一统计累计容量和文件系统条目；默认上限为 10000MiB 和 10000 条目，可在设置页的上传模式下配置。声明大小会在路径锁内预分配 staging，因此并发上传和中断任务也计入配额。
- Host 是模式和配额判定的唯一数据源：上传模式拒绝 locate 路由，定位模式拒绝 upload init/chunk/finish；模式切换和在途定位响应通过读写门闩线性化。切换到定位模式还会等待半初始化任务并停止活动 staging；临时删除失败不撤销已保存并广播的定位模式，后续 size 读取会重试清理。设置文件损坏或不可读时 fail closed，不会回退上传。
- 设置页以 Host 原子 patch 保存模式或配额，磁盘 JSON 通过私有临时文件、`fsync` 和 rename 替换，避免多标签页旧快照覆盖及半截文件；显示用户级上传目录的两项实际累计。“清空并重置累计”删除 `<DSH_HOME>/.dsh-drops`，完成后容量和条目累计均为 0。
- Host 验证清单网络字节、声明大小、连续偏移、精确块长度、相对路径、文件/目录前缀冲突和清洗后碰撞；BOM、非法 UTF-8 和任意二进制均按原始字节传输。
- 用户级上传目录最多 16 个活动上传会话；10 分钟无活动会过期。Host 重启或请求中断留下的 staging 会在下一次 init 或 size 读取时回收；删除失败会保留可重试状态。
- 文件和目录完成后都从内部 staging 原子重命名到一个未占用目标；同名或清洗后同名的目标统一编号为 `name (1)`、`name (2)`，从不覆盖、替换或删除已有文件和目录。提交完成后的空 staging 清理失败只返回 cleanup 状态，不把已落盘结果误报为失败；后续回收成功会解除该错误状态。
- `.dsh-drops`、staging 和目标路径中的 symlink/junction 会被拒绝。新建目录/文件分别请求私有 `0700/0600` 模式；clear 先取消活动会话，再原子隔离并后台删除；遗留 quarantine 会在后续清理时重试。

## 定位边界

- protocol v2 的 metadata 阶段签发 challenge；后续阶段绑定 phase、会话、活动工作区、授权外部根集合、文件身份、候选和目录采样集合。二轮 metadata 只能用已完成 challenge 引用 Host 签发的失败候选，不接受客户端裸排除路径。
- challenge 支持同请求并发复用和 30 秒幂等回放；数量、单记录、每会话、全局字节以及同时运行的 locator 数量都有上限。
- metadata 阶段只使用 Node `fs/promises` 在当前/其他活动 Session 的 Host 签发工作区根，以及用户显式授权的外部搜索根中做有界递归扫描；最多访问 20000 个条目，硬预算为 10 秒。
- 递归扫描、目录指纹和 Host 配额扫描运行于最多 4 个短生命周期 Node 子进程。超时会强制终止并等待 `close`；无法确认回收时保留占用槽位，避免残留进程被无限累积。
- 不调用 Everything、PowerShell、plocate、mdfind 或其他系统索引命令，也不探测固定磁盘、挂载点或后台索引。
- 内容校验失败后，第二轮 metadata 会排除服务器签发的失败候选，再在同一组可信根内继续寻找嵌套原件。
- full 指纹最多自动读取 8 个候选；目录结构/内容指纹最多自动读取 16 个候选，超过后降级为人工选择。
- 超过 10000 条目、32 层或 12MiB 结构 JSON 预算的截断目录不会自动判定 found；locate 请求总上限为 16MiB。扫描和候选验证都不会跟随 symlink/junction；每个候选在进入 challenge 前必须 `realpath` 落在 Host 可信根内，目录结构/内容摘要匹配后还会再次 containment 复验；文件句柄在指纹读取前后与路径物理身份复核。
- 搜索范围来自 Host 根据 Session 生成的可信工作区根和用户已授权的外部根；不会扩展到未授权目录、固定用户目录、系统文件索引或平台专属搜索根。外部根每次使用都会在 3 秒硬期限内重新验证真实目录和稳定物理身份，根被撤销、替换或失效时对应 challenge 失效。根路径末端不能是 symlink/junction；父级链接按 realpath 解析，解析目标变化会使授权根失效。
- 目录相对路径的线协议只使用 `/` 分隔；POSIX 文件名中的 `\` 保持为普通字符，Windows 对非法的 `\` 组件直接拒绝，避免跨平台静默改写目录结构。

## 会话与本地信任边界

- 定位搜索从当前/其他活动 DSH Session 的 `header.cwd` 和用户授权的外部根获取搜索范围；没有 `sessionId` 时仍可使用已授权外部根，但不使用 Session 工作区；上传仅校验 session 绑定，落盘目录不读取或跟随工作区路径。
- 上传或定位请求中的显式空白、非字符串或不存在的 `sessionId` 返回 400/404；size 请求体必须为 `{}`，清理用户级上传目录必须发送 `{ "global": true }`。
- 所有插件接口只接受环回 TCP 对端；浏览器 `Origin` 还必须使用字面量 `localhost`、`127.0.0.0/8` 或 `::1`，并与请求 Host authority 一致，从而拒绝跨站、DNS rebinding 和局域网无 Origin 请求。无 Origin 的环回 CLI 请求仍属于同一系统账号信任边界。
- 外部根授权是应用级配置操作，不提供额外的 OS 身份认证；同源页面和同一系统账号的本地调用者仍属于既有 Host 信任边界。授权文件由当前 DSH Host 实例独占维护，不用于多个 Host 进程共享写入；写入先同步临时文件再原子替换，避免产生半截 JSON，但不承诺断电后保留最新一次变更。
- 纯 Node 路径 API 无法彻底消除同一系统账号恶意进程制造的瞬时 reparse-point TOCTOU；写入前后的重复 lstat/realpath 检查用于缩小窗口。

## 定位架构

- `src/locate/` 只使用 Node `fs/promises` 完成路径扫描、目录结构读取和指纹校验，不依赖平台 adapter 或系统索引命令。
- `src/shared/node-path.js` 区分词法路径键、真实路径键和清单碰撞键：物理路径先通过 `realpath` 与 `dev/ino` 识别，清单碰撞采用保守的 NFC/大小写键，避免把两种语义混用。
- `src/locate/isolate.js` 使用普通 Node 子进程执行可终止的文件系统任务，和定位算法本身解耦。
- GitHub Actions 在 Windows、Ubuntu 与 macOS 上运行同一套 Node 文件系统测试及 npm 打包检查。

## 文件

仓库保留完整源码和测试；npm 安装包只携带生成的 `client.js`、Host 运行源码、元数据与文档，不携带 `src/client/`、`scripts/` 和 `test/`。

- `client.js`：由 esbuild 生成的单一 DSH Web bundle，不直接编辑。
- `index.js`：只导出 Host 公共入口。
- `src/client/view.js`：当前 UI 的插件组件、拖拽编排和 CSS；`search-root-view.js` 独立承载外部根设置控件。
- `src/client/runtime.js`、`api.js`、`drop-controller.js`：客户端状态、请求与拖拽编排。
- `src/client/drop-data.js`：标准 File/Blob 与 File System Handle 处理，不读取桌面绝对路径或 URI 快捷路径。
- `src/client/search-roots.js`：外部搜索根 API、跨标签同步和状态管理。
- `src/host/search-roots.js`：外部根验证、持久化、撤销和 Host 路由。
- `src/client/upload-strategy.js` / `locate-strategy.js`：机械隔离的上传与定位流程。
- `src/shared/contract.js`：浏览器与 Host 共用的路由、协议版本、配额和错误常量。
- `src/host/`：薄路由/HTTP 壳、设置、上传状态机、安全落盘与清理；`gate.js` 提供读写门闩，`search-root-inspect.js` 以最多 4 个全局槽位约束外部根文件系统验证；超时任务在真实结束前继续占用槽位，避免悬挂 I/O 无界累积。
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

`verify-package.mjs` 会校验 npm exports、DSH 插件元数据、Cordis patch 和运行协议；`verify-tarball.mjs` 还会检查 28 个运行文件的严格白名单。两项校验应同时对源码目录、tarball 解包目录、patch-work 和最终 `node_modules/dsh-file-drop` 通过。客户端修改在 Web 资源刷新后生效；Host 模块修改需要下一次正常重启 `dsh web`。
