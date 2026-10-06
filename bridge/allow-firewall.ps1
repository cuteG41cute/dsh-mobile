# allow-firewall.ps1 -- 让手机能连上 dsh-mobile-bridge（仅限本机所在的局域网网段）
#
# 为什么需要：Windows 防火墙默认阻止外部设备访问本机新开的监听端口。
# 本脚本为桥端口添加一条入站放行规则，并把「远程地址」限制为本机各个网卡所在的
# 局域网网段--即使路由器把端口映射到了公网，外网地址也匹配不上这条规则。
#
# 用法（需要用管理员身份运行 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File allow-firewall.ps1
#   powershell -ExecutionPolicy Bypass -File allow-firewall.ps1 -Port 9000
#   powershell -ExecutionPolicy Bypass -File allow-firewall.ps1 -Wan     # 额外允许公网 IPv6 直连（见下）
# 卸载：
#   powershell -ExecutionPolicy Bypass -File allow-firewall.ps1 -Remove
#
# -Wan 说明：本机有公网 IPv6 时，手机在流量下可以直接连 http://[地址]:端口，速度等于局域网、
# 不经过frp 服务商隧道。但那需要放行「任意远程地址」的入站；桥这一侧的闸门仍然是「接入口令 + 本机认证」
# （公网 IPv6 来源同样必须带口令，见 bridge.cjs 的 needsAccessToken）。
[CmdletBinding()]
param(
    [int]$Port = 8099,
    [switch]$Remove,
    [switch]$Wan
)

$ErrorActionPreference = "Stop"
$ruleName = "DSH Mobile Bridge (TCP $Port)"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "需要管理员权限：请右键「以管理员身份运行」PowerShell 后重试。" -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port"
    exit 1
}

if ($Remove) {
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existing) {
        Remove-NetFirewallRule -DisplayName $ruleName
        Write-Host "已删除防火墙规则：$ruleName" -ForegroundColor Green
    } else {
        Write-Host "未找到规则：$ruleName（无需处理）"
    }
    exit 0
}

# ---- 计算「本机所在局域网网段」作为规则的远程地址范围 ----
function Get-LocalSubnets {
    $subnets = New-Object System.Collections.Generic.List[string]
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
        $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" -and $_.AddressState -ne "Tentative"
    }
    foreach ($entry in $addresses) {
        $prefix = [int]$entry.PrefixLength
        if ($prefix -lt 8 -or $prefix -gt 30) { continue }   # 跳过 /0-/7 这类过宽或点对点 /31 /32
        $bytes = [System.Net.IPAddress]::Parse($entry.IPAddress).GetAddressBytes()
        $mask = New-Object byte[] 4
        for ($i = 0; $i -lt 4; $i++) {
            $bits = [Math]::Min(8, [Math]::Max(0, $prefix - $i * 8))
            $mask[$i] = [byte]((0xFF -shl (8 - $bits)) -band 0xFF)
            if ($bits -le 0) { $mask[$i] = 0 }
        }
        $network = New-Object byte[] 4
        for ($i = 0; $i -lt 4; $i++) { $network[$i] = [byte]($bytes[$i] -band $mask[$i]) }
        $subnets.Add(([System.Net.IPAddress]::new($network).ToString() + "/" + $prefix))
    }
    return ($subnets | Sort-Object -Unique)
}

$subnets = Get-LocalSubnets
if (-not $subnets -or $subnets.Count -eq 0) {
    Write-Host "没能识别出任何局域网网段（是否未联网？）。改用较宽的规则：允许所有远程地址，但仅限「专用网络」配置文件。" -ForegroundColor Yellow
    $subnets = @()
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Remove-NetFirewallRule -DisplayName $ruleName
    Write-Host "已存在同名规则，先移除再重建（保证参数最新）。"
}

$params = @{
    DisplayName = $ruleName
    Description = "DeepSeek Harness 手机接入桥：允许局域网设备访问 TCP $Port（dsh-mobile-bridge）"
    Direction = "Inbound"
    Action = "Allow"
    Protocol = "TCP"
    LocalPort = $Port
    Profile = "Any"
    Enabled = "True"
}
if ($Wan) {
    $params["RemoteAddress"] = "Any"      # 公网 IPv6 直连：来源不在本机网段，必须放开远程地址
    $params["Profile"] = "Any"
} elseif ($subnets.Count -gt 0) {
    $params["RemoteAddress"] = $subnets; $params["Profile"] = "Any"
} else {
    $params["Profile"] = "Private"
}
New-NetFirewallRule @params | Out-Null

Write-Host "[OK] 已放行入站 TCP $Port" -ForegroundColor Green
if ($Wan) {
    Write-Host "  远程地址：任意（含公网 IPv6）-- 桥仍要求接入口令 + 本机认证，公网来源一样要口令。" -ForegroundColor Yellow
} elseif ($subnets.Count -gt 0) {
    Write-Host ("  远程地址仅限本机所在网段：" + ($subnets -join ", "))
} else {
    Write-Host "  远程地址：任意（但仅「专用网络」配置文件生效）"
}
Write-Host ""
Write-Host "提示：第一次让 bridge.cjs 监听 0.0.0.0 时，Windows 可能还会弹出「防火墙已阻止部分功能」对话框--"
Write-Host "      请勾选「专用网络」后点「允许访问」，否则手机仍然连不上。"
