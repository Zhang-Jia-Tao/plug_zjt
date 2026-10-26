# sysmon.ps1 - collect system resource metrics, output one JSON object
# metrics: cpu / memory / swap(page file) / disk activity / gpu load / cpu+gpu temps
# polled by host.mjs (default 3s). Total runtime kept under ~1.5s.
# notes from field probing:
#   - Win32_PerfFormattedData_* counters: fast and always available (the core path)
#   - MSAcpi_ThermalZoneTemperature: many boards return access denied / no zone
#     (this machine: unavailable) - cpu temp stays null, panel shows unsupported
#   - GPU: NVIDIA via root/nvidia CIM or nvidia-smi; Intel/AMD via GPUEngine perf
#     counter (this machine: Intel UHD 630, counter available)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$r = [ordered]@{}

# ---- CPU load ----
try {
    $c1 = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name = '_Total'" -ErrorAction Stop
    $r.cpu = [math]::Round([double]$c1.PercentProcessorTime, 1)
} catch { $r.cpu = $null }

# ---- Memory + uptime ----
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $total = [double]$os.TotalVisibleMemorySize      # KB
    $free = [double]$os.FreePhysicalMemory           # KB
    $r.memTotal = [math]::Round($total / 1MB, 2)     # GB
    $r.memUsed = [math]::Round(($total - $free) / 1MB, 2)
    if ($total -gt 0) { $r.mem = [math]::Round(100 * ($total - $free) / $total, 1) }
    $r.uptime = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
} catch { }

# ---- Swap (page file) ----
try {
    $pf = Get-CimInstance Win32_PageFileUsage -ErrorAction Stop | Select-Object -First 1
    if ($pf) {
        $alloc = [double]$pf.AllocatedBaseSize   # MB
        $cur = [double]$pf.CurrentUsage          # MB
        $r.swapTotal = [math]::Round($alloc / 1024, 2)
        $r.swapUsed = [math]::Round($cur / 1024, 2)
        if ($alloc -gt 0) { $r.swap = [math]::Round(100 * $cur / $alloc, 1) }
    }
} catch { }

# ---- Disk activity ----
try {
    $d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name = '_Total'" -ErrorAction Stop
    $r.disk = [math]::Round([double]$d.PercentDiskTime, 1)
    $r.diskRead = [math]::Round([double]$d.DiskReadBytesPerSec / 1MB, 1)
    $r.diskWrite = [math]::Round([double]$d.DiskWriteBytesPerSec / 1MB, 1)
} catch { }

# ---- CPU temp (ACPI thermal zones; often unavailable, leave null) ----
try {
    $zones = Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace 'root/wmi' -ErrorAction Stop
    $temps = @()
    foreach ($z in $zones) {
        $c = [math]::Round([double]$z.CurrentTemperature / 10 - 273.15, 1)
        if ($c -gt 0 -and $c -lt 120) { $temps += $c }
    }
    if ($temps.Count -gt 0) { $r.cpuTemp = [math]::Round(($temps | Measure-Object -Average).Average, 1) }
} catch { }

# ---- GPU: NVIDIA path first, then Intel/AMD engine counter fallback ----
$r.gpu = $null; $r.gpuTemp = $null; $r.vramUsed = $null; $r.vramTotal = $null
try {
    $g = Get-CimInstance -Namespace 'root/nvidia' -ClassName NVGPU -ErrorAction Stop | Select-Object -First 1
    if ($g) {
        if ($null -ne $g.UtilizationGPU) { $r.gpu = [math]::Round([double]$g.UtilizationGPU, 1) }
        if ($null -ne $g.TemperatureGPU) { $r.gpuTemp = [math]::Round([double]$g.TemperatureGPU, 1) }
        if ($null -ne $g.UsedDedicatedMemory) { $r.vramUsed = [math]::Round([double]$g.UsedDedicatedMemory / 1024, 1) }
        if ($null -ne $g.TotalDedicatedMemory) { $r.vramTotal = [math]::Round([double]$g.TotalDedicatedMemory / 1024, 1) }
    }
} catch { }

# nvidia-smi fallback (most reliable when the driver is present)
if ($null -eq $r.gpu -or $null -eq $r.gpuTemp) {
    try {
        $nsm = & nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>$null
        if ($LASTEXITCODE -eq 0 -and $nsm) {
            $p = (($nsm | Select-Object -First 1) -split ',') | ForEach-Object { $_.Trim() }
            if ($null -eq $r.gpu -and $p[0] -match '^\d+(\.\d+)?$') { $r.gpu = [double]$p[0] }
            if ($null -eq $r.gpuTemp -and $p.Count -gt 1 -and $p[1] -match '^\d+$') { $r.gpuTemp = [double]$p[1] }
            if ($p.Count -ge 4) {
                if ($p[2] -match '^\d+$') { $r.vramUsed = [math]::Round([double]$p[2] / 1024, 1) }
                if ($p[3] -match '^\d+$') { $r.vramTotal = [math]::Round([double]$p[3] / 1024, 1) }
            }
        }
    } catch { }
}

# Intel / AMD integrated GPU: engine utilization counter (sum of 3D engines, clamp 0-100)
if ($null -eq $r.gpu) {
    try {
        $eng = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop |
            Where-Object { $_.Name -like '*engtype_3D*' }
        if ($eng) {
            $u = ($eng | Measure-Object -Property UtilizationPercentage -Sum).Sum
            $r.gpu = [math]::Round([math]::Min($u, 100), 1)
        }
    } catch { }
}

$r | ConvertTo-Json -Compress
