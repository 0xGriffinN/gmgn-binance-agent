$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot
$fixture = Join-Path $env:TEMP ('gmgn-install-安装验证-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'install.ps1') -Destination $fixture
foreach ($dir in @('scripts','extension','host')) { Copy-Item -LiteralPath (Join-Path $source $dir) -Destination $fixture -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $fixture 'node_modules\ethers') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $fixture 'node_modules\ethers\package.json') -Value '{}'
Set-Content -LiteralPath (Join-Path $fixture 'fake-cli.mjs') -Value 'console.log(JSON.stringify(process.argv.slice(2)))'
# Intercept registration: this fixture never changes Chrome/Edge registry keys.
function New-Item {
  param($Path,$ItemType,[switch]$Force)
  if ($Path -like 'HKCU:*') { return }
  Microsoft.PowerShell.Management\New-Item -Path $Path -ItemType $ItemType -Force:$Force
}
function Set-Item {
  param($LiteralPath,$Value)
  if ($LiteralPath -notlike 'HKCU:*') { throw 'Unexpected Set-Item target' }
}
$node = (Get-Command node -ErrorAction Stop).Source
& (Join-Path $fixture 'install.ps1') -NodePath $node -BawPath (Join-Path $fixture 'fake-cli.mjs') -FourPath (Join-Path $fixture 'fake-cli.mjs')
$launcher = Join-Path $fixture '.local\native-host.cmd'
# Replace only the isolated fixture entry point; keep the generated launcher intact.
# TEMP can use an 8.3 path while PSScriptRoot expands it on GitHub Windows runners.
[IO.File]::WriteAllText((Join-Path $fixture 'host\native.mjs'),'console.log(JSON.stringify(process.argv.slice(2)))',[Text.UTF8Encoding]::new($false))
$result = & $launcher 'chrome-extension://fixture/'
if ($LASTEXITCODE -ne 0 -or ($result | ConvertFrom-Json)[0] -ne 'chrome-extension://fixture/') { throw 'Unicode launcher failed' }
Write-Output 'PASS: isolated install and Unicode launcher; registry writes intercepted'
