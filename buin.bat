@echo off
cd /d "%~dp0"
if not exist "node_modules\.bin\tsc.cmd" (
    echo === Installing npm dependencies ===
    call npm ci
    if errorlevel 1 (
        echo Dependency installation failed. Aborting.
        exit /b 1
    )
)
where vsce >nul 2>nul
if errorlevel 1 (
    echo VS Code Extension CLI "vsce" was not found on PATH.
    echo Install it with: npm install --global @vscode/vsce
    exit /b 1
)
for /f "delims=" %%f in ('node -p "require('./package.json').name + '-' + require('./package.json').version + '.vsix'"') do set "VSIX=%%f"
if not defined VSIX (
    echo Could not read the extension name/version from package.json. Aborting.
    exit /b 1
)
echo === Building %VSIX% (prepublish runs precompile + compile) ===
call vsce package --allow-missing-repository
if errorlevel 1 (
    echo VSIX build failed. Aborting.
    exit /b 1
)
echo === Installing %VSIX% ===
code --install-extension "%VSIX%" --force
if errorlevel 1 (
    echo Failed to install: %VSIX%
    exit /b 1
)
echo Installed: %VSIX%
echo === Done! Reload VS Code window (Ctrl+Shift+P ^> Developer: Reload Window) ===
