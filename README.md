# dsh-peak-price-guard

DeepSeek Harness 插件：**高峰时段拦截 DeepSeek API 请求，弹窗确认后再放行**。

- 北京时间高峰时段（**9:00–12:00 / 14:00–18:00**，此时 DeepSeek 官方价格为空闲时段的两倍）内，任何发往 DeepSeek 的模型请求会被挂起并弹出三选一确认框：**[取消] / [延后执行] / [继续]**。
- **成本预估**：弹窗上显示本次请求的高峰溢价上限估算（输入按全未命中缓存、输出按 `maxTokens`/默认 2048 计；价格内置于官方 V4 定价表，可用组合行 `pricing` 覆盖；模型无价格条目时隐藏）。
- **延后执行**：把请求挂起到下一个空闲时段边界（12:00 / 18:00）或每天指定北京时刻（设置 `deferHour`）自动执行；期间会话保持运行，后续消息进入收件箱队列依次执行。
- **智能路由**：小额请求（`smallRequestTokens`，默认 0 关闭）自动放行；用户消息关键词表自动放行/自动延后；`globalAllowlist` 模型子串永不拦截；`mode: observe` 仅记录不拦截。
- **战绩面板**：设置页展示累计节省（估算）、实际高峰溢价支出（按 usage chunk 实算）、继续/延后/取消/自动放行计数、北京时段热门排行；数据持久化于 `$DSH_HOME/plugins/peak-price-guard-stats.json`。每次处理请求会在控制台留下一行签名日志（`[dsh-peak-price-guard] 已为您拦截高峰请求 v1.3.0`）。
- 每个会话每 **N 小时**（默认 4，可配置）只询问一次，之后沿用上次选择（取消则拦截、继续则静默放行）。
- 只拦截**根会话**的请求；子代理、compaction、会话标题生成等内部调用不受影响。
- 120 秒无应答自动放行（fail-open），页面未打开时请求不会永久挂起。

## 安装

```bash
dsh plugin --profile web add github:bobbychina32747/dsh-peak-price-guard
```

重启 `dsh web`（或下次启动时）自动加载——bundle 补丁层会在引导期把插件行合入 profile 组合，无需任何手动配置。

> 本机测试未发布到 GitHub 前，可先 `dsh plugin --profile web add file:<本地路径>`。
> 也支持直接 `pnpm add` 到 profile 并手动把包名加入 `dsh.profile.bundles`，但 CLI 是最省事的路径。

## 卸载

```bash
dsh plugin --profile web remove dsh-peak-price-guard
```

或在设置页的插件面板中禁用/移除。

## 配置

**设置页**（推荐）：设置 → **高峰提醒**，可配置：启用开关、运行模式（拦截/仅记录）、提醒间隔（0.25–168 小时）、小额免打扰阈值（tokens）、延后执行时刻（北京小时，-1 = 下一个空闲边界）；保存即生效（持久化到用户设置文档，无需重启）。

**组合行配置**（高级）：作为设置的 `base` 层，或当作无设置服务时的兜底，编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: peak-price-guard
  config:
    promptWindowHours: 4    # 默认提醒间隔（小时）
    enabled: true           # 默认开关
    mode: guard             # guard | observe（仅记录）
    smallRequestTokens: 0   # 低于该输入 token 数自动放行（0 = 关闭）
    deferHour: -1           # -1 = 下一个空闲边界；0-23 = 每天该北京时刻执行
    autoAllowKeywords:      # 用户消息含以下关键词 → 自动放行
      - 紧急
      - 立即
    autoDeferKeywords:      # 用户消息含以下关键词 → 自动延后
      - 批量
      - 后台
    globalAllowlist: []     # 模型 id 子串白名单，永不拦截
    extraProviders: []      # 自定义指向 api.deepseek.com 的 provider id 列表
    pricing:                # 价格覆盖（元/百万 tokens，高峰价；溢价按 50% 计）
      deepseek-v4-pro:
        inputMiss: 9.0
        cacheHit: 0.3
        output: 27.0
```

## 工作原理

| 层 | 机制 |
| --- | --- |
| 自动加载 | `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，profile 引导期按 `dsh.profile.bundles` 顺序合入组合；`dsh plugin add` 会把它写进 profile 依赖和 bundles 列表 |
| Host 拦截 | 监听 `llm/stream` 瀑布（覆盖 agent 循环的所有流式调用，含 prepared-call 路径），高峰 + DeepSeek 时创建门控（gate）挂起请求；取消时产出与 adapter 失败同协议的终止 `finish` chunk（`PEAK_PRICE_DENIED`，携带超限 `providerRetryAfterMs` 让重试策略直接跳过退避），走 agent 循环优雅的错误通道 |
| 弹窗 | `dsh.client` 声明 + `exports["./client"]`，客户端半部注册到 `shell.overlay` 槽位，800ms 轮询 Host |
| 客户端↔宿主通信 | Typert Gateway 的 **SRC 模式**：Host 服务继承 `TypertRemoteService` 并用 `Remote` 协议标记方法（无需 typert 构建链），浏览器通过 `connection.rpc.call('/api', 'peak-price-guard/<method>', ...)` 直接调用 |
| 配置持久化 | 宿主通过 settings 服务注册 `peak-price-guard` 命名空间（schemastery schema + 组合 base 层），设置页写入、`watch` 实时生效 |

## 兼容性

- 针对 **DeepSeek Harness `0.1.0-rc.6`** 开发与验证。上游是开发者预览版，`dsh.bundle`/`dsh.client`/SRC Remote 协议可能变动，升级前请核对。
- 客户端 bundle 为手写的 `window.__ModuleLoader__` 工厂格式，无需打包工具；如需改成 TypeScript/JSX，请自行接入构建并保持该输出格式。
- 识别范围以 **provider id** 为准（`deepseek-official` 或含 `deepseek` 的 provider）：第三方平台（如 OpenRouter）即使提供 deepseek 模型，其定价不遵循官方高峰/空闲方案，不会被拦截。
- **延后执行的边界**：挂起最长约 4 小时（14:00 延后到 18:00）；期间请求占用该会话的当前轮次，若会话/进程被关闭则请求随之中止（不会自动重发）。价格表如有调整请用组合行 `pricing` 覆盖。
- 本插件是社区作品，与 DeepSeek 官方无关联、未经其背书。高峰时段定义（9:00–12:00 / 14:00–18:00）来自 DeepSeek 官方定价页，请以官方最新公告为准。

## License

[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)

个人学习、研究、非商业组织等非商业用途免费使用；**任何商业用途必须事先获得作者书面授权**，未授权商用视为违约。
