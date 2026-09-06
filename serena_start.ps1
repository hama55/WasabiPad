$serenaPython = Join-Path $env:APPDATA 'uv\tools\serena-agent\Scripts\python.exe'
& $serenaPython -c "from serena.cli import top_level; top_level()" start-mcp-server --transport streamable-http --port 9121 --project $PSScriptRoot --context=codex --open-web-dashboard false
exit $LASTEXITCODE
