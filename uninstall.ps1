$ErrorActionPreference = 'Stop'
foreach ($browserKey in @('Google\Chrome', 'Microsoft\Edge')) {
  $regPath = "HKCU:\Software\$browserKey\NativeMessagingHosts\com.gmgn.binance_agent"
  if (Test-Path -LiteralPath $regPath) {
    $registered = (Get-Item -LiteralPath $regPath).GetValue('')
    $expected = Join-Path $PSScriptRoot '.local\com.gmgn.binance_agent.json'
    if ($registered -eq $expected) { Remove-Item -LiteralPath $regPath }
  }
}
Write-Host '已解除本项目的钱包助手注册。请在浏览器扩展管理中移除扩展；订单记录与钱包登录均保留。'
