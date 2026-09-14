&#x20;这个项目的素材和 UI 分成两套：素材以 PNG、音频和字体等文件保存；UI 则主要通过 Java 代码动态搭建。



&#x20; ### 修改图片素材



&#x20; 可编辑的原始图片位于：



&#x20; - core/assets-raw/sprites

&#x20; - UI 皮肤：core/assets-raw/sprites/ui

&#x20; - 单位图片：core/assets-raw/sprites/units

&#x20; - 方块图片：core/assets-raw/sprites/blocks

&#x20; - 物品图片：core/assets-raw/sprites/items



&#x20; 直接编辑对应 PNG，同时保留原文件名和画布尺寸最稳妥。例如：



&#x20; units/dagger.png            单位主体

&#x20; units/dagger-base.png       单位底层

&#x20; units/dagger-leg.png        单位腿部

&#x20; items/item-copper.png       铜图标

&#x20; ui/button-over.9.png        鼠标经过时的按钮

&#x20; ui/button-down.9.png        按下状态的按钮



&#x20; 文件名以 .9.png 结尾的是九宫格图片。最外侧的一像素边框定义可拉伸区域和内容区域，修改时不要随便裁掉或涂掉这些标记。



&#x20; 修改后，在项目根目录执行：



&#x20; .\\gradlew.bat tools:pack



&#x20; 该任务会：



&#x20; core/assets-raw/sprites

&#x20;           ↓

&#x20; core/assets-raw/sprites\_out

&#x20;           ↓

&#x20; core/assets/sprites/sprites.aatls



&#x20; 打包逻辑可以在 tools/build.gradle:44 查看。sprites\_out 和最终图集属于生成结果，通常不要直接修改。



&#x20; 然后启动桌面版查看效果：



&#x20; .\\gradlew.bat desktop:run



&#x20; desktop:run 本身也会依赖素材打包任务，所以开发时通常直接运行它即可。



&#x20; ### 修改声音、音乐和文本



&#x20; 运行时资源直接放在：



&#x20; - 音效：core/assets/sounds

&#x20; - 音乐：core/assets/music

&#x20; - 着色器：core/assets/shaders

&#x20; - 多语言文本：core/assets/bundles



&#x20; 中文界面文本主要在 bundle\_zh\_CN.properties 等语言文件里。Java 代码中的：



&#x20; button("@play", ...)



&#x20; 会从 bundle 中查找 play 对应的文字。



&#x20; 替换 OGG 音频时最好保留原文件名，并控制采样率、声道和音量，避免游戏内不同音效响度相差过大。



&#x20; ### 修改 UI 布局



&#x20; Mindustry 的 UI 没有 XML 布局文件，主要使用 Arc 的 Scene2D 风格 API，通过 Table、Button、Label、Image 等控件在 Java 中

&#x20; 创建。



&#x20; 常见入口如下：



&#x20; - 主菜单：core/src/mindustry/ui/fragments/MenuFragment.java:33

&#x20; - 游戏 HUD：core/src/mindustry/ui/fragments/HudFragment.java:238

&#x20; - 暂停菜单：core/src/mindustry/ui/dialogs/PausedDialog.java

&#x20; - 设置界面：core/src/mindustry/ui/dialogs/SettingsMenuDialog.java

&#x20; - 科技树：core/src/mindustry/ui/dialogs/ResearchDialog.java

&#x20; - 星球选择：core/src/mindustry/ui/dialogs/PlanetDialog.java

&#x20; - 全部界面初始化：core/src/mindustry/core/UI.java:191



&#x20; 例如一个典型按钮大致是：



&#x20; table.button("@play", Icon.play, () -> {

&#x20;     // 点击后的操作

&#x20; }).size(220f, 60f).pad(4f);



&#x20; 常用布局方法包括：



&#x20; table.left();               // 内容靠左

&#x20; table.defaults().pad(4f);   // 设置默认间距

&#x20; table.add("文字").growX();   // 横向填充

&#x20; table.row();                // 换行

&#x20; table.image(icon).size(32f);

&#x20; table.button("按钮", () -> {}).width(200f);



&#x20; 主菜单还分别处理了桌面和移动布局：



&#x20; - buildDesktop()：core/src/mindustry/ui/fragments/MenuFragment.java:196

&#x20; - buildMobile()：core/src/mindustry/ui/fragments/MenuFragment.java:134



&#x20; 所以改主菜单时要同时检查桌面端和移动端代码。



&#x20; ### 修改全局样式



&#x20; 按钮、文本框、滚动条、对话框等公共样式集中在：



&#x20; core/src/mindustry/ui/Styles.java:103



&#x20; 例如 TextButtonStyle 控制按钮的字体、背景和按下状态：



&#x20; someStyle = new TextButtonStyle(){{

&#x20;     up = Tex.button;

&#x20;     over = Tex.buttonOver;

&#x20;     down = Tex.buttonDown;

&#x20;     font = Fonts.def;

&#x20;     fontColor = Color.white;

&#x20; }};



&#x20; 对应的 Tex.button、Tex.buttonOver 等来自打包后的图集。mindustry.gen.Tex 是构建生成的类，不能直接编辑；要修改它引用的图

&#x20; 片，编辑 assets-raw/sprites/ui 中同名素材，再重新执行 tools:pack。



&#x20; 整体强调色通常通过 Pal.accent 等颜色定义使用。想整体换色时，可以搜索：



&#x20; rg -n "Pal\\.accent|Color\\.|Styles\\." core/src/mindustry/ui



&#x20; ### 推荐的第一次尝试



&#x20; 先做一个很小的改动：



&#x20; 1. 备份并编辑 core/assets-raw/sprites/ui/button-over.9.png。

&#x20; 2. 执行 .\\gradlew.bat tools:pack。

&#x20; 3. 执行 .\\gradlew.bat desktop:run。

&#x20; 4. 确认按钮悬停外观已经变化。

&#x20; 5. 再修改 MenuFragment.java 中桌面主菜单按钮的尺寸、排列或文字。

&#x20; 6. 重新运行游戏检查不同窗口大小下的布局。



&#x20; 如果只是制作材质包或小型扩展，使用 Mindustry Mod 会更容易维护；如果要全面改主菜单、HUD、设置页和交互逻辑，修改当前源码

&#x20; 仓库更合适。

