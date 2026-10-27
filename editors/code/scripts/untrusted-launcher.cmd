@echo off
rem Windows cannot run the .ts launcher through its shebang; @vscode/test-electron runs .cmd files through the shell.
node "%~dp0untrusted-launcher.ts" %*
