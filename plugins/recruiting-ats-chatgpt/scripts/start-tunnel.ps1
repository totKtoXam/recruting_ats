param(
  [string]$TunnelClient = 'tunnel-client',
  [string]$TunnelId
)

$ErrorActionPreference = 'Stop'

if (-not [string]::IsNullOrWhiteSpace($TunnelId)) {
  $env:CONTROL_PLANE_TUNNEL_ID = $TunnelId
}
if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_TUNNEL_ID)) {
  throw 'Set CONTROL_PLANE_TUNNEL_ID or pass -TunnelId from OpenAI Platform.'
}
if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
  $secret = Read-Host 'OpenAI tunnel runtime API key' -AsSecureString
  $env:CONTROL_PLANE_API_KEY = ConvertFrom-SecureString $secret -AsPlainText
}
if ([string]::IsNullOrWhiteSpace($env:ATS_MCP_TOKEN)) {
  $secret = Read-Host 'Personal Recruiting ATS MCP token' -AsSecureString
  $env:ATS_MCP_TOKEN = ConvertFrom-SecureString $secret -AsPlainText
}

$tunnel = (Get-Command $TunnelClient -ErrorAction Stop).Source

# HTTP forwarding accepts tool calls without a process-wide stdio handshake.
# The static Authorization header is resolved by tunnel-client only for ATS.
if ([string]::IsNullOrWhiteSpace($env:ATS_MCP_URL)) {
  $env:ATS_MCP_URL = 'https://portal.devexpert.kz/hr-ats/mcp'
}
$env:MCP_SERVER_URL = $env:ATS_MCP_URL
$env:ATS_AUTHORIZATION = 'Bearer ' + $env:ATS_MCP_TOKEN
$env:MCP_EXTRA_HEADERS = 'Authorization: env:ATS_AUTHORIZATION'
Remove-Item Env:MCP_COMMAND -ErrorAction SilentlyContinue

& $tunnel doctor --explain
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $tunnel run
exit $LASTEXITCODE
