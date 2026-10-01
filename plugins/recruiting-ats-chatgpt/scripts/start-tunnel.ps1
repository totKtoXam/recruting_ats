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

$bridge = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'ats-mcp-stdio.mjs')).Path
$node = (Get-Command node -ErrorAction Stop).Source
$tunnel = (Get-Command $TunnelClient -ErrorAction Stop).Source

# The stdio target performs no OAuth discovery. The ATS token remains local
# and is sent only to the existing ATS MCP URL in Authorization.
$nodeArg = $node.Replace('\', '/')
$bridgeArg = $bridge.Replace('\', '/')
$env:MCP_COMMAND = '"' + $nodeArg + '" "' + $bridgeArg + '"'

& $tunnel doctor --explain
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $tunnel run
exit $LASTEXITCODE
