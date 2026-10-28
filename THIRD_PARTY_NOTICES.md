# 第三方来源

## TMTN

Gang 合约 ABI、部署地址及路由设计参考 [bnbxcs/TMTN](https://github.com/bnbxcs/TMTN)，原始参考版本 `dd777dd8aff7ff81bca5168c5df8a36bcea1a97e`。适配代码主要位于 `host/routes/gang.mjs`。MIT 许可证及原版权声明保留在 [vendor/LICENSE.TMTN](vendor/LICENSE.TMTN)。本项目并非 TMTN 官方发行版。

## Binance

Binance Agentic Wallet CLI 由安装脚本从 npm 获取固定版本 `@binance/agentic-wallet@1.12.0`，不随源码分发。

Four Agent ID 辅助脚本来自 [binance/binance-skills-hub](https://github.com/binance/binance-skills-hub/tree/96563daf34fa5a87af5d76c2f1107d697ae7ce07/skills/binance-web3/binance-agentic-wallet)，安装时从该固定提交下载到本地 runtime，并验证 SHA-256：

`15044335adc228286424988495e81f58343e7fe33e2b1f2f3946fe3f5627066a`

该脚本所在目录未发现明确许可证，因此不包含在本项目公开源码中，也不将本项目 MIT 许可证应用于它。请遵循官方使用条款。

## ethers

ethers 6.17.0 及其传递依赖通过 npm 安装；各组件许可证见其 npm 包。本项目不重新分发 node_modules。

GMGN、Binance、TMTN 名称仅用于标识兼容性和来源，不表示官方支持或背书。
