# dialogs.ps1 — 枚举白名单进程的模态弹窗（UIA）
# 输出 JSON 数组：[{ hwnd, process, title, buttons:[{id,label}] }]
# 只看 #32770（标准 Windows 对话框）且属主进程在白名单内——不做全局监听。

# stdout 统一 UTF-8：powershell 5.1 默认按控制台 OEM 码页（中文系统 cp936）输出，
# 不设这个中文标题/按钮会变乱码，扩展侧传回的 buttonId 也将永远匹配失败
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$whitelist = @('claude', 'lms', 'ollama', 'lm-studio', 'chatgpt', 'cursor')

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$result = @()
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
foreach ($dlg in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    try {
        # 取属主进程名
        $procName = ''
        try {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($dlg.Current.ProcessId)" -ErrorAction Stop
            $procName = $proc.Name -replace '\.exe$',''
        } catch { continue }

        if ($whitelist -notcontains $procName.ToLower()) { continue }

        $title = $dlg.Current.Name
        # 枚举对话框里的按钮（两轮：直接子级 + 下一层容器）
        $btnCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button)
        $buttons = @()
        foreach ($btn in $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
            try {
                $label = $btn.Current.Name
                if ([string]::IsNullOrWhiteSpace($label)) { continue }
                # 按钮 id 用 Name（label）作为稳定标识，点击脚本按 id 匹配
                $buttons += [ordered]@{ id = $label; label = $label }
            } catch {}
        }
        $result += [ordered]@{
            hwnd    = [int64]$dlg.Current.NativeWindowHandle
            process = $procName
            title   = $title
            buttons = $buttons
        }
    } catch {}
}

if ($result.Count -eq 0) {
    Write-Output '[]'
} else {
    $result | ConvertTo-Json -Compress -Depth 4
}
