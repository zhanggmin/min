# iOS IPA 打包指南

Workflow 文件：[`.github/workflows/ios.yml`](../.github/workflows/ios.yml)
（架构与技术原理见 [ci-packaging-overview.md](ci-packaging-overview.md)）

---

## 一、流程总览

```
Checkout → JDK 17 → 克隆 Arc(archash) → 构建 arc.xcframework → 下载 MetalANGLEKit
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

生成 base64：

```bash
# macOS
base64 -i cert.p12 > cert.b64
base64 -i profile.mobileprovision > profile.b64
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.p12")) > cert.b64
```

证书在"钥匙串访问"中导出（选 Apple Distribution 证书，连私钥一起，格式 .p12）；
描述文件在 developer.apple.com 下载。Workflow 会从 `.mobileprovision` 自动解析 UUID，
无需再单独配置 UUID secret。

App Store 可用的签名配置为 `IOS_CERTIFICATE_B64` + `IOS_CERTIFICATE_PASSWORD` +
`IOS_PROVISIONING_PROFILE_B64`。无需配置 `IOS_SIGN_IDENTITY`：Workflow 会比较 profile
中 `DeveloperCertificates` 与 keychain identity 的 SHA-1 指纹，并将匹配身份传给 RoboVM。

---

## 三、步骤解析

### 1. 克隆 Arc（localArc 依赖模式）

与 Android 相同：克隆到 `../Arc` 并 checkout 到 `gradle.properties` 的 `archash`，
`settings.gradle` 会 `includeBuild` 切换到本地源码依赖。

### 2. 准备 iOS 原生框架

```bash
cd ../Arc
./gradlew :arc-core:jnigenBuildAllIOS \
  :backends:backend-robovm:extractMetalANGLEKit \
  --no-daemon
cd -
mkdir -p ios/libs
cp -R ../Arc/arc-core/build/natives/arc.xcframework ios/libs/
cp -R ../Arc/backends/backend-robovm/res/META-INF/robovm/ios/libs/*.xcframework ios/libs/
```

**背景**：新版 iOS 已弃用 OpenGL ES，Arc 用 MetalANGLEKit（libgdx 维护的
OpenGL ES → Metal 翻译层）渲染。该框架不在 Arc git 仓库中，由
`backend-robovm/build.gradle` 定义的 `extractMetalANGLEKit` 任务从
libgdx/MetalANGLEKit 官方 release（v1.2.1，带 SHA-256 校验）下载并解压到
`res/META-INF/robovm/ios/libs/`，随 jar 参与链接。

这两个任务都**没有挂在 Mindustry 的常规构建链上**。第一项从当前 `archash` 对应的
Arc 源码生成 `arc.xcframework`，避免旧 `libarc.a` 与 Java JNI 声明不匹配；第二项下载
MetalANGLEKit。随后必须把所有 XCFramework 复制到 `ios/libs`，与 `robovm.xml` 的
`frameworkPaths` 保持一致，否则会出现 `search path ... not found`，并最终报
`ld: framework 'arc' not found`。

### 3. 导入签名证书（配置了 secrets 时）

- 创建临时 keychain 并设为默认（避免污染系统钥匙串）
- `security import` 导入 .p12，授权 `/usr/bin/codesign` 使用
- `set-key-partition-list` 允许非交互式签名（CI 无弹窗环境必需）
- 校验描述文件的 CMS 内容并自动解析 UUID
- 描述文件安装到 Xcode 16+ 使用的
  `~/Library/Developer/Xcode/UserData/Provisioning Profiles/<UUID>.mobileprovision`
- 将解析出的 UUID 通过 `GITHUB_ENV` 传给后续 RoboVM 构建步骤
- Workflow 根据 profile 中的证书指纹自动选择已导入 keychain 的签名身份

证书和 profile 都未配置时打印 notice 并 `exit 0`，产出未签名 IPA；只配置其中一个
则立即报错，避免误产出无法上传的包。

### 4. 构建 IPA

```bash
# 有完整签名信息
./gradlew ios:createIPA \
  -PappBuild="$BUILD_NUMBER" \
  -PsignIdentity="$IOS_SIGNING_IDENTITY" \
  -PprovisioningProfile="$IOS_PROFILE_UUID"
# 无任何签名信息
./gradlew ios:createIPA -PappBuild="$BUILD_NUMBER"
```

`BUILD_NUMBER` 使用 `40 + GITHUB_RUN_NUMBER`，作为 IPA 的
`CFBundleVersion`。`GITHUB_RUN_NUMBER` 每次新的 workflow 运行自动加 1，
因此构建号从已上传的 `40` 之后开始按次递增。CI 通过
`-PappBuild` 显式注入该值（见第七节错误 -19232）。

`ios/build.gradle` 中的本地修改：

```groovy
//Workflow 自动传入匹配 identity；两个参数都没有时才跳过签名
iosSkipSigning = !project.hasProperty("signIdentity") && !project.hasProperty("provisioningProfile")
```

官方仓库此处是 `iosSkipSigning = false`（强制签名，无证书直接失败）。

构建链：`createIPA` 依赖 `build`（RoboVM AOT 编译 + clang 链接）、`copyNatives`
（从 `../Arc/natives/natives-freetype-ios/libs` 复制 `libarc-freetype.a`）、
`:tools:pack`（精灵图）、`:core:preGen`（版本号/本地化生成）。

### 5. 上传 artifact

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
| arc.xcframework | 与 `archash` 相同的 Arc 源码 | CI 现场构建，包含真机 ARM64 切片 |
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

确认原生框架准备步骤已成功，并检查：

1. `ios/libs/arc.xcframework/ios-arm64/arc.framework/arc` 存在
2. `ios/robovm.xml` 的 `<frameworks>` 中有 `<framework>arc</framework>`，且
   `frameworkPaths` 指向 `libs/arc.xcframework/ios-arm64`

### ld: framework 'MetalANGLEKit' not found

确认 "Prepare iOS native frameworks" 步骤存在。该任务在 Arc 仓库内下载框架，
并把 XCFramework 复制到 `ios/libs` 后再执行 IPA 构建。

### Unrecognized named-value: 'secrets'

`if:` 条件里不能引用 secrets。全部改为 `env:` 传入 + shell 内判断。

### RoboVM phantom class 警告

`java.lang.invoke.StringConcatFactory is a phantom class!` 等警告是 RoboVM
对 JDK 运行时类的正常提示，不影响构建，可忽略。

### Missing Provisioning Profile / embedded.mobileprovision

确认已配置 `IOS_PROVISIONING_PROFILE_B64`。Workflow 会从该 secret 解码 profile、
自动解析 UUID 并显式传给 RoboVM；构建后还会检查 IPA 中是否存在
`Payload/*.app/embedded.mobileprovision`，缺失时在上传 artifact 前直接失败。

### No signing identity found matching Apple Development

RoboVM 2.3.26 未指定 identity 时只按开发证书名称自动搜索，因而无法选中
`Apple Distribution`。Workflow 会从 profile 的 `DeveloperCertificates` 计算 SHA-1，
找到 `.p12` 中的匹配 identity，并通过 `-PsignIdentity` 显式传入，无需配置 secret。

### The provided entity includes an attribute with a value that has already been used (-19232)

App Store Connect 要求构建号（`CFBundleVersion`，取自 `ios/robovm.properties` 的
`app.build`）必须高于该 App 之前上传的值。该文件被 `.gitignore` 忽略，CI 全新检出时
不存在，原逻辑会退回默认值 `40`，导致每次 CI 产出的构建号相同。
Workflow 已通过 `-PappBuild` 注入 `40 + GITHUB_RUN_NUMBER` 修复，
每次新的 workflow 运行会自动加 1。

本地运行 `./gradlew ios:createIPA` 时，`incrementConfig` 会在
`ios/robovm.properties` 中将上次构建号加 1。如果本地构建号落后于 CI，
应显式传入更大的值，例如 `./gradlew ios:createIPA -PappBuild=45`。

### 更新 archash 后构建失败

`arc.xcframework` 与 `archash` 指向的 Java JNI 声明必须来自同一 Arc 提交。CI 每次都
从锁定源码重新构建；本地更新 `archash` 后也应重新生成并替换 `ios/libs/arc.xcframework`。
