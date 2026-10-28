# GMGN Binance Agent

在 GMGN 的 BSC 页面使用 Binance Agentic Wallet 的悬浮交易面板。Windows + Chrome / Edge，实验性开源软件，非 GMGN 或 Binance 官方产品。

## 功能

- 自动跟随页面 CA，手动粘贴 CA，展示余额、持仓和本地可核对的成本记录。
- 固定表头、可拖动/收起面板、明暗主题、买卖快捷金额和可编辑比例。
- Gang、Flap 内盘适配；Four Agent ID 专属内盘适配。外盘通过 Binance 钱包聚合交易，取决于官方报价和流动性。**不代表支持所有 Four 普通发行模式。**
- 按总供应量买入快捷键；平台限额和余额约束以实际路由为准。
- 自动串联必要的中间币兑换、有限额度授权和买卖；本地持久化队列、审批状态更新、链上回执核对。

## 安装

需要 Windows 10/11、Node.js 24 或以上（含 npm）、Chrome 或 Edge，以及可用的 Binance Agentic Wallet 账户。

1. 下载或克隆本仓库，放在固定目录，例如 `C:\tools\gmgn-binance-agent`。
2. 在项目目录的 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\\install.ps1
```

脚本只注册当前用户的 Native Messaging 助手，不需要管理员权限。首次安装下载 ethers、固定版本的 Binance CLI 和经过 SHA-256 校验的官方 Four 辅助脚本。安装本身不会发起交易。网络需能访问 npm、GitHub、Binance 和 BSC RPC。

3. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，加载项目的 `extension` 目录。
4. 打开 GMGN BSC 代币页面，点击“连接币安 Agent 钱包”，在官方登录页面完成连接；需要时在 Binance App 中批准。

可以通过 `-NodePath`、`-BawPath`、`-FourPath` 指定已有运行文件的绝对路径。更新安装会复用有效的本地配置。路径不能包含百分号。移动项目后需要重新安装助手并更新浏览器中的扩展路径。

## 交易行为与边界

**快捷金额、比例以及买入/卖出按钮会直接发起真实交易流程。** 不存在模拟交易模式。必要的代币授权仍是链上交易；面板不能取消 Binance App 的审批或钱包风控。

- 默认单笔买入预算上限为 0.1 BNB，Gas 预留为 0.00005 BNB；本地 `.local/config.json` 可配置。滑点由面板选择，较高滑点可能显著影响成交价格。
- 钱包交易锁使同一钱包的订单按顺序执行。看到“未提交”不等于成功；App 点击审批也不等于链上成交。
- 结果未知时会继续核对，不自动重发该笔未知交易。后续已授权步骤仅在前一步核对成功后继续。不要通过删除订单文件或手动解锁来跳过核对。
- 钱包明确拒绝的“未提交”订单不会自动补单。锁定状态与待审批列表不一致时会显示同步提示。
- 快捷流程的代币审计不可用时可能继续；已知高风险会拦截。审计结果不能保证资产安全。
- MEV / Gas 选项作用于支持这些参数的钱包聚合交易；合约调用受钱包侧设置和平台接口限制。
- 部分内盘需要先兑换中间币，可能产生多笔交易和额外费用；价格变化、RPC、App 审批和 Binance 服务会影响耗时，不保证与其他工具相同速度。
- 成本统计仅覆盖本地能核对的记录，不是完整钱包盈亏。其他工具交易可能导致差异。
- 丢失订单号时会用钱包历史中的链、币对、金额、时间窗口和唯一性匹配恢复。不要在多个工具中同时提交相同币对/金额订单；该匹配仍有归属歧义风险。

## 更新与卸载

更新源码后，在扩展管理页点击重新加载并刷新 GMGN。先核对进行中的订单：助手重新连接可能恢复已授权的队列或多步骤流程。

`powershell -ExecutionPolicy Bypass -File .\\uninstall.ps1` 移除本项目的助手注册；在浏览器中移除扩展。卸载保留本地订单与钱包登录资料，不会撤销链上授权。

## 开发与验证

```powershell
npm ci --ignore-scripts
npm test
python scripts/build-panel.py
```

HTML/CSS 修改后必须重新生成 `extension/panel-template.js`。CI 检查生成文件一致性并执行隔离测试。测试使用模拟钱包，不下真实订单。

`npm run preview` 需要先安装配置，仅供本机读取钱包的预览，不支持登录和下单。
`npm run doctor` 和 `node scripts/native-smoke.mjs` 用于本机诊断。诊断输出可能包含钱包信息，不要直接上传。

## 结构与隐私

- `extension/`：GMGN 隔离环境中的面板和受限消息桥。
- `host/`：钱包 CLI、路由、订单状态机、队列和回执验证。
- `tests/`：隔离回归测试。
- `.local/`：个人配置和真实订单；`runtime/`：安装下载的组件。均不提交。

此项目未接受独立安全审计。问题与限制见 [SECURITY.md](SECURITY.md)，第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目原创代码使用 MIT 许可证；第三方组件遵循其各自条款。
