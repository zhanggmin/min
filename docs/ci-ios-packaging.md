# iOS IPA 打包指南

Workflow 文件：[`.github/workflows/ios.yml`](../.github/workflows/ios.yml)
（架构与技术原理见 [ci-packaging-overview.md](ci-packaging-overview.md)）

---

## 一、流程总览

```
Checkout → JDK 17 → 克隆 Arc(archash) → 下载 MetalANGLEKit → 下载 libarc.a
→ 导入签名证书(可选) → 构建 IPA → 上传 artifact
```

运行环境 `macos-latest`（RoboVM 链接依赖 Xcode 的 clang 工具链），超时 120 分钟。

---

## 二、secrets 配置（可选）

未配置时产出**未签名 IPA**（不能直接安装，见第六节）。配置后产出签名包。

| Secret 名称 | 内容 | 示例 |
|--------------|------|------|
| `IOS_CERTIFICATE_B64` | 分发证书 .p12 的 base64 | — |
| `IOS_CERTIFICATE_PASSWORD` | 导出 .p12 时设置的密码 | — |
| `IOS_PROVISIONING_PROFILE_B64` | 描述文件 .mobileprovision 的 base64 | — |
| `IOS_SIGN_IDENTITY` | 证书名称 | `Apple Distribution: Company Name (TEAMID)` |
| `IOS_PROVISIONING_PROFILE` | 描述文件 UUID | `xxxxxxx-xxxx-...` |

生成 base64：

```bash
# macOS
base64 -i cert.p12 > cert.b64
base64 -i profile.mobileprovision > profile.b64
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.p12")) > cert.b64
```

证书在"钥匙串访问"中导出（选 Apple Distribution 证书，连私钥一起，格式 .p12）；
描述文件在 developer.apple.com 下载；UUID 可用
`security cms -D -i profile.mobileprovision` 查看 `UUID` 字段。

最小可用配置是 `IOS_CERTIFICATE_B64` + `IOS_CERTIFICATE_PASSWORD` + `IOS_SIGN_IDENTITY`
（证书），描述文件缺失时 RoboVM 会尝试自动匹配 keychain 中已安装的 profile。

---

## 三、步骤解析

### 1. 克隆 Arc（localArc 依赖模式）

与 Android 相同：克隆到 `../Arc` 并 checkout 到 `gradle.properties` 的 `archash`，
`settings.gradle` 会 `includeBuild` 切换到本地源码依赖。

### 2. 下载 MetalANGLEKit 框架

```bash
cd ../Arc
./gradlew :backends:backend-robovm:extractMetalANGLEKit --no-daemon
```

**背景**：新版 iOS 已弃用 OpenGL ES，Arc 用 MetalANGLEKit（libgdx 维护的
OpenGL ES → Metal 翻译层）渲染。该框架不在 Arc git 仓库中，由
`backend-robovm/build.gradle` 定义的 `extractMetalANGLEKit` 任务从
libgdx/MetalANGLEKit 官方 release（v1.2.1，带 SHA-256 校验）下载并解压到
`res/META-INF/robovm/ios/libs/`，随 jar 参与链接。

该任务**没有挂在常规构建链上**，不显式触发就会在链接阶段报
`ld: framework 'MetalANGLEKit' not found`。

### 3. 下载 libarc.a（上游遗留 bug 的本地修复）

```bash
mkdir -p ios/libs
curl -fsSL -o ios/libs/libarc.a \
  https://raw.githubusercontent.com/Anuken/Arc/ad320d6da348caa182d1638c640cf9fd4784591e/natives/natives-ios/libs/libarc.a
```

**背景**（上游 bug，至今存在于官方 master）：

- 2025-11-06 Arc 提交 `f8713450`（"iOS natives are no longer needed"）删除了
  `natives/natives-ios/`（含 `libarc.a`，Arc 原生 C 代码的 iOS 静态库）
- 但 `backend-robovm` 的 Java 代码仍引用其中的原生符号（stb_vorbis 解码等），
  Android 侧对应的 `libarc.so` 也一直在正常打包
- 同日 Mindustry 把 `ios/robovm.xml` 的 `<lib>libs/libarc.a</lib>` 改成了
  `<framework>arc</framework>`，但**没有任何地方提供 arc.framework**
- 官方 CI 因此必然报 `ld: framework 'arc' not found`；Anuken 本地有删除前遗留的
  `ios/libs/libarc.a`（该目录在 .gitignore 中）所以没发现

**本地仓库的修复**（两处配合）：

1. `ios/robovm.xml`：删掉 `<framework>arc</framework>`，恢复 `<lib>libs/libarc.a</lib>`
2. CI 从删除前最后一个提交 `ad320d6d`（`f8713450` 的 parent）下载该静态库到 `ios/libs/`

> 若日后更新 `archash` 到修复了该问题的版本，此步骤和 robovm.xml 的改动可以还原。

### 4. 导入签名证书（配置了 secrets 时）

- 创建临时 keychain 并设为默认（避免污染系统钥匙串）
- `security import` 导入 .p12，授权 `/usr/bin/codesign` 使用
- `set-key-partition-list` 允许非交互式签名（CI 无弹窗环境必需）
- 描述文件解压到 `~/Library/MobileDevice/Provisioning Profiles/build.mobileprovision`

未配置 secrets 时打印 notice 并 `exit 0` 跳过（不是失败）。

### 5. 构建 IPA

```bash
# 有完整签名信息
./gradlew ios:createIPA -PsignIdentity="$SIGN_IDENTITY" -PprovisioningProfile="$PROVISIONING_PROFILE"
# 无任何签名信息
./gradlew ios:createIPA
```

`ios/build.gradle` 中的本地修改：

```groovy
//未提供签名参数时跳过签名（用于 CI 无证书构建，产出未签名 IPA）
iosSkipSigning = !project.hasProperty("signIdentity")
```

官方仓库此处是 `iosSkipSigning = false`（强制签名，无证书直接失败）。

构建链：`createIPA` 依赖 `build`（RoboVM AOT 编译 + clang 链接）、`copyNatives`
（从 `../Arc/natives/natives-freetype-ios/libs` 复制 `libarc-freetype.a`）、
`:tools:pack`（精灵图）、`:core:preGen`（版本号/本地化生成）。

### 6. 上传 artifact

产物路径：`ios/build/**/*.ipa`，artifact 名 `Mindustry-ios`。

---

## 四、产物位置

| 场景 | 位置 |
|------|------|
| CI | Actions 运行页 → Artifacts → `Mindustry-ios`（zip 解压得 IPA） |
| 本地 | `ios/build/robovm/IOSLauncher.ipa`（RoboVM 输出目录） |

---

## 五、构建链版本对应关系

| 组件 | 版本/来源 | 说明 |
|------|-----------|------|
| Arc | `gradle.properties` 的 `archash=889dd8880f` | 本地源码依赖（`../Arc`） |
| libarc.a | Arc 提交 `ad320d6d`（删除前的最后版本） | 6.2MB，历史提交下载 |
| MetalANGLEKit | libgdx/MetalANGLEKit release v1.2.1 | `extractMetalANGLEKit` 任务下载，SHA-256 校验 |
| RoboVM | `com.mobidevelop.robovm:robovm-gradle-plugin:2.3.26` | AOT 编译器 |

---

## 六、未签名 IPA 的使用

CI 未配置签名 secrets 时产出未签名 IPA，安装前需自行签名：

| 方式 | 说明 |
|------|------|
| Sideloadly / 爱思助手 | 用个人 Apple ID 自签，7 天有效期，免费 |
| AltStore | 自动续签，需定期连电脑 |
| 开发者证书 + codesign | `codesign -f -s "证书名" Payload/*.app` 后重新打 zip |
| TestFlight / 分发 | 需 Apple Developer 账号（$99/年）配正式签名 |

---

## 七、故障排查

### ld: framework 'arc' not found

上游遗留 bug（见第三节步骤 3）。确认：

1. `ios/robovm.xml` 的 `<libs>` 中有 `<lib>libs/libarc.a</lib>`，
   `<frameworks>` 中**没有** `<framework>arc</framework>`
2. workflow 中 "Fetch libarc.a" 步骤存在且在 "Build IPA" 之前执行

### ld: framework 'MetalANGLEKit' not found

确认 "Fetch MetalANGLEKit frameworks" 步骤存在。该任务在 Arc 仓库内执行，
产物进入 `backend-robovm` 的资源目录，随 jar 参与链接。

### Unrecognized named-value: 'secrets'

`if:` 条件里不能引用 secrets。全部改为 `env:` 传入 + shell 内判断。

### RoboVM phantom class 警告

`java.lang.invoke.StringConcatFactory is a phantom class!` 等警告是 RoboVM
对 JDK 运行时类的正常提示，不影响构建，可忽略。

### 更新 archash 后构建失败

`libarc.a` 与 `archash` 指向的代码存在版本对应关系。更新 `archash` 后若上游
已修复原生库问题（恢复了 natives-ios 或提供了 arc.framework），需同步：
还原 `robovm.xml` 的 `<lib>` 改动、删除 workflow 中 "Fetch libarc.a" 步骤；
若未修复，确认 `ad320d6d` 版本的静态库仍与新代码符号兼容（链接阶段报
`undefined symbols` 即不兼容）。
