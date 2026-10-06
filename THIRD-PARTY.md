# 第三方组件与许可

本项目**自己的代码**（接入桥、手机端面板、移动端适配注入、安卓 App、脚本与文档）以 MIT 许可发布，见 `LICENSE`。
除此之外，仓库里包含/分发以下第三方组件，各自的许可如下。

## 1. ZXing core（`app/libs/core-3.5.3.jar`）

| 项 | 内容 |
| --- | --- |
| 组件 | ZXing ("Zebra Crossing") core |
| 版本 | 3.5.3（`com.google.zxing:core:3.5.3`） |
| 用途 | 安卓 App 里解析二维码（扫码连接、从相册图片识别） |
| 许可 | **Apache License 2.0** |
| 修改 | 未修改，原样以 jar 形式引入 |
| 许可全文 | [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt) |
| 上游 | https://github.com/zxing/zxing |

按 Apache-2.0 第 4 条：本仓库**附带许可全文**（`licenses/Apache-2.0.txt`）、保留原始版权与声明（jar 内的 `META-INF`），且未修改其源码。

## 2. qrcode-generator（`bridge/vendor/qrcode-generator.js`）

| 项 | 内容 |
| --- | --- |
| 组件 | QR Code Generator for JavaScript |
| 作者 | Copyright (c) 2009 Kazuhiko Arase |
| 用途 | 桥生成二维码 PNG（不依赖任何 npm 包） |
| 许可 | **MIT**（版权与许可声明保留在文件头部） |
| 修改 | 未修改，原样 vendored |
| 上游 | http://www.d-project.com/ |

## 3. DeepSeek Harness（不随本仓库分发）

本项目的运行前提是用户自己安装 **DeepSeek Harness**（`@deepseek-ai/dsh`，npm 包，**MIT 许可**）。
我们**不复制、不重新分发**它：桥只是在运行时反向代理它的 HTTP 服务，并向页面注入我们自己的脚本。
因此这里没有它的代码，也没有额外的分发义务。

## 4. 名称与图标（非许可问题，但需要知道）

- 应用名里的 “DeepSeek / DeepSeek Harness” 与仓库里使用的鲸鱼图标，属于**品牌标识**；
- 本仓库是**第三方客户端工具**，与 DeepSeek 官方无隶属关系；如果你是二次分发者，请自行评估商标使用与改名。

## 5. 体积占比（谁是谁的代码）

| 部分 | 体积 |
| --- | --- |
| 本项目自己的代码/文档 | ~954 KB |
| ZXing jar（第三方） | 593 KB |
| qrcode-generator（第三方） | 55 KB |
| 安卓 App 构建产物（含 ZXing 编译后的类） | 342 KB |

也就是说：**源码层面只有两个第三方文件**（一个 593KB 的扫码库 jar、一个 55KB 的二维码生成器），其余全部是本项目自己的实现。
