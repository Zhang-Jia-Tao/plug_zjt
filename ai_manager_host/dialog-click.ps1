# dialog-click.ps1 — 遥控点击白名单进程模态弹窗上的指定按钮（UIA Invoke）
# 参数：-Hwnd 对话框句柄  -ButtonId 按钮 label（由 dialogs.ps1 枚举得到）
# 仅供 host.mjs 在收到扩展「dialog:respond」消息后调用；只对已知弹窗 hwnd 生效。

param(
    [Parameter(Mandatory = $true)][Int64]$Hwnd,
    [Parameter(Mandatory = $true)][string]$ButtonId
)

# 输入参数经 Node spawn 传入已是正确编码；此行保证万一有输出也不乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$whitelist = @('claude', 'lms', 'ollama', 'lm-studio', 'chatgpt', 'cursor')

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
foreach ($dlg in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    if ([int64]$dlg.Current.NativeWindowHandle -ne $Hwnd) { continue }

    # 白名单校验：句柄匹配还不够，进程必须仍然在白名单内
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($dlg.Current.ProcessId)" -ErrorAction Stop
        if ($whitelist -notcontains ($proc.Name -replace '\.exe$','').ToLower()) { exit 3 }
    } catch { exit 4 }

    $btnCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    foreach ($btn in $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
        if ($btn.Current.Name -ne $ButtonId) { continue }
        $invoke = $null
        if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
            $invoke.Invoke()
            exit 0
        }
        # Invoke 不可用时尝试 SelectionItem（单选按钮场景兜底）
        $sel = $null
        if ($btn.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
            $sel.Select()
            exit 0
        }
        exit 5
    }
    exit 2  # 没找到指定按钮
}
exit 1      # 没找到指定句柄的弹窗
