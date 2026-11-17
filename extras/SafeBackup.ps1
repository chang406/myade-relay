<#
.SYNOPSIS
    현재 터미널이 위치한 폴더를 민감 파일/폴더를 제외하고 압축해 바탕화면에 저장합니다.
.DESCRIPTION
    - 고정 블랙리스트 + 현재 폴더의 .gitignore(있는 경우)를 함께 사용해 제외 대상을 판단합니다.
    - 폴더/파일명은 "완전 일치" 기준으로 비교하므로 .git 은 제외되지만 .gitignore, .github 는
      제외되지 않습니다. (부분 문자열 매칭이 아님)
    - .env* 파일은 기본적으로 제외하되, .env.example / .env.sample / .env.template 처럼
      비밀값이 없는 안전한 템플릿 파일은 예외로 남깁니다.
    - Get-ChildItem -Recurse 결과를 Compress-Archive에 바로 파이프하지 않고, 임시 폴더에
      폴더 구조를 보존한 채로 복사한 뒤 압축합니다. (동일 파일명 충돌로 인한 압축 실패 방지)
    - 압축 전 제외 목록을 미리 보여주고, 실패 시 명확한 오류 메시지를 출력합니다.
.NOTES
    실행이 막힌다면 PowerShell에서 한 번만 실행:
      Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
    이 파일을 PATH에 등록된 Scripts 폴더에 두면 어느 프로젝트 폴더에서든
      Safe-Backup.ps1
    로 바로 실행할 수 있습니다.

    ※ .gitignore 파싱은 간이 구현입니다. '!'로 시작하는 부정 패턴이나 '**' 같은
      고급 gitignore 문법은 완전히 지원하지 않습니다. 중요한 프로젝트라면 압축 후
      아래 출력되는 "제외 목록"을 반드시 눈으로 한 번 확인하세요.
#>

# ── 1. 기본 경로 설정 ─────────────────────────────────────────────
$currentPath    = (Get-Location).Path
$folderName     = (Get-Item $currentPath).Name
$desktopPath    = [Environment]::GetFolderPath("Desktop")
$destinationZip = Join-Path $desktopPath "$folderName`_clean.zip"
$stagingPath    = Join-Path $env:TEMP "safebackup_$([guid]::NewGuid())"

# ── 2. 고정 블랙리스트 (폴더명 / 파일명은 "완전 일치" 기준) ───────────
$excludeDirNames = @(
    '.git', 'node_modules', '.vscode', '.idea', '__pycache__',
    'venv', '.venv', 'dist', 'build'
)
$excludeFileNames = @(
    'Thumbs.db', 'desktop.ini', '.DS_Store'
)
# 파일명 와일드카드 패턴 (부분 문자열 매칭 허용 - 로그 회전 파일 등도 잡기 위함)
$excludeFilePatterns = @(
    '*.log*', '*.pem', '*.key', '*.pfx', '*.crt',
    'id_rsa', 'id_rsa.pub', '.npmrc', '.pypirc', '.netrc'
)
# .env 계열은 별도 규칙: 기본 제외하되 안전한 템플릿 접미사는 허용
$safeEnvSuffixes = @('.example', '.sample', '.template')

# ── 3. .gitignore 흡수 (있는 경우) ────────────────────────────────
$gitignorePath = Join-Path $currentPath ".gitignore"
$gitignorePatterns = @()
if (Test-Path $gitignorePath) {
    $gitignorePatterns = Get-Content $gitignorePath |
        Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') -and -not $_.Trim().StartsWith('!') } |
        ForEach-Object { $_.Trim().Trim('/') }
    Write-Host "  .gitignore에서 $($gitignorePatterns.Count)개 패턴을 추가로 불러왔습니다." -ForegroundColor DarkGray
}

# ── 4. 제외 여부 판단 함수 ─────────────────────────────────────────
function Test-ShouldExclude {
    param($Item, $RootPath)

    $relativePath = $Item.FullName.Substring($RootPath.Length).TrimStart('\')
    $segments     = $relativePath -split '\\'
    $name         = $Item.Name

    # 4-1. 경로상의 어떤 폴더 세그먼트든 블랙리스트와 완전 일치하면 제외
    #      (안전 템플릿이라도 node_modules 등 제외 폴더 안에 있으면 여전히 제외)
    foreach ($seg in $segments) {
        if ($excludeDirNames -contains $seg) { return $true }
    }

    # 4-2. 안전한 .env 템플릿 파일은 최우선 예외 처리.
    #      아래 4-5(.gitignore 매칭)가 부분 문자열 방식이라 '.env.example'도
    #      '.env' 패턴에 다시 걸릴 수 있으므로, 여기서 확정되면 이후 규칙을
    #      전혀 거치지 않고 즉시 포함 처리한다.
    if (-not $Item.PSIsContainer -and $name -like '.env*') {
        foreach ($suffix in $safeEnvSuffixes) {
            if ($name -like "*$suffix") { return $false }
        }
    }

    # 4-3. 파일명 완전 일치
    if (-not $Item.PSIsContainer -and ($excludeFileNames -contains $name)) { return $true }

    # 4-4. 파일명 와일드카드 패턴
    foreach ($pattern in $excludeFilePatterns) {
        if ($name -like $pattern) { return $true }
    }

    # 4-5. .env* 규칙 (템플릿이 아닌 나머지 .env 계열은 여기서 제외)
    if ($name -like '.env*') { return $true }

    # 4-6. .gitignore 패턴 (간이 매칭)
    foreach ($pattern in $gitignorePatterns) {
        if ($name -like $pattern -or $relativePath -like "*$pattern*") { return $true }
    }

    return $false
}

# ── 5. 대상 스캔 및 필터링 (-Force로 숨김/시스템 속성 파일도 빠짐없이 검사) ──
Write-Host "`n[$folderName] 폴더를 검사하는 중..." -ForegroundColor Cyan
$allItems = Get-ChildItem -Path $currentPath -Recurse -Force -ErrorAction SilentlyContinue

$excluded = @()
$included = @()
foreach ($item in $allItems) {
    if (Test-ShouldExclude -Item $item -RootPath $currentPath) {
        $excluded += $item
    } elseif (-not $item.PSIsContainer) {
        $included += $item
    }
}

# ── 6. 제외 목록 미리 보여주기 (검증용) ────────────────────────────
if ($excluded.Count -gt 0) {
    Write-Host "`n다음 $($excluded.Count)개 항목이 제외됩니다:" -ForegroundColor Yellow
    $excluded | Select-Object -First 20 | ForEach-Object {
        Write-Host "  - $($_.FullName.Substring($currentPath.Length))" -ForegroundColor DarkYellow
    }
    if ($excluded.Count -gt 20) {
        Write-Host "  ... 외 $($excluded.Count - 20)개" -ForegroundColor DarkYellow
    }
} else {
    Write-Host "제외 대상이 발견되지 않았습니다." -ForegroundColor Yellow
}

if ($included.Count -eq 0) {
    Write-Host "`n압축할 파일이 없습니다. 작업을 중단합니다." -ForegroundColor Red
    return
}

# ── 7. 폴더 구조를 보존해 임시 폴더로 복사 후 압축 ─────────────────
try {
    New-Item -ItemType Directory -Path $stagingPath -Force -ErrorAction Stop | Out-Null

    foreach ($file in $included) {
        $relative   = $file.FullName.Substring($currentPath.Length).TrimStart('\')
        $targetPath = Join-Path $stagingPath $relative
        $targetDir  = Split-Path $targetPath -Parent
        if (-not (Test-Path $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force -ErrorAction Stop | Out-Null
        }
        Copy-Item -Path $file.FullName -Destination $targetPath -Force -ErrorAction Stop
    }

    if (Test-Path $destinationZip) { Remove-Item $destinationZip -Force }
    Compress-Archive -Path "$stagingPath\*" -DestinationPath $destinationZip -Force -ErrorAction Stop

    Write-Host "`n백업 완료! 바탕화면에 [$folderName`_clean.zip] 파일이 생성되었습니다." -ForegroundColor Green
    Write-Host "  포함: $($included.Count)개 파일 / 제외: $($excluded.Count)개 항목" -ForegroundColor Green
}
catch {
    Write-Host "`n압축 중 오류가 발생했습니다: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    if (Test-Path $stagingPath) {
        Remove-Item $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}