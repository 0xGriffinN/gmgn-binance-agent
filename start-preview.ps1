$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.local\config.json') -Raw | ConvertFrom-Json
& $cfg.nodePath --use-env-proxy (Join-Path $PSScriptRoot 'scripts\preview.mjs')
