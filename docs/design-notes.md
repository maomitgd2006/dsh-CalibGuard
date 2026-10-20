# 实现决策与协议

本页记录几个"看起来反直觉、但有明确原因"的决定，以及 Node ↔ Python 的协议。
读者对象：要改这个插件、或想把它接到别处的人。

## 一、设备定档：低算力显卡必须回落 CPU

开发测试机是 **GTX 1060 5GB（算力 6.1）**，而 `torch 2.11.0+cu128` 的轮子最低要求 **sm_75**。

`CodeBERTClassifier` 自己只判断 `torch.cuda.is_available()` —— 它**看不到算力**，于是会选中 CUDA，
然后在每个文件上抛 `CUDA error: no kernel image is available`；引擎的安全降级会把这条错误包装成
「每份文件都转人工」，**看起来像成功，实际上零判别力**。

桥接进程因此在 **import torch 之前**先定档（与 `CG_GUI/launcher.py` 的 `CUDA_MIN_COMPUTE_CAP` 同阈值）：

- 用 `nvidia-smi --query-gpu=name,compute_cap` 读算力；算力 < 7.5 → 强制 CPU；
- 读不到算力时才在**子进程**里跑一次最小 CUDA 内核自检（失败不污染本进程）；
- 强制手段是 `CUDA_VISIBLE_DEVICES=-1`。**不能写空串**：实测 `torch 2.11` 把
  `CUDA_VISIBLE_DEVICES=""` 当作「未设置」，`is_available()` 仍为 `True`；只有 `-1` 才真正隐藏设备。

定档结论出现在 `calibguard_status` 的 `devicePolicy`（含理由），审计结果里也带实际设备。

## 二、凭据：不硬编码、不隐式继承

- **不扒宿主环境**：桥接子进程环境经过清洗，形如 `*KEY*` / `*PASSWORD*` / `*SECRET*` / `*TOKEN*`
  以及全部 `DSH_*` 的变量都不传（规则复用 DSH 导出的 `scrubbedParentEnv`，不复制它的正则）；
- **不写死凭据名**：要哪把凭据由配置 `credentialRef` 指定，交给 DSH 的 `ctx.credentials.resolve()`
  解析——名字写在配置里，代码里没有；
- **Key 不上命令行**：凭据随请求体走 stdin 管道下发，不进 argv（进程列表可见）、不进环境变量
  （会暴露给整个子进程树）；
- **每次重新解析**：换 Key 下一次审计即生效，不用重启；
- **面板写 Key**：走 `PUT /api/calibguard/credential` 写入 DSH 凭据库，而不是明文写进共享设置文件。

## 三、客户端半边：先不做，后来做了

DSH 允许插件用**纯 JS**（无需打包器）贡献浏览器 UI。**早期版本（v0.1 之前的设计）刻意不带**：
当时无法在开发机上验证浏览器侧代码，而 client bundle 在宿主启动时就会被读取
（缺文件会直接抛 `MissingClientBundleError`），把没法验证的 UI 塞进正在使用的 GUI 风险不对称，
因此工具卡片只由 `output.render` 的文本承担。

**现已实现**（`lib/client.js`）：侧边栏图标 + `main` 面板 + 宿主 HTTP 路由。UI 注册全部包在
try/catch 里——面板起不来不影响工具；同时契约细节记录在
[dsh-plugin-contract.md](dsh-plugin-contract.md)。

## 四、架构与协议

```
DSH (Node 宿主)                                桥接进程 (Python, 常驻)
┌───────────────────────────┐   stdin/stdout  ┌─────────────────────────────────┐
│ lib/index.js  apply()     │  行式 JSON 协议  │ bridge/calibguard_bridge.py     │
│  ├─ 工具 ×2               │ ◄─────────────► │  ├─ 设备定档（import torch 前） │
│  ├─ 路由 ×5               │                 │  ├─ AuditPipeline（引擎原样）   │
│  ├─ calibguard 服务       │                 │  ├─ op: status / audit          │
│  └─ 系统提示词片段(可选)   │                 │  └─ 空闲回收 / 崩溃尾日志       │
│ lib/engine.js 进程管理     │                 │                                 │
│ lib/client.js 浏览器面板   │ ◄─ HTTP ── 浏览器 │                                 │
└───────────────────────────┘                 └─────────────────────────────────┘
```

- **进程模型**：宿主第一次调用时 spawn，之后常驻；同一时刻只允许一条请求在飞（单飞 promise 链）；
  空闲 `idleShutdownMs` 后回收（默认 10 分钟）；崩溃后下次调用自动重启，并保留最后 20 行 stderr 供诊断。
- **协议**：一行一个 JSON 请求 `{id, op, paths?, options?}`，一行一个 JSON 响应
  `{id, ok, result|error}`；`op` 目前支持 `status` 与 `audit`。
- **服务暴露**：`ctx.provide('calibguard', …)`，方法 `inspect()` / `audit()` / `bridgeOptions()` /
  `diagnostics()` / `resolveCredential()` / `setCredential()` / `dispose()`，供其它插件复用同一套阈值与云端配置。
- **零硬依赖**：`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 都是动态 import，拿不到时自动退化
  （恒等 `defineTool` / 无 Config 结构校验），因此本包既能装进 profile 的 `node_modules`，也能用
  `file://` 行直接从仓库路径加载。
