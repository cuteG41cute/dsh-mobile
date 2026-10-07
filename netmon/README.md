# dsh-netmon —— 网络 / 隧道监视器（DSH 插件）

会话头部多一个「网络」芯片（和「时间戳」「记忆库」同一排），点开显示：

| 区块 | 内容 |
| --- | --- |
| 接入桥 | 状态、响应时间、上游状态、注入是否生效（面板 / 适配 / 启动清单） |
| 内网入口 | 每个网卡的 `http://<ip>:8099/__bridge`（点一下复制） |
| 外网隧道 | 域名、**真实可达性探测**（宿主侧访问一次 `https://<域名>/__ping`，拿到任何 HTTP 响应即判定为通）、ACME 证书剩余天数 |
| 设备 | 已认证 / 完全信任 / 待审批数量 + 每个设备是否在线 |

探测全部在**宿主侧**完成（页面本身到不了桥的 8099 端口）；结果缓存 8 秒，芯片每 60 秒刷新一次，面板打开时每 15 秒刷新。`/__wan` 返回里的接入口令与二维码载荷**不会被转发到前端**。

## 安装

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\web"
New-Item -ItemType Directory -Force "$profile\node_modules\dsh-netmon\lib" | Out-Null
Copy-Item .\package.json "$profile\node_modules\dsh-netmon\" -Force
Copy-Item .\lib\*.js   "$profile\node_modules\dsh-netmon\lib\" -Force
```

然后在 `$profile\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-netmon
      name: 'dsh-netmon'
```

**重启 harness**（关掉桌面窗口再双击快捷方式）后，打开任意会话即可看到芯片。

## 说明

- 芯片只在**打开会话之后**的头部出现（「新会话」落地页不渲染头部工具区，其他插件芯片同理）；
- 桥没运行时面板照常打开，只是「接入桥」显示掉线——它是诊断工具，自己不会因为桥挂了而坏掉；
- 「隧道可达 = 是（HTTP 403）」是**正确结果**：桥会拒绝匿名的 `/__ping`，能收到 403 恰好说明请求绕出去又回到了桥。
