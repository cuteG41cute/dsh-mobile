Option Explicit
' 隐藏运行 dsh-mobile-bridge，并做「掉了就拉起来」的监督（计划任务 "DSH Mobile Bridge"
' 与启动项快捷方式都指向这里；wscript 没有窗口，所以全程无控制台）。
'
' 为什么要自己监督：计划任务的 RestartCount 只在任务**失败**时生效，而这里实测
' 进程被强杀后任务结果是 0xFFFFFFFF，任务不会自动重启（State 变 Ready 就完了）。
' 所以由本脚本等 node 结束、按退出码决定是否再拉一次。
'
' 退出码约定：0 = 正常退出（重拉）；2 = 端口被占用（说明已有实例在服务，本实例直接退出，
' 不能死循环重试——登录时启动项和计划任务会同时启动一个，其中一个必然撞端口）。
'
' 坑：不要用 "cmd.exe /c ... >> log" 包一层 —— 本机实测 WSH 的 sh.Run 对带重定向的 cmd
' 命令行静默失败（进程不启动、日志文件也不生成，Err 还是 0）。日志由 bridge.cjs 自己写。
Dim fso, sh, base, node, q, cmd, rc, attempt, delay
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
node = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node.exe"
q = Chr(34)
cmd = q & node & q & " " & q & base & "\bridge.cjs" & q & " --quiet"
sh.CurrentDirectory = base
attempt = 0
Do
  rc = sh.Run(cmd, 0, True)
  If rc = 2 Then WScript.Quit 2
  If rc = 0 Then
    attempt = 0
  Else
    attempt = attempt + 1
  End If
  If attempt >= 4 Then
    delay = 60
  ElseIf attempt = 3 Then
    delay = 30
  ElseIf attempt = 2 Then
    delay = 10
  Else
    delay = 3
  End If
  WScript.Sleep delay * 1000
Loop
