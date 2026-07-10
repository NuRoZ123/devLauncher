# Lance DevLauncher en mode développement.
# Ajoute MinGW + cargo au PATH au cas où, puis démarre Tauri (vite + app).
$ErrorActionPreference = "Stop"

$mingw = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.MSVCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
if (Test-Path $mingw) { $env:Path = "$mingw;$env:Path" }
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

Push-Location $PSScriptRoot
try {
    npm run tauri dev
} finally {
    Pop-Location
}
