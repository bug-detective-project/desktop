# Removes everything Bug Detective created in Docker: containers, volumes (the player's code
# included), networks and images. Run by the Windows uninstaller (resources/installer.nsh), never on an
# update; it can also be run by hand:
#   powershell -ExecutionPolicy Bypass -File "<install folder>\resources\remove-docker-data.ps1"
# Everything the app creates carries the label bugdetective.role and a name starting with
# "bugdetective-", so nothing else is touched. Every docker call has a time limit: a stuck Docker
# Desktop never blocks the uninstaller, which then leaves the resources in place.

$ErrorActionPreference = 'SilentlyContinue'

$docker = (Get-Command docker.exe -ErrorAction SilentlyContinue).Source
if (-not $docker) {
  $candidate = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
  if (Test-Path $candidate) { $docker = $candidate }
}
if (-not $docker) {
  Write-Output 'Docker was not found: nothing to remove.'
  exit 0
}

# Runs docker with a time limit; returns its output lines, or $null when it failed or did not answer.
function Invoke-Docker([string[]] $Arguments, [int] $TimeoutSeconds = 60) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $docker
  $info.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($info)
  $output = $process.StandardOutput.ReadToEndAsync()
  $null = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    return $null
  }
  if ($process.ExitCode -ne 0) { return $null }
  return @($output.Result -split "`r?`n" | Where-Object { $_ })
}

if ($null -eq (Invoke-Docker @('version', '--format', '{{.Server.Version}}') 20)) {
  Write-Output 'Docker is not running: its Bug Detective data was left in place.'
  exit 0
}

$filter = 'label=bugdetective.role'
foreach ($name in (Invoke-Docker @('container', 'ls', '--all', '--filter', $filter, '--format', '{{.Names}}'))) {
  if ($name -like 'bugdetective-*') { $null = Invoke-Docker @('container', 'rm', '--force', $name) }
}
foreach ($name in (Invoke-Docker @('volume', 'ls', '--filter', $filter, '--format', '{{.Name}}'))) {
  if ($name -like 'bugdetective-*') { $null = Invoke-Docker @('volume', 'rm', '--force', $name) }
}
foreach ($name in (Invoke-Docker @('network', 'ls', '--filter', $filter, '--format', '{{.Name}}'))) {
  if ($name -like 'bugdetective-*') { $null = Invoke-Docker @('network', 'rm', $name) }
}
foreach ($id in (Invoke-Docker @('image', 'ls', '--filter', $filter, '--format', '{{.ID}}') | Sort-Object -Unique)) {
  $null = Invoke-Docker @('image', 'rm', '--force', $id) 120
}
# The app's BuildKit builder (its container and build cache) carries no label: removed by name.
$null = Invoke-Docker @('buildx', 'rm', '--force', 'bugdetective-builder') 120
Write-Output 'Removed the Bug Detective data from Docker.'
exit 0
