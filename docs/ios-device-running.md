# iOS 真机运行指南

本文说明如何在 macOS 上将当前项目构建、签名并运行到通过 USB 连接的 iPhone。
CI 生成 IPA 的流程见 [ci-ios-packaging.md](ci-ios-packaging.md)。

## 一、环境要求

- macOS、Xcode 和 Xcode Command Line Tools
- JDK 17
- Apple Development 开发证书
- 与当前项目 `gradle.properties` 中 `archash` 对应的 Arc 源码，默认放在项目同级的
  `../Arc`
- 已开启“开发者模式”的 iPhone

确认 Xcode 和 JDK：

```bash
xcode-select -p
xcodebuild -version
/usr/libexec/java_home -V
```

如果 JDK 17 是通过 Homebrew 安装、但 `/usr/libexec/java_home` 找不到它，可以直接设置：

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
```

Intel Mac 上 Homebrew 的默认路径通常是
`/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`。

## 二、准备 Arc 源码

项目检测到同级的 `../Arc` 后，会使用本地 Arc 源码参与构建。首次准备时：

```bash
git clone https://github.com/Anuken/Arc.git ../Arc
git -C ../Arc checkout 889dd8880f
```

`889dd8880f` 是本文编写时 `gradle.properties` 中的 `archash`。以后更新依赖时，应以
`archash` 的实际值为准，不要长期固定使用文档中的提交号。

## 三、首次准备 iOS 原生依赖

当前 Arc 的 Java 音频接口必须与 iOS 原生库来自同一版本。不要使用 Arc 历史提交中的
旧 `libarc.a`，否则应用可能在加载音乐时出现 `UnsatisfiedLinkError`。

### 1. 构建 Arc iOS framework

在 Mindustry 项目根目录运行：

```bash
./gradlew :Arc:arc-core:jnigenBuildAllIOS
mkdir -p ios/libs
cp -R ../Arc/arc-core/build/natives/arc.xcframework ios/libs/
```

首次执行时，Jnigen 会下载 `stb_image.h` 和 SoLoud 源码，然后生成包含真机及模拟器切片的
`arc.xcframework`。

### 2. 准备 MetalANGLEKit

```bash
./gradlew :Arc:backends:backend-robovm:extractMetalANGLEKit
cp -R ../Arc/backends/backend-robovm/res/META-INF/robovm/ios/libs/*.xcframework ios/libs/
```

这一步会准备以下 framework：

- `MetalANGLEKit.xcframework`
- `libGLESv2.xcframework`
- `libEGL.xcframework`
- `libfeature_support.xcframework`

### 3. 准备 FreeType 静态库

```bash
cp ../Arc/natives/natives-freetype-ios/libs/libarc-freetype.a ios/libs/
```

完成后，`ios/libs` 至少应包含：

```text
arc.xcframework/
MetalANGLEKit.xcframework/
libGLESv2.xcframework/
libEGL.xcframework/
libfeature_support.xcframework/
libarc-freetype.a
```

这些产物默认不提交到 Git。更新 `archash` 后，应重新执行本节，确保 Java 接口与原生库
保持一致。

## 四、连接并检查 iPhone

1. 用 USB 连接 iPhone。
2. 解锁 iPhone，并在首次连接时选择“信任此电脑”。
3. 在“设置 → 隐私与安全性 → 开发者模式”中启用开发者模式。
4. 构建和安装期间保持设备解锁。

查看设备：

```bash
xcrun xcdevice list
```

输出中目标 iPhone 应满足：

- `simulator` 为 `false`
- `interface` 为 `usb`
- `available` 为 `true`

如果同时连接多台 iPhone，建议暂时断开不需要运行的设备，避免 RoboVM 选择错误目标。

## 五、确认签名信息

列出本机可用的代码签名身份：

```bash
security find-identity -v -p codesigning
```

开发调试通常选择类似下面的身份：

```text
Apple Development: Your Name (TEAMID)
```

Xcode 16 及更高版本管理的 provisioning profile 通常位于：

```text
~/Library/Developer/Xcode/UserData/Provisioning Profiles/
```

如果存在与应用 Bundle ID 匹配的 profile，RoboVM 通常可以自动选择；自动选择失败时，
再显式传入 profile UUID。

## 六、构建并运行到真机

保持 iPhone 解锁，在项目根目录执行：

```bash
./gradlew ios:launchIOSDevice \
  -PsignIdentity="Apple Development: Your Name (TEAMID)"
```

需要指定 provisioning profile 时：

```bash
./gradlew ios:launchIOSDevice \
  -PsignIdentity="Apple Development: Your Name (TEAMID)" \
  -PprovisioningProfile="PROFILE-UUID"
```

该任务会完成 Java 编译、RoboVM AOT 编译、原生链接、签名、安装和启动，并持续输出设备
控制台日志。运行成功时可以看到类似日志：

```text
[Audio] Initialized SoLoud ... using CoreAudio
[GL] Using OpenGL 3 API.
[Mindustry] Version: custom
Total time to load: ...ms
```

按 `Ctrl+C` 可以结束 Gradle 的日志附加；应用仍可从 iPhone 桌面再次启动。

## 七、只重新安装已有构建

如果应用已经构建成功，只是因为设备锁屏导致安装失败，可以避免重新编译。先从
`xcrun xcdevice list` 找到真机 UDID，然后运行：

```bash
xcrun devicectl device install app \
  -d DEVICE-UDID \
  ios/build/robovm.tmp/IOSLauncher.app

xcrun devicectl device process launch \
  -d DEVICE-UDID \
  --terminate-existing \
  dzq.test.app
```

需要查看启动日志时，在启动命令中增加 `--console`。

## 八、常见问题

### Unable to locate a Java Runtime

系统没有找到 JDK。确认已安装 JDK 17，并正确设置 `JAVA_HOME`。Homebrew Apple Silicon
安装可使用：

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
```

### ld: framework 'MetalANGLEKit' not found

`ios/libs` 中缺少 MetalANGLEKit，或 `ios/robovm.xml` 没有指向 `.xcframework/ios-arm64`
切片。重新执行“准备 MetalANGLEKit”步骤。

### ld: framework 'arc' not found

`ios/libs/arc.xcframework` 不存在。重新执行：

```bash
./gradlew :Arc:arc-core:jnigenBuildAllIOS
cp -R ../Arc/arc-core/build/natives/arc.xcframework ios/libs/
```

### UnsatisfiedLinkError: arc.audio.Soloud.streamLoadFile

Arc Java 代码和 iOS 原生库版本不一致。删除或移走旧的 `arc.xcframework`，然后使用当前
`../Arc` 重新生成并复制。不要用旧 `libarc.a` 替代当前 framework。

### The developer disk image could not be mounted / DeviceLocked

iPhone 处于锁屏状态。解锁设备、保持屏幕常亮，然后重新执行运行命令；如果构建已经完成，
也可以使用第七节的命令直接安装。

### IllegalAccessError 出现在 `$$Lambda$` 类

这是 RoboVM AOT 对私有嵌套类型或非公开构造器的访问兼容问题。供 method reference 或
lambda 创建的类型及其构造器需要具备足够的可见性。当前
`MapListDialog.MapViewSettings` 已按此要求处理。

### phantom class 警告

`StringConcatFactory is a phantom class`、`java.util.function.Consumer is a phantom class`
等通常是 RoboVM 静态扫描提示。如果后续链接、安装和启动成功，可以忽略；应以最终的
`BUILD FAILED`、链接器错误或设备控制台异常为判断依据。

### codesign 请求访问钥匙串

首次本地签名时，macOS 可能弹出钥匙串授权窗口。确认签名身份正确后选择“始终允许”，
否则 Gradle 可能长时间停留在签名阶段。
