$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'config\config.json') -Raw | ConvertFrom-Json
$astrbotData = Join-Path $env:USERPROFILE '.astrbot\data'
$target = Join-Path $astrbotData 'plugins\astrbot_plugin_boss_job_assistant'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'astrbot-plugin\main.py') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $root 'astrbot-plugin\metadata.yaml') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $root 'astrbot-plugin\_conf_schema.json') -Destination $target -Force
$pluginConfig = @{ bridge_url = "http://127.0.0.1:$($config.bridge.port)"; bridge_token = $config.bridge.token } | ConvertTo-Json
$pluginConfig | Set-Content -LiteralPath (Join-Path $astrbotData 'config\astrbot_plugin_boss_job_assistant_config.json') -Encoding utf8
Write-Host 'AstrBot plugin installed. Reload the plugin in WebUI or restart AstrBot.'
