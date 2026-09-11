# Android APK 打包指南

Workflow 文件：[`.github/workflows/android.yml`](../.github/workflows/android.yml)
（架构与技术原理见 [ci-packaging-overview.md](ci-packaging-overview.md)）

---

## 一、流程总览

```
Checkout → JDK 17 → 克隆 Arc(archash) → 生成精灵图(tools:pack) → 构建 APK → 上传 artifact
```

运行环境 `ubuntu-latest`，超时 60 分钟。

---

## 二、secrets 配置（可选）

未配置时自动降级为 debug 签名 APK，可直接安装使用。配置后产出正式签名 release 包。

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret 名称 | 内容 |
|--------------|------|
| `ANDROID_KEYSTORE_B64` | keystore 文件的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 签名 key 别名 |
| `ANDROID_KEY_PASSWORD` | key 密码（与 keystore 密码相同时也要填） |

生成 base64（本地执行）：

```bash
# Linux / macOS
base64 -w 0 release.jks > keystore.b64     # macOS: base64 -i release.jks
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.jks")) > keystore.b64
```

---

## 三、步骤解析

### 1. 克隆 Arc（localArc 依赖模式）

```bash
ARC_HASH=$(grep '^archash=' gradle.properties | cut -d'=' -f2)
git clone https://github.com/Anuken/Arc ../Arc
git -C ../Arc checkout "$ARC_HASH"
```

`settings.gradle` 检测到 `../Arc` 后改用本地源码构建依赖；Android 的 `.so` 原生库
（`libarc.so`、`libarc-freetype.so`）也直接从 Arc 仓库的
`natives/natives-android/libs`、`natives/natives-freetype-android/libs` 读取
（见 `android/build.gradle` 的 `jniLibs.srcDirs`）。

### 2. 生成精灵图（关键步骤，必须单独一次 gradle 调用）

```bash
./gradlew tools:pack
```

**为什么必须是独立的 gradle 调用、且放在正式构建之前：**

- `tools:pack` 把 `core/assets-raw/sprites/` 的散图打包成图集，写入
  `core/assets/sprites/sprites.aatls`，并在 `core/build/last_pack_version` 记录版本号
- 首次构建时 `hasSprites()`（检查 `last_pack_version` 是否存在且匹配）返回 false，
  `android/build.gradle` 末尾的 `whenTaskAdded` hack 会给 `assembleDebug/Release`
  挂上 `tools:pack` 依赖
- 但该依赖只约束 `assemble` 任务的**完成顺序**，AGP 8 下中间任务
  `minifyDebugWithR8` 仍会与 `tools:pack` **并行执行**
- R8 读取 `base.jar`（含 `core/assets` 资源）时，`tools:pack` 正在改写这些文件
  → `R8: I/O exception while reading base.jar`

先单独执行 `tools:pack` 后，`last_pack_version` 已存在，后续构建时
`hasSprites()` 返回 true，`whenTaskAdded` hack 不再生效，并行竞争消除。

### 3. 构建 APK（脚本内判断签名）

```bash
if [ -n "$KEYSTORE_B64" ]; then
    echo "$KEYSTORE_B64" | base64 --decode > "$RUNNER_TEMP/release.jks"
    ./gradlew android:assembleRelease \
      -PRELEASE_STORE_FILE="$RUNNER_TEMP/release.jks" \
      -PRELEASE_STORE_PASSWORD="$KEYSTORE_PASSWORD" \
      -PRELEASE_KEY_ALIAS="$KEY_ALIAS" \
      -PRELEASE_KEY_PASSWORD="$KEY_PASSWORD"
else
    ./gradlew android:assembleDebug
fi
```

注意：分支判断写在 shell 内而非 step 的 `if:`——GitHub Actions 禁止在 `if:` 表达式
中引用 `secrets` 上下文（校验阶段直接报 `Unrecognized named-value: 'secrets'`）。

### 4. 上传 artifact

产物路径：`android/build/outputs/apk/**/*.apk`，artifact 名 `Mindustry-android`。

---

## 四、产物位置

| 场景 | 位置 |
|------|------|
| CI | Actions 运行页 → Artifacts → `Mindustry-android`（zip 解压得 APK） |
| 本地 | `android/build/outputs/apk/debug/android-debug.apk` 或 `.../release/android-release.apk` |

---

## 五、故障排查

### R8: I/O exception while reading base.jar

`tools:pack` 与 `minifyDebugWithR8` 并行冲突。确认 workflow 中
"Generate sprite assets" 步骤存在且在 "Build APK" **之前**执行（见上文第三节）。

### Unrecognized named-value: 'secrets'

不要写 `if: ${{ secrets.XXX != '' }}`。改用 `env:` 传入 + shell 内 `[ -z "$X" ]` 判断。

### YAML 结构错乱（续行被当成列表项）

`run: >` 折叠块中行首 `-Pxxx` 会被 YAML 解析为新列表元素。多行命令一律使用
`run: |` 字面块，shell 内用 `\` 续行。

### minifyEnabled 与调试接口

`android/build.gradle` 对所有 buildType 开启 `minifyEnabled = true` +
`shrinkResources = true`（上游注释说明：关闭会导致默认接口方法未被 desugar，
mods 加载崩溃）。CI 打 debug 包同样经过 R8，属正常现象。
