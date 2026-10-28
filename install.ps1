param([string]$NodePath, [string]$BawPath, [string]$FourPath)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$configPath = Join-Path $projectRoot '.local\config.json'
$old = $null
if (Test-Path -LiteralPath $configPath) { $old = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json }
if (!$NodePath) {
  if ($old.nodePath -and (Test-Path -LiteralPath $old.nodePath)) { $NodePath = $old.nodePath }
  else { $NodePath = (Get-Command node -ErrorAction Stop).Source }
}
$nodeVersion = & $NodePath -p 'process.versions.node'
if ([int]($nodeVersion.Split('.')[0]) -lt 24) { throw '请使用 Node.js 24 或以上版本，再运行安装脚本。' }
$npmCli = Join-Path (Split-Path $NodePath) 'node_modules\npm\bin\npm-cli.js'
if (!(Test-Path -LiteralPath $npmCli)) { $npmCli = Join-Path (Split-Path (Split-Path $NodePath)) 'lib\node_modules\npm\bin\npm-cli.js' }
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\ethers\package.json'))) {
  if (!(Test-Path -LiteralPath $npmCli)) { throw '所选 Node 安装缺少 npm，请安装官方 Node.js 24 完整发行版。' }
  Push-Location $projectRoot
  try { & $NodePath --use-env-proxy $npmCli ci --ignore-scripts --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw '路由依赖安装失败' } }
  finally { Pop-Location }
}
if (!$BawPath) {
  $projectCli = Join-Path $projectRoot 'runtime\node_modules\@binance\agentic-wallet\dist\index.js'
  if ($old.bawPath -and (Test-Path -LiteralPath $old.bawPath)) { $BawPath = $old.bawPath }
  elseif (Test-Path -LiteralPath $projectCli) { $BawPath = $projectCli }
  else {
    $npmCli = Join-Path (Split-Path $NodePath) 'node_modules\npm\bin\npm-cli.js'
    if (!(Test-Path -LiteralPath $npmCli)) { $npmCli = Join-Path (Split-Path (Split-Path $NodePath)) 'lib\node_modules\npm\bin\npm-cli.js' }
    if (!(Test-Path -LiteralPath $npmCli)) { throw '未找到 npm，请通过 -BawPath 指定币安 CLI 的 dist/index.js 路径。' }
    & $NodePath --use-env-proxy $npmCli install --prefix (Join-Path $projectRoot 'runtime') '@binance/agentic-wallet@1.12.0' --ignore-scripts --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw '币安 CLI 安装失败' }
    $BawPath = $projectCli
  }
}
if (!$FourPath) {
  if ($old.fourPath -and (Test-Path -LiteralPath $old.fourPath)) { $FourPath = $old.fourPath }
  else {
    $FourPath = Join-Path $projectRoot 'runtime\agent-id-exclusive-token-launches.mjs'
    New-Item -ItemType Directory -Force -Path (Split-Path $FourPath) | Out-Null
    $fourUrl = 'https://raw.githubusercontent.com/binance/binance-skills-hub/96563daf34fa5a87af5d76c2f1107d697ae7ce07/skills/binance-web3/binance-agentic-wallet/scripts/agent-id-exclusive-token-launches.mjs'
    Invoke-WebRequest -Uri $fourUrl -OutFile "$FourPath.download" -UseBasicParsing
    if ((Get-FileHash -LiteralPath "$FourPath.download" -Algorithm SHA256).Hash -ne '15044335ADC228286424988495E81F58343E7FE33E2B1F2F3946FE3F5627066A') { throw 'Four 官方脚本校验失败，安装已停止。' }
    Move-Item -LiteralPath "$FourPath.download" -Destination $FourPath -Force
  }
}
foreach ($required in @($NodePath, $BawPath, $FourPath)) { if (!(Test-Path -LiteralPath $required)) { throw "缺少运行文件：$required" } }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$BawPath = (Resolve-Path -LiteralPath $BawPath).Path
$FourPath = (Resolve-Path -LiteralPath $FourPath).Path
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot '.local') | Out-Null
$extensionId = & $NodePath (Join-Path $projectRoot 'scripts\identity.mjs')
$configPath = Join-Path $projectRoot '.local\config.json'
$cfg = @{ nodePath = $NodePath; bawPath = $BawPath; fourPath = $FourPath; extensionId = $extensionId; maxBuyBnb = '0.1'; gasReserveBnb = '0.00005' }
if (Test-Path -LiteralPath $configPath) {
  $old = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if ($old.maxBuyBnb) { $cfg.maxBuyBnb = $old.maxBuyBnb }
  if ($old.gasReserveBnb) { $cfg.gasReserveBnb = $old.gasReserveBnb }
  if ($old.rpcUrls) { $cfg.rpcUrls = @($old.rpcUrls) }
  if ($old.tradeRpcUrls) { $cfg.tradeRpcUrls = @($old.tradeRpcUrls) }
  if ($old.gangV3Pads) { $cfg.gangV3Pads = @($old.gangV3Pads) }
}
$cfg | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
$launcherPath = Join-Path $projectRoot '.local\native-host.cmd'
$hostPath = Join-Path $projectRoot 'host\native.mjs'
# Native Messaging passes the fixed extension origin as argument 1. No arbitrary command is accepted.
if ($NodePath.Contains('%') -or $hostPath.Contains('%')) { throw '安装路径不能包含百分号，请移动项目后重试。' }
@"
@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
"$NodePath" --use-env-proxy "$hostPath" %1
"@ | ForEach-Object { [System.IO.File]::WriteAllText($launcherPath, ($_ -replace '\r?\n', "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding $false)) }
$manifestPath = Join-Path $projectRoot '.local\com.gmgn.binance_agent.json'
@{ name = 'com.gmgn.binance_agent'; description = 'GMGN Binance Agent Wallet BSC Bridge'; path = $launcherPath; type = 'stdio'; allowed_origins = @("chrome-extension://$extensionId/") } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
foreach ($browserKey in @('Google\Chrome', 'Microsoft\Edge')) {
  $regPath = "HKCU:\Software\$browserKey\NativeMessagingHosts\com.gmgn.binance_agent"
  New-Item -Path $regPath -Force | Out-Null
  Set-Item -LiteralPath $regPath -Value $manifestPath
}
Write-Host '本地钱包助手已注册到 Chrome / Edge（仅当前 Windows 用户）。'
Write-Host "扩展 ID：$extensionId"
Write-Host "在 chrome://extensions 或 edge://extensions 开启开发者模式，加载已解压的扩展：$(Join-Path $projectRoot 'extension')"
Write-Host '然后打开 GMGN 的 BSC 页面。安装不会发起交易或修改钱包风控。'
