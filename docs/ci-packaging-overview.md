# CI 打包总览与技术原理

本仓库通过 GitHub Actions 自动打包 Android APK 与 iOS IPA，相关 workflow 文件：

| Workflow | 文件 | 产物 | 运行环境 |
|----------|------|------|----------|
| Android Build | `.github/workflows/android.yml` | APK | `ubuntu-latest` |
| iOS Build | `.github/workflows/ios.yml` | IPA | `macos-latest`（RoboVM 链接需要 Xcode 工具链） |

---

## 一、为什么 Mindustry 能打包 Android 和 iOS

### 跨平台架构：核心逻辑与平台后端分离

- 游戏核心逻辑全部放在 `:core` 模块（纯 Java，无平台依赖代码）
- 每个平台只需要一个薄薄的"后端"模块（`android/`、`ios/`、`desktop/`、`server/`），负责启动入口和平台 API 适配
- 图形、音频、输入等平台能力由 **Arc 引擎**（Anuken 维护的 libGDX 分支）统一抽象

### Android 侧：ART 运行时

Android 本身就运行 Java（ART 虚拟机），`backend-android` 只是一个普通的 Android 应用外壳：

```
Java 源码 → javac → class → D8 转 dex → R8 压缩/混淆 → APK
```

### iOS 侧：RoboVM AOT 编译

iOS 不允许 JIT（运行时动态生成机器码），也不允许嵌入 JVM，Java 字节码无法直接运行。
**RoboVM** 通过提前编译（AOT）解决：

```
Java 字节码 → RoboVM 编译器 → LLVM → ARM64 原生机器码 → clang 静态链接 → IPA
```

游戏逻辑被完整编译为原生 ARM64 代码，RoboVM 运行时（GC、JNI 桥等）也静态链接进去，对 Apple 审核来说就是一个普通的原生应用。

### iOS 渲染：MetalANGLEKit 转换层

新版 iOS 已弃用 OpenGL ES，Arc 通过 **MetalANGLEKit**（libgdx 维护）把 OpenGL ES 调用实时翻译为 Metal 调用。该框架不在 git 仓库中，由 CI 构建时下载（详见 iOS 文档）。

### 原生库：arc.xcframework / libarc-freetype.a

Arc 中含少量 C/C++ 代码（音频解码、freetype 字体栅格化等）：

- iOS：从锁定的 Arc 源码构建 `arc.xcframework`，并链接 `libarc-freetype.a`
- Android：对应的 `.so` 动态库，打进 APK 的 `jniLibs`

CI 现场构建 framework，保证其原生符号与 `archash` 锁定的 Java 接口一致。

### 依赖来源：本地 Arc 源码（localArc 模式）

`gradle.properties` 中 `archash=889dd8880f` 锁定 Arc 版本。
两个 workflow 都会先把 Arc 克隆到 **Mindustry 的同级目录**（`../Arc`）并 checkout 到该提交——
`settings.gradle` 检测到 `../Arc` 存在后会 `includeBuild` 使用本地源码构建依赖，
而不是走 jitpack（官方认为 jitpack 不可靠，CI 同款做法）。

---

## 二、触发方式

两个 workflow 触发条件相同：

```yaml
on:
  workflow_dispatch:   # 手动触发
  push:
    tags: ['v*']       # 推送 v 前缀的标签时自动触发
```

**手动触发**：仓库 → Actions → 选择对应 workflow → Run workflow

**标签触发**：

```bash
git tag v8.0
git push origin v8.0
```

普通 push 到任何分支**不会**触发打包。

---

## 三、签名模式（由 secrets 决定）

两个 workflow 都支持"配置了签名 secrets → 签名包；未配置 → 无签名包"两种模式。
所有签名相关 secrets 通过 `env:` 传入，**分支判断全部写在 shell 脚本内**——
GitHub Actions 不允许在 step 的 `if:` 条件中引用 `secrets` 上下文，否则
workflow 文件校验直接报 `Unrecognized named-value: 'secrets'`。

| 平台 | 配置了 secrets | 未配置 secrets |
|------|----------------|----------------|
| Android | 签名 release APK | debug 签名 APK（可直接安装） |
| iOS | 签名 IPA | 未签名 IPA（需自行签名后安装） |

各 secrets 的名称、生成方式见对应平台的文档。

---

## 四、产物下载

IPA/APK **不会留在 CI 虚拟机上**（运行结束即销毁），而是作为 artifact 上传：

1. 打开仓库 → **Actions** → 点击对应运行记录
2. 页面最下方 **Artifacts** 区域下载
   - Android：`Mindustry-android`（zip，解压后是 APK）
   - iOS：`Mindustry-ios`（zip，解压后是 IPA）
3. artifact 默认保留 90 天

---

## 五、历史问题速查表

| 错误 | 根因 | 修复 | 详见 |
|------|------|------|------|
| `Unrecognized named-value: 'secrets'` | `if:` 条件里不能引用 secrets | 判断挪到 shell 内，secrets 走 `env:` | 两文档均有 |
| YAML 续行 `-P...` 被解析成列表项 | `run: >` 折叠块中行首 `-` 是列表语法 | 改用 `run: \|` 字面块 | — |
| `ld: framework 'MetalANGLEKit' not found` | 下载任务未挂在常规构建链上 | CI 显式执行 `extractMetalANGLEKit` | iOS 文档 |
| R8 `I/O exception while reading base.jar` | `tools:pack` 与 R8 并行执行冲突 | 先单独执行 `tools:pack` | Android 文档 |
| `ld: framework 'arc' not found` | workflow 未生成/复制 `arc.xcframework` | 从锁定的 Arc 源码构建并复制 XCFramework | iOS 文档 |
