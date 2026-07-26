param(
    [string]$SillyTavernPath = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-SillyTavernRoot {
    param([string]$RequestedPath)

    if ($RequestedPath) {
        return (Resolve-Path -LiteralPath $RequestedPath).Path
    }

    $HomeCandidate = Join-Path $HOME "SillyTavern"
    if (Test-Path -LiteralPath (Join-Path $HomeCandidate "server.js")) {
        return (Resolve-Path -LiteralPath $HomeCandidate).Path
    }

    $Candidate = Get-Item -LiteralPath $ScriptDir
    while ($null -ne $Candidate) {
        if (Test-Path -LiteralPath (Join-Path $Candidate.FullName "server.js")) {
            return $Candidate.FullName
        }
        $Candidate = $Candidate.Parent
    }

    throw "SillyTavern 폴더를 찾지 못했습니다. -SillyTavernPath 옵션으로 경로를 지정하세요."
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $Encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $Encoding)
}

$StRoot = Find-SillyTavernRoot $SillyTavernPath
$Source = Join-Path $ScriptDir "server"
$PluginsDir = Join-Path $StRoot "plugins"
$Target = Join-Path $PluginsDir "chatlog"
$Config = Join-Path $StRoot "config.yaml"
$TimeStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$RandomSuffix = Get-Random -Minimum 1000 -Maximum 9999
$Stamp = "$TimeStamp-$RandomSuffix"
$PluginBackup = Join-Path $PluginsDir "chatlog-backup-$Stamp"
$ConfigBackup = Join-Path $StRoot "config.yaml.chatlog-backup-$Stamp"

if (-not (Test-Path -LiteralPath (Join-Path $StRoot "server.js"))) {
    throw "선택한 폴더는 SillyTavern 폴더가 아닙니다: $StRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $Source "index.js"))) {
    throw "챗로그 server/index.js를 찾지 못했습니다: $Source"
}
if (-not (Test-Path -LiteralPath $Config)) {
    throw "config.yaml이 없습니다. SillyTavern을 한 번 실행한 뒤 다시 시도하세요."
}

Write-Host ""
Write-Host "챗로그 자동 게시 기능은 SillyTavern 서버 플러그인을 사용합니다."
Write-Host "서버 플러그인은 일반 확장보다 권한이 크므로 신뢰하는 플러그인만 설치해야 합니다."
Write-Host "기존 챗로그 데이터와 설정은 보존하고, 기존 서버 폴더는 백업합니다."
Write-Host ""
Write-Host "중요: 먼저 실행 중인 SillyTavern 창을 완전히 종료하세요."
Write-Host "SillyTavern 위치: $StRoot"
$Answer = Read-Host "계속할까요? [y/N]"
if ($Answer -notmatch "^(y|yes)$") {
    Write-Host "설치를 취소했습니다."
    exit 0
}

New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null

if (Test-Path -LiteralPath $Target) {
    $TargetItem = Get-Item -LiteralPath $Target -Force
    $IsLink = ($TargetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0

    if ($IsLink) {
        Move-Item -LiteralPath $Target -Destination $PluginBackup
        try {
            New-Item -ItemType Junction -Path $Target -Target $Source | Out-Null
        }
        catch {
            if (Test-Path -LiteralPath $Target) {
                [System.IO.Directory]::Delete($Target)
            }
            Move-Item -LiteralPath $PluginBackup -Destination $Target
            throw "Junction 갱신에 실패해 기존 연결을 복구했습니다. $($_.Exception.Message)"
        }
        Write-Host "기존 바로가기를 백업하고 새 챗로그 서버 폴더로 연결했습니다: $PluginBackup"
    }
    else {
        foreach ($RuntimeFile in @("data.json", "settings.json")) {
            $OldRuntime = Join-Path $Target $RuntimeFile
            if (Test-Path -LiteralPath $OldRuntime) {
                Copy-Item -LiteralPath $OldRuntime -Destination (Join-Path $Source $RuntimeFile) -Force
            }
        }
        Move-Item -LiteralPath $Target -Destination $PluginBackup
        try {
            New-Item -ItemType Junction -Path $Target -Target $Source | Out-Null
        }
        catch {
            Move-Item -LiteralPath $PluginBackup -Destination $Target
            throw "Junction 생성에 실패해 기존 폴더를 복구했습니다. PowerShell을 관리자 권한으로 다시 실행해 보세요. $($_.Exception.Message)"
        }
        Write-Host "기존 서버 폴더를 백업했습니다: $PluginBackup"
    }
}
else {
    try {
        New-Item -ItemType Junction -Path $Target -Target $Source | Out-Null
    }
    catch {
        throw "Junction 생성에 실패했습니다. 기존 파일은 변경하지 않았습니다. PowerShell을 관리자 권한으로 다시 실행해 보세요. $($_.Exception.Message)"
    }
    Write-Host "챗로그 서버 Junction을 만들었습니다."
}

Copy-Item -LiteralPath $Config -Destination $ConfigBackup -Force
$ConfigText = [System.IO.File]::ReadAllText($Config)
if ($ConfigText -match "(?m)^\s*enableServerPlugins:") {
    $ConfigText = [regex]::Replace(
        $ConfigText,
        "(?m)^(\s*)enableServerPlugins:\s*.*$",
        '${1}enableServerPlugins: true'
    )
}
else {
    $ConfigText = $ConfigText.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + "enableServerPlugins: true" + [Environment]::NewLine
}
Write-Utf8NoBom -Path $Config -Content $ConfigText

& node --check (Join-Path $Source "index.js")
if ($LASTEXITCODE -ne 0) { throw "server/index.js 문법 검사에 실패했습니다." }
& node --check (Join-Path $Source "ai.js")
if ($LASTEXITCODE -ne 0) { throw "server/ai.js 문법 검사에 실패했습니다." }

Write-Host ""
Write-Host "설치가 완료되었습니다."
Write-Host "config.yaml 백업: $ConfigBackup"
Write-Host "이제 SillyTavern을 완전히 종료한 뒤 다시 실행하세요."
