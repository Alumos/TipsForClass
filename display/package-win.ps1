$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $IsWindows -and $env:OS -ne 'Windows_NT') { throw '请在 Windows 10/11 x64 构建并验证安装包。' }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '请安装 .NET 8 SDK。' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw '请安装 Node.js 22.12+ LTS。' }
dotnet publish windows-tts/ClassroomTts.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o windows-tts/bin/publish
if ($LASTEXITCODE -ne 0) { throw 'Windows TTS 编译失败。' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。' }
npm test
if ($LASTEXITCODE -ne 0) { throw '测试失败。' }
npm run package:win
if ($LASTEXITCODE -ne 0) { throw 'Windows 安装包构建失败。' }
Write-Host '试点安装包位于 release/；未配置签名证书时该包未签名。'
