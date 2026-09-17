// 供给前线 / 表现层入口：负责渲染游戏世界、处理触摸交互、驱动战斗循环与教学提示。
import {_decorator, Color, Component, director, EventTouch, Graphics, HorizontalTextAlignment, JsonAsset,
    Label, Layers, Node, ResolutionPolicy, resources, UITransform, Vec3, view} from 'cc';
import {BuildPlan, BuildingKind, costText, definitions, itemNames, items, logisticsKinds, Point, vectors} from '../domain/Content';
import {MapData, validateMap} from '../domain/MapData';
import {beltLine, Building, World} from '../domain/World';
import {Command, GameSession} from '../application/GameSession';
import {PlatformService} from '../platform/PlatformService';
import {turretDefinitions} from '../domain/CombatSystem';
import {enemyDefinitions} from '../domain/EnemySystem';

const {ccclass, property} = _decorator;
// 统一的深色界面色板：背景、面板、边框、文字、弱化、薄荷、琥珀、红色。
const palette = {bg: '#101a23', panel: '#192833', border: '#2e4552', ink: '#e5efec', muted: '#8da6b0', mint: '#73e0c1', amber: '#edba75', red: '#e78378'};
// 十六进制色值转 Cocos Color 的工具函数。
const rgba = (hex: string) => new Color().fromHEX(hex);
// 四个方向对应的箭头符号，用于 UI 文本展示建筑朝向。
const arrows = ['→', '↑', '←', '↓'];

@ccclass('GameApp')
export class GameApp extends Component {
    // 已加载地图资源的静态缓存，避免重复加载。
    private static readonly mapAssets = new Map<string, JsonAsset>();
    // 当前场景标识：Boot 启动 / Menu 主菜单 / 其他进入战斗。
    @property page = 'Boot';
    private readonly platform = new PlatformService();       // 平台抽象：存档读写、可见性回调
    private session?: GameSession;                            // 当前战斗会话（驱动世界、敌人、战斗）
    private world?: World;                                   // 当前世界数据（建筑、矿石、地形）
    private board?: Node;                                   // 世界视口节点，承载地形/建筑/预览三层
    private terrain?: Graphics;                              // 地形层：绘制地块、矿石、出生点
    private drawing?: Graphics;                             // 建筑层：绘制建筑、敌人、子弹
    private overlay?: Graphics;                             // 预览层：建造预览框、炮塔射程
    private statusLabel?: Label;                            // 底部状态提示文本
    private inventoryLabel?: Label;                          // 顶部建材/备战入库信息
    private infoLabel?: Label;                              // 右侧检视面板详情
    private objectiveLabel?: Label;                         // 目标/战况文本
    private metricLabel?: Label;                            // 性能指标（P95 帧时长、逻辑时长）
    private pauseLabel?: Label;                             // 暂停/继续/重开按钮
    private startLabel?: Label;                              // 手动开始防守按钮
    private confirmLabel?: Label;                           // 确认建造/确认拆除按钮
    private titleLabel?: Label;                             // 关卡标题
    private selected: BuildingKind | 'browse' | 'remove' = 'browse'; // 当前工具：建筑类型 / 浏览 / 拆除
    private selection?: Point;                              // 当前选中的格子坐标
    private direction = 0;                                  // 建造方向（0-3 顺时针）
    private plans: BuildPlan[] = [];                        // 待建造计划列表（传送带拖动可多条）
    private dragStart?: Point;                              // 拖动起点（用于传送带连线）
    private cell = 32;                                      // 单格像素大小（缩放控制）
    private center = {x: 23, y: 22.5};                      // 相机中心所在格子坐标
    private gesture = false;                               // 是否处于多指手势（缩放/平移）
    private pinchDistance = 0;                             // 双指捏合上一帧距离，用于计算缩放
    private touchTravel = 0;                               // 单指移动累计距离，区分点击与拖动
    private cleanup?: () => void;                           // 平台回调清理函数
    private disposed = false;                              // 组件是否已销毁
    private loading = false;                               // 场景加载中标志，防止重复触发
    private stress = false;                                // 是否处于压力测试模式
    private invasion = false;                              // 是否处于敌袭封路实验模式
    private crossroads = false;                            // 是否处于十字路口（第二关）模式
    private nextLevelLabel?: Label;                         // "体验第二关"按钮（仅教学关胜利后显示）
    private renderTime = 0;                                // 距下次重绘累计时间
    private metricTime = 0;                                // 距下次刷新性能指标累计时间
    private frameSamples: number[] = [];                   // 最近帧时长采样（用于 P95）
    private stepSamples: number[] = [];                    // 最近逻辑步长采样（用于 P95）
    private elapsed = 0;                                   // 战斗累计时长（用于压力测试动画）
    private lastWavesStarted = false;                      // 记录敌袭是否已开始（用于首次提示）
    private toolbarLabels: Array<{kind: BuildingKind; label: Label}> = []; // 建造工具栏按钮与其类型

    // 组件加载时：设置设计分辨率并注册平台可见性回调（页面切回时暂停、被中断时提示）。
    onLoad(): void {
        view.setDesignResolutionSize(1200, 720, ResolutionPolicy.SHOW_ALL);
        this.cleanup = this.platform.onVisibility(() => {
            this.session?.clock.pause(); this.plans = []; this.dragStart = undefined;
        }, () => { this.session?.clock.pause(); this.say('已暂停，点击「继续」恢复。当前原型尚未提供战斗存档。'); });
    }

    // 入口：根据 page 渲染启动页 / 主菜单 / 战斗场景。
    start(): void {
        this.rect(this.node, 'Background', 0, 0, 1200, 720, palette.bg);
        if(this.page === 'Boot'){
            this.text(this.node, 'SUPPLY / FRONTIER', 0, 38, 44, palette.mint, 1000);
            this.statusLabel = this.text(this.node, '正在准备供给前线…', 0, -26, 20, palette.muted);
            this.preloadMaps();
        }else if(this.page === 'Menu') this.menu();
        else this.loadBattle();
    }

    // 预加载 maps 目录下所有地图资源，缓存到静态表后跳转主菜单。
    private preloadMaps(): void {
        resources.loadDir('maps', JsonAsset, (error, assets) => {
            if(this.disposed) return;
            if(error){
                this.say('地图资源准备失败，请重试。');
                this.button('重新加载', 0, -82, 200, 52, () => this.preloadMaps());
                return;
            }
            for(const asset of assets){
                asset.addRef();
                GameApp.mapAssets.set(asset.name, asset);
            }
            this.go('Menu');
        });
    }

    // 切换场景，loading 标志避免重复触发；失败时回退状态并提示。
    private go(scene: string): void {
        if(this.loading) return;
        this.loading = true;
        director.loadScene(scene, error => {
            if(error && !this.disposed){ this.loading = false; this.say(`场景加载失败：${error.message}`); }
        });
    }

    // 主菜单：区分开发区与正式关卡，正式关卡展示标题、首关入口与第二关入口。
    private menu(): void {
        if(this.platform.read('supply.mode') === 'development'){
            this.text(this.node, '开发区 / 规则回归样例', 0, 220, 32, palette.ink);
            for(const [i, entry] of [
                ['旧三缺口供给样例', 'logistics'], ['敌袭：封路与拆墙', 'invasion'], ['合成压力测试', 'stress']
            ].entries()){
                this.button(entry[0], 0, 100-i*90, 440, 62, () => {
                    this.platform.write('supply.mode', entry[1]); this.go('Battle');
                });
            }
            this.button('关卡编辑器', 0, -160, 440, 62, () => this.go('Editor'));
            this.button('返回正式关卡', 0, -230, 440, 62, () => {
                this.platform.write('supply.mode', 'tutorial'); this.go('Menu');
            });
            return;
        }
        this.text(this.node, 'S U P P L Y   /   F R O N T I E R', -260, 258, 18, palette.mint, 580);
        this.text(this.node, '供给前线', -260, 174, 66, palette.ink, 580);
        this.text(this.node, '让每一段运输，都通向下一次生存。', -260, 98, 22, palette.muted, 600);
        this.rect(this.node, 'Mission', -255, -76, 580, 212, palette.panel);
        this.text(this.node, '01  /  供给起步', -255, -18, 28, palette.ink, 530);
        this.text(this.node, '从铜矿开始，亲手连接核心与炮塔。\n准备好后开始防守，抵御三波敌袭', -255, -86, 20, palette.muted, 530);
        this.button('开始第一关  →', -255, -227, 580, 62, () => {
            this.platform.write('supply.mode', 'tutorial'); this.go('Battle');
        }, palette.mint, palette.bg);
        // 右侧工厂插画：用棋盘格 + 传送带箭头 + 矿/塔色块抽象呈现玩法循环。
        const art = this.make(this.node, 'Factory illustration', 322, 50, 400, 360).addComponent(Graphics);
        for(let x=-4;x<=4;x++) for(let y=-4;y<=4;y++){
            art.fillColor = rgba((x+y)%2 ? '#1a2b36' : '#1d303b'); art.roundRect(x*40-17,y*40-17,34,34,4); art.fill();
        }
        for(let x=-3;x<=3;x++){
            art.fillColor = rgba('#476576'); art.roundRect(x*40-15,-15,30,30,5); art.fill();
            this.arrow(art, x*40, 0, 0, 10, palette.mint);
        }
        art.fillColor = rgba(palette.amber); art.rect(-136,-16,32,32); art.fill();
        art.fillColor = rgba(palette.mint); art.roundRect(102,-20,40,40,6); art.fill();
        this.text(this.node, '采矿  →  运输  →  防守', 322, -164, 21, palette.muted, 420);
        this.button('体验第二关：两处防区 →', -255, -310, 580, 48, () => {
            this.platform.write('supply.mode', 'crossroads'); this.go('Battle');
        });
        this.button('开发区', 322, -310, 340, 48, () => {
            this.platform.write('supply.mode', 'development'); this.go('Menu');
        });
    }

    // 进入战斗：根据模式选择对应地图名，优先用缓存资源，否则异步加载。
    private loadBattle(): void {
        this.invasion = this.platform.read('supply.mode') === 'invasion';
        const mode = this.platform.read('supply.mode');
        this.crossroads = mode === 'crossroads';
        const name = this.crossroads ? 'crossroads' : this.invasion ? 'pathfinding' : mode === 'logistics' || mode === 'stress' ? 'logistics' : 'copper-tutorial';
        const path = `maps/${name}`;
        const cached = GameApp.mapAssets.get(name) || resources.get(path, JsonAsset);
        if(cached){
            this.initializeBattle(cached);
            return;
        }
        this.statusLabel = this.text(this.node, '正在加载地图…', 0, 0, 23, palette.muted, 1100);
        resources.load(path, JsonAsset, (error, asset) => {
            if(this.disposed) return;
            if(error){
                this.say('地图加载失败，请重试。');
                this.button('重新加载', 0, -70, 200, 52, () => this.go('Battle'));
                return;
            }
            this.initializeBattle(asset);
        });
    }

    // 校验并初始化战斗：复制地图数据，按压力测试需求改造，创建会话与 UI。
    private initializeBattle(asset: JsonAsset): void {
        try {
            validateMap(asset.json);
            const map = JSON.parse(JSON.stringify(asset.json)) as MapData;
            this.stress = this.platform.read('supply.mode') === 'stress';
            if(this.stress) this.configureStress(map);
            this.session = new GameSession(map);
            this.world = this.session.world;
            this.resetCamera();
            this.lastWavesStarted = this.session.wavesStarted;
            this.statusLabel?.node.destroy();
            this.toolbarLabels = [];
            this.battleUI();
        } catch(error){ this.say(`无法载入地图：${String(error)}`); }
    }

    // 压力测试地图改造：清掉教学/敌袭/备战规则，塞入大量传送带与仓库以测量负载。
    private configureStress(map: MapData): void {
        delete map.waves; delete map.waveStart; delete map.tutorial; delete map.preparation;
        map.width = 96; map.height = 96; map.rocks = []; map.ores = []; map.spawns = [];
        map.buildings = [{kind: 'core', x: 48, y: 48, direction: 0}];
        for(let i=0;i<400;i++) map.buildings.push({kind: 'belt', x: 20+i%40, y: 20+Math.floor(i/40), direction: 0});
        for(let i=0;i<199;i++) map.buildings.push({kind: 'storage', x: 20+i%40, y: 31+Math.floor(i/40), direction: 0});
        this.center = {x: 40, y: 29}; this.cell = 20;
    }

    // 搭建战斗界面：标题栏、地图视口、检视面板、工具栏、目标栏、状态栏。
    private battleUI(): void {
        this.text(this.node, '供给前线', -468, 306, 29, palette.ink, 220);
        this.titleLabel = this.text(this.node, this.stress ? '性能实验 / 合成负载' : this.invasion ? '敌袭 / 封路实验' : this.world!.map.name, -218, 306, 19, palette.muted, 290);
        this.inventoryLabel = this.text(this.node, '', 188, 306, 22, palette.mint, 455);
        this.button('菜单', 514, 306, 100, 46, () => this.go('Menu'));
        this.objectiveLabel = this.text(this.node, '', -138, 248, 19, palette.muted, 850);
        // 世界视口：三层 Graphics 分别承载地形、建筑/敌人/子弹、建造预览与射程提示。
        this.board = this.make(this.node, 'World viewport', -138, -17, 852, 480);
        this.terrain = this.make(this.board, 'Terrain', 0, 0, 852, 480).addComponent(Graphics);
        this.drawing = this.make(this.board, 'Buildings', 0, 0, 852, 480).addComponent(Graphics);
        this.overlay = this.make(this.board, 'Build preview', 0, 0, 852, 480).addComponent(Graphics);
        // 视口的单指/多指触摸事件统一在本组件处理。
        this.board.on(Node.EventType.TOUCH_START, this.touchStart, this);
        this.board.on(Node.EventType.TOUCH_MOVE, this.touchMove, this);
        this.board.on(Node.EventType.TOUCH_END, this.touchEnd, this);
        this.board.on(Node.EventType.TOUCH_CANCEL, () => {
            this.dragStart = undefined; this.plans = []; this.gesture = true; this.pinchDistance = 0; this.describe();
        }, this);
        // 右侧检视面板：显示当前工具/选中建筑状态、建造/拆除确认、方向旋转。
        this.rect(this.node, 'Inspector', 440, -5, 252, 504, palette.panel);
        this.text(this.node, '建造面板', 440, 215, 22, palette.ink, 220);
        this.infoLabel = this.text(this.node, '浏览模式\n\n单指拖动地图\n双指缩放\n点击建筑查看状态', 440, 125, 18, palette.muted, 224, 155);
        this.button('旋转  ↻', 440, 22, 214, 44, () => {
            if(this.selected === 'remove'){ this.say('拆除模式不旋转建筑，请先取消或确认拆除。'); return; }
            this.direction = (this.direction+1)%4;
            // 浏览选中建筑时直接提交旋转命令；正在预览则更新最后一条计划的方向。
            if(this.selected === 'browse' && this.selection) this.submit({type: 'rotate', point: this.selection});
            if(this.plans.length) this.plans[this.plans.length-1].direction = this.direction;
            this.describe();
        });
        this.confirmLabel = this.button('确认建造', 440, -32, 214, 48, () => this.confirmAction(), palette.mint, palette.bg);
        this.button('取消 / 浏览', 440, -86, 214, 44, () => this.choose('browse'));
        this.pauseLabel = this.button('暂停', 380, -194, 95, 44, () => {
            // 战斗已结束时按钮切换为「重开」。
            if(this.session!.outcome !== 'playing'){ this.go('Battle'); return; }
            if(this.session!.clock.paused) this.session!.clock.resume(); else this.session!.clock.pause();
        });
        // 手动开始防守模式：达标前提示先完成供给目标，达标后切换为开始防守。
        if(this.world!.map.waveStart?.manual){
            this.startLabel = this.button('先完成供给目标', 440, -140, 214, 44, () => this.submit({type: 'startDefense'}));
            this.startLabel.fontSize = 16;
        }
        // 教学关胜利后才显示的「体验第二关」按钮。
        if(this.world!.map.tutorial){
            this.nextLevelLabel = this.button('体验第二关 →', 440, -140, 214, 44, () => {
                this.platform.write('supply.mode', 'crossroads'); this.go('Battle');
            });
            this.nextLevelLabel.node.parent!.active = false;
        }
        this.button('拆除', 500, -194, 95, 44, () => this.choose('remove'));
        // 底部建造工具栏：压力测试只显示物流类，正式关卡使用地图允许的建筑。
        const kinds = this.stress ? logisticsKinds : this.world!.map.allowed;
        for(let i=0;i<kinds.length;i++){
            const kind = kinds[i];
            const label = this.button(`${definitions[kind].name}\n${costText(kind)}`, -504+i*144, -310, 132, 62, () => this.choose(kind));
            label.fontSize = 17; label.lineHeight = 24; this.toolbarLabels.push({kind, label});
        }
        this.button('－', 330, -310, 55, 56, () => this.zoom(-4));
        this.button('＋', 397, -310, 55, 56, () => this.zoom(4));
        this.button('归位', 505, -310, 110, 56, () => {
            this.resetCamera(); this.drawTerrain();
        });
        this.statusLabel = this.text(this.node, '', -138, -270, 16, palette.amber, 850);
        this.metricLabel = this.text(this.node, '', 440, 257, 13, palette.muted, 265);
        // 首次状态提示按模式分发：十字路口、教学、压力、敌袭、普通各不同。
        this.say(this.crossroads ? '近矿供给有限，可分流双炮或向下方远矿扩产。红圈是入口；备战入库上限 24 铜，开战解除。' : this.world!.map.tutorial ? `备战核心累计接收最多 ${this.world!.map.preparation?.deliveryLimit.copper ?? '不限'} 铜，额度用完留在线上；开战解除。可随时暂停。` : this.stress ? '600 建筑 / 120 移动标记 / 240 子弹标记；非完整战斗性能。' : this.invasion ? '钻头会把铜送进炮塔；断开弹药线可观察停火，也可建墙改变敌人路线。' : '三条供给线各缺一格：选择传送带，补齐核心、普通炮塔和重型炮塔的线路。');
        this.button('重开本关', 440, -248, 214, 44, () => this.go('Battle'));
        this.drawTerrain(); this.drawWorld(); this.refreshHUD();
    }

    // 切换工具：browse / remove / 具体建筑类型，并刷新检视面板与工具栏高亮。
    private choose(kind: BuildingKind | 'browse' | 'remove'): void {
        // 从已选建筑进入拆除时保留目标，避免玩家必须重新选点却没有提示。
        const target = kind === 'remove' && this.selection && this.world?.at(this.selection) ? this.selection : undefined;
        this.selected = kind; this.plans = []; this.selection = target; this.dragStart = undefined;
        this.describe();
        // 高亮当前工具按钮，其它按钮恢复默认色。
        for(const entry of this.toolbarLabels) entry.label.color = rgba(entry.kind === kind ? palette.mint : palette.ink);
        if(kind === 'remove') this.say(target ? '已选中拆除目标，点击「确认拆除」执行；取消不会拆除。' : '先点建筑，再点「确认拆除」。返还 50% 建材（向下取整），存货销毁。');
        else if(kind === 'browse') this.say('单指拖动浏览；点击查看建筑；双指缩放。');
        else this.say(kind === 'belt' ? '拖动预览整条传送带，确认后统一建造；末端方向可旋转。' : '点击网格预览，再点击确认建造。');
    }

    // 确认按钮分发：拆除走 remove，浏览给提示，其它走 build。
    private confirmAction(): void {
        if(this.selected === 'remove'){
            if(!this.selection){ this.say('先点击要拆除的建筑，再点「确认拆除」。'); return; }
            const result = this.world!.checkRemove(this.selection);
            if(!result.ok){ this.say(result.message); return; }
            if(this.submit({type: 'remove', point: this.selection})) this.selection = undefined;
        }else if(this.selected === 'browse'){
            this.say('请先选择建筑工具；拆除已有建筑请点「拆除」。');
        }else {
            const result = this.world!.checkBuild(this.plans);
            if(result.ok){
                if(this.submit({type: 'build', plans: this.plans})) this.plans = [];
            }else this.say(result.message);
        }
        this.describe();
    }

    // 刷新右侧检视面板：根据当前工具与选中状态显示建筑信息/拆除预览/建造预览/浏览提示。
    private describe(): void {
        if(!this.infoLabel || !this.world) return;
        if(this.confirmLabel) this.confirmLabel.string = this.selected === 'remove' ? '确认拆除' : '确认建造';
        const selectedBuilding = this.selection && this.world.at(this.selection);
        if(this.selected === 'browse' && selectedBuilding){
            this.infoLabel.string = `${definitions[selectedBuilding.kind].name}  ${arrows[selectedBuilding.direction]}\n(${selectedBuilding.x}, ${selectedBuilding.y})\n\n${this.world.status(selectedBuilding)}\n生命 ${selectedBuilding.health}/${definitions[selectedBuilding.kind].health}`;
        }else if(this.selected === 'remove'){
            // 拆除模式：列出可返还建材（50% 向下取整）和将销毁的存货数量。
            const result = this.selection && this.world.checkRemove(this.selection);
            const refund = selectedBuilding && items.map(item => {
                const amount = Math.floor((definitions[selectedBuilding.kind].cost[item] || 0)*0.5);
                return amount ? `${amount}${itemNames[item]}` : '';
            }).filter(Boolean).join(' ');
            this.infoLabel.string = selectedBuilding && result?.ok
                ? `拆除 ${definitions[selectedBuilding.kind].name} (${selectedBuilding.x}, ${selectedBuilding.y})\n返还 ${refund || '0（向下取整）'}\n销毁存货 ${selectedBuilding.cargo.length+selectedBuilding.output}\n点击「确认拆除」执行`
                : `拆除模式\n${result ? result.message : '请点击要拆除的建筑'}\n取消不会拆除`;
        }
        else if(this.selected !== 'browse'){
            const result = this.plans.length ? this.world.checkBuild(this.plans) : null;
            this.infoLabel.string = `${definitions[this.selected].name}  ${arrows[this.direction]}\n${costText(this.selected)} / 个\n\n${result?.message || '请选择位置'}\n${this.selected === 'crafter' ? '2 煤 → 1 石墨 / 2 秒' : ''}`;
        }else this.infoLabel.string = '浏览模式\n\n单指拖动地图\n双指缩放\n点击建筑查看状态';
    }

    // 触摸点转换到视口节点本地坐标。
    private local(event: EventTouch): Vec3 {
        const p = event.getUILocation();
        return this.board!.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(p.x, p.y));
    }
    // 触摸点对应的格子坐标（取整）。
    private grid(event: EventTouch): Point {
        const p = this.local(event);
        return {x: Math.floor(p.x/this.cell + this.center.x), y: Math.floor(p.y/this.cell + this.center.y)};
    }
    // 按下：判断是否多指手势，记录拖动起点；建造模式下立即预览首格。
    private touchStart(event: EventTouch): void {
        this.gesture = event.getAllTouches().length > 1;
        this.pinchDistance = 0;
        this.touchTravel = 0;
        this.dragStart = this.grid(event);
        if(!this.gesture && this.selected !== 'browse' && this.selected !== 'remove') this.preview(this.dragStart);
    }
    // 移动：多指走缩放与平移；单指在浏览模式拖动地图，其它模式刷新预览。
    private touchMove(event: EventTouch): void {
        const touches = event.getAllTouches();
        if(touches.length > 1){
            this.gesture = true; this.plans = [];
            const a = touches[0].getUILocation(), b = touches[1].getUILocation();
            const d = Math.hypot(a.x-b.x,a.y-b.y);
            // 用上一帧双指距离按比例缩放 cell。
            if(this.pinchDistance > 0){ this.cell = Math.max(16, Math.min(48, this.cell*d/this.pinchDistance)); }
            this.pinchDistance = d;
            const delta = event.getUIDelta();
            this.center.x -= delta.x / this.cell / 2; this.center.y -= delta.y / this.cell / 2;
            this.clampCamera(); this.drawTerrain(); return;
        }
        if(this.gesture) return;
        if(this.selected === 'browse'){
            const delta = event.getUIDelta(); this.touchTravel += Math.hypot(delta.x, delta.y);
            this.center.x -= delta.x/this.cell; this.center.y -= delta.y/this.cell;
            this.clampCamera(); this.drawTerrain();
        }else if(this.selected !== 'remove') this.preview(this.grid(event));
    }
    // 抬起：非手势且非拖动时记为点击，更新选中格并刷新预览/检视。
    private touchEnd(event: EventTouch): void {
        if(!this.gesture && !(this.selected === 'browse' && this.touchTravel > 8)){
            this.selection = this.grid(event);
            if(this.selected !== 'browse' && this.selected !== 'remove') this.preview(this.selection);
            this.describe();
        }
        this.dragStart = undefined; this.pinchDistance = 0;
    }
    // 生成建造预览计划：传送带拖动产生折线，其它建筑单格。
    private preview(end: Point): void {
        if(this.selected === 'browse' || this.selected === 'remove') return;
        this.plans = this.selected === 'belt' && this.dragStart ? beltLine(this.dragStart, end, this.direction)
            : [{...end, kind: this.selected, direction: this.direction}];
        this.describe();
    }
    // 相机归位到当前模式的默认中心与缩放。
    private resetCamera(): void {
        this.center = this.stress ? {x:40,y:29} : this.crossroads ? {x:26,y:22} : {x:23,y:22.5};
        this.cell = this.stress ? 20 : this.crossroads ? 26 : 32;
    }
    // 缩放调整并重绘地形。
    private zoom(delta: number): void { this.cell = Math.max(16,Math.min(48,this.cell+delta)); this.drawTerrain(); }
    // 将相机中心限制在地图范围内。
    private clampCamera(): void {
        this.center.x = Math.max(0,Math.min(this.world!.map.width,this.center.x));
        this.center.y = Math.max(0,Math.min(this.world!.map.height,this.center.y));
    }
    // 格子坐标 -> 视口像素坐标。
    private screen(p: Point): Point { return {x:(p.x+0.5-this.center.x)*this.cell, y:(p.y+0.5-this.center.y)*this.cell}; }
    // 像素坐标是否落在视口可见范围。
    private visible(p: Point): boolean { return Math.abs(p.x) < 426-this.cell/2 && Math.abs(p.y) < 240-this.cell/2; }

    // 重绘地形：背景、可见格子（含矿石/岩石），以及敌人出生点提示圈与朝向箭头。
    private drawTerrain(): void {
        if(!this.world || !this.terrain) return;
        const g = this.terrain; g.clear();
        g.fillColor = rgba('#0b131a'); g.rect(-426,-240,852,480); g.fill();
        const halfX = Math.ceil(426/this.cell), halfY = Math.ceil(240/this.cell);
        for(let y=Math.floor(this.center.y)-halfY;y<=this.center.y+halfY;y++){
            for(let x=Math.floor(this.center.x)-halfX;x<=this.center.x+halfX;x++){
                const point = {x,y}, p = this.screen(point);
                if(!this.world.inBounds(point) || !this.visible(p)) continue;
                // 格子底色按地形类型区分：岩石、铜矿、煤矿、空地棋盘色。
                const ore = this.world.ore(point);
                g.fillColor = rgba(this.world.rock(point) ? '#35454f' : ore === 'copper' ? '#5d4937' : ore === 'coal' ? '#33434d' : (x+y)%2 ? '#192832' : '#1c2d37');
                g.rect(p.x-this.cell/2+1,p.y-this.cell/2+1,this.cell-2,this.cell-2); g.fill();
                if(ore){
                    // 矿石点缀：用两个小圆点暗示矿点位置。
                    g.fillColor = rgba(ore === 'copper' ? '#a27c52' : '#677984');
                    g.circle(p.x-6,p.y+5,3); g.circle(p.x+5,p.y-4,4); g.fill();
                }
            }
        }
        // 敌人出生点：红圈 + 指向核心的箭头。
        for(const spawn of this.world.map.spawns){
            const p = this.screen(spawn);
            if(!this.visible(p)) continue;
            g.strokeColor = rgba(palette.red); g.lineWidth = 3;
            g.circle(p.x, p.y, this.cell*0.4); g.stroke();
            const core = this.session!.enemies.core;
            this.arrow(g, p.x, p.y, Math.abs(core.x-spawn.x) >= Math.abs(core.y-spawn.y)
                ? core.x < spawn.x ? 2 : 0 : core.y < spawn.y ? 3 : 1, this.cell*0.25, palette.red);
        }
    }

    // 重绘世界：建筑、敌人、子弹，叠加层处理炮塔射程圈与建造预览/拆除叉号。
    private drawWorld(): void {
        if(!this.world || !this.drawing || !this.overlay) return;
        const g = this.drawing; g.clear();
        for(const b of this.world.buildings.values()){
            const p = this.screen(b); if(!this.visible(p)) continue;
            this.drawBuilding(g, b, p);
        }
        // 敌人：按类型上色，附带血条。
        for(const enemy of this.session!.enemies.enemies.values()){
            const p = this.screen(enemy);
            if(!this.visible(p)) continue;
            g.fillColor = rgba(enemy.kind === 'armored' ? '#b19cdd' : enemy.kind === 'fast' ? palette.amber : palette.red);
            g.circle(p.x, p.y, this.cell * (enemy.kind === 'armored' ? 0.3 : 0.22)); g.fill();
            const health = enemyDefinitions[enemy.kind].health;
            if(enemy.health < health){
                g.fillColor = rgba('#481f25'); g.rect(p.x-this.cell*.3,p.y+this.cell*.31,this.cell*.6,3); g.fill();
                g.fillColor = rgba(palette.mint); g.rect(p.x-this.cell*.3,p.y+this.cell*.31,this.cell*.6*enemy.health/health,3); g.fill();
            }
        }
        // 子弹：重型炮塔用浅薄荷色、较大；普通炮塔用琥珀色。
        for(const bullet of this.session!.combat.bullets.values()){
            const p = this.screen(bullet); if(!this.visible(p)) continue;
            g.fillColor = rgba(bullet.kind === 'heavyTurret' ? '#dffbf4' : '#ffd99e');
            g.circle(p.x, p.y, bullet.kind === 'heavyTurret' ? 3.2 : 2.3); g.fill();
        }
        // 压力测试：用 360 个动画标记模拟移动单位与子弹，验证大量实体下的渲染开销。
        if(this.stress){
            for(let i=0;i<360;i++){
                const p = this.screen({x: this.center.x + Math.sin(this.elapsed*(i<120 ? 0.5 : 1.7)+i)*10,
                    y: this.center.y + Math.cos(this.elapsed*0.6+i*1.3)*6});
                if(!this.visible(p)) continue;
                g.fillColor = rgba(i<120 ? palette.red : palette.amber); g.circle(p.x,p.y,i<120 ? 4 : 1.8); g.fill();
            }
        }
        // 叠加层：先画炮塔射程圈，再画建造/拆除预览。
        const o = this.overlay; o.clear();
        const focus = this.plans[this.plans.length-1] || (this.selection && this.world.at(this.selection));
        if(focus && (focus.kind === 'turret' || focus.kind === 'heavyTurret')){
            // 逐段裁到视口内，射程提示不能覆盖侧边建造按钮。
            const p = this.screen(focus), radius = turretDefinitions[focus.kind].range*this.cell;
            o.strokeColor = rgba(palette.amber); o.lineWidth = 1;
            for(let i=0;i<96;i++){
                const a = i*Math.PI/48, b = (i+1)*Math.PI/48;
                const start = {x:p.x+Math.cos(a)*radius,y:p.y+Math.sin(a)*radius};
                const end = {x:p.x+Math.cos(b)*radius,y:p.y+Math.sin(b)*radius};
                if(this.visible(start) && this.visible(end)){ o.moveTo(start.x,start.y); o.lineTo(end.x,end.y); }
            }
            o.stroke();
        }
        // 建造预览：合法显示薄荷色，非法显示红色，并按方向画箭头。
        const valid = this.world.checkBuild(this.plans).ok;
        o.strokeColor = rgba(valid ? palette.mint : palette.red); o.lineWidth = 2;
        for(const plan of this.plans){
            const p = this.screen(plan); if(!this.visible(p)) continue;
            o.rect(p.x-this.cell/2+2,p.y-this.cell/2+2,this.cell-4,this.cell-4); o.stroke();
            this.arrow(o,p.x,p.y,plan.direction,this.cell*0.24,valid ? palette.mint : palette.red);
        }
        if(this.selection && this.plans.length === 0){
            const p = this.screen(this.selection);
            if(this.visible(p)){
                o.strokeColor = rgba(this.selected === 'remove' ? palette.red : palette.amber);
                o.rect(p.x-this.cell/2,p.y-this.cell/2,this.cell,this.cell); o.stroke();
                if(this.selected === 'remove'){
                    o.moveTo(p.x-this.cell*.3,p.y-this.cell*.3); o.lineTo(p.x+this.cell*.3,p.y+this.cell*.3);
                    o.moveTo(p.x-this.cell*.3,p.y+this.cell*.3); o.lineTo(p.x+this.cell*.3,p.y-this.cell*.3); o.stroke();
                }
            }
        }
    }

    // 绘制单个建筑：底色（受击时变红）+ 类型图标 + 血条 + 货物点缀。
    private drawBuilding(g: Graphics, b: Building, p: Point): void {
        const size = this.cell*0.78;
        g.fillColor = rgba(this.world!.tick-b.lastDamageTick < 6 ? palette.red : definitions[b.kind].color);
        g.roundRect(p.x-size/2,p.y-size/2,size,size,3); g.fill();
        g.strokeColor = rgba('#15232d'); g.lineWidth = 2;
        // 不同建筑类型画不同图标：核心方框、钻头叉、十字路口、合成/路由圆、炮塔炮管等。
        if(b.kind === 'core'){
            g.rect(p.x-size*0.28,p.y-size*0.28,size*0.56,size*0.56); g.stroke();
            g.fillColor = rgba('#e5fff3'); g.circle(p.x,p.y,size*0.12); g.fill();
        }else if(b.kind === 'drill'){
            g.moveTo(p.x-size*0.3,p.y-size*0.3); g.lineTo(p.x+size*0.3,p.y+size*0.3);
            g.moveTo(p.x+size*0.3,p.y-size*0.3); g.lineTo(p.x-size*0.3,p.y+size*0.3); g.stroke();
            const v = vectors[b.direction];
            this.arrow(g,p.x+v.x*size*.32,p.y+v.y*size*.32,b.direction,size*.16,'#fff4d8');
        }else if(b.kind === 'junction'){
            g.moveTo(p.x-size*.4,p.y);g.lineTo(p.x+size*.4,p.y);g.moveTo(p.x,p.y-size*.4);g.lineTo(p.x,p.y+size*.4);g.stroke();
        }else if(b.kind === 'crafter' || b.kind === 'router'){
            g.circle(p.x,p.y,size*0.26); g.stroke();
        }else if(b.kind === 'turret' || b.kind === 'heavyTurret'){
            const scale = b.kind === 'heavyTurret' ? 0.34 : 0.27;
            g.circle(p.x,p.y,size*scale); g.stroke();
            g.moveTo(p.x,p.y); g.lineTo(p.x+size*.38,p.y); g.stroke();
            // 空弹炮塔画感叹号提示玩家补弹。
            if(b.cargo.length === 0){
                g.strokeColor = rgba(palette.amber);
                g.moveTo(p.x,p.y-4); g.lineTo(p.x,p.y+4); g.stroke();
                g.fillColor = rgba(palette.amber); g.circle(p.x,p.y-7,1.5); g.fill();
            }
        }else this.arrow(g,p.x,p.y,b.direction,size*0.27,'#203746');
        // 血条：不满血时显示在建筑下方。
        if(b.health < definitions[b.kind].health){
            g.fillColor = rgba(palette.red); g.rect(p.x-size/2, p.y+size/2+2, size, 3); g.fill();
            g.fillColor = rgba(palette.mint); g.rect(p.x-size/2, p.y+size/2+2, size*b.health/definitions[b.kind].health, 3); g.fill();
        }
        // 货物点缀：最多显示 3 个，颜色按物品类型区分。
        const count = Math.min(3,b.cargo.length+b.output);
        for(let i=0;i<count;i++){
            const item = b.cargo[i]?.item || 'graphite';
            g.fillColor = rgba(item === 'copper' ? '#ffd99e' : item === 'coal' ? '#111b23' : '#dbf4ee');
            g.circle(p.x-6+i*6,p.y-size*0.32,2);g.fill();
        }
    }

    // 在指定位置画方向箭头：用方向向量 + 侧向偏移构成三线箭头。
    private arrow(g: Graphics,x:number,y:number,direction:number,size:number,color:string): void {
        const v=vectors[direction], side={x:-v.y,y:v.x}; g.strokeColor=rgba(color);g.lineWidth=2;
        g.moveTo(x-v.x*size,y-v.y*size);g.lineTo(x+v.x*size,y+v.y*size);
        g.moveTo(x+side.x*size*.6,y+side.y*size*.6);g.lineTo(x+v.x*size,y+v.y*size);
        g.lineTo(x-side.x*size*.6,y-side.y*size*.6);g.stroke();
    }

    // 每帧：推进会话逻辑、采样性能、按节流间隔重绘世界与刷新 HUD、首次敌袭提示。
    update(delta: number): void {
        if(!this.world) return;
        const start = performance.now();
        const steps = this.session!.advance(delta, result => { this.say(result.message); this.describe(); });
        // 只在教学门槛第一次达成时提示，避免每个渲染帧重复覆盖玩家操作反馈。
        if(!this.lastWavesStarted && this.session!.wavesStarted){
            this.lastWavesStarted = true;
            this.say('供给准备完成！第一波敌袭倒计时已经开始。');
        }
        if(steps) this.stepSamples.push((performance.now()-start)/steps);
        this.frameSamples.push(delta*1000);
        // 保留最近 600 个采样点用于 P95 计算。
        if(this.frameSamples.length > 600) this.frameSamples.shift();
        if(this.stepSamples.length > 600) this.stepSamples.shift();
        if(!this.session!.clock.paused) this.elapsed += delta;
        this.renderTime += delta; this.metricTime += delta;
        // 渲染节流：每 50ms 重绘一次世界与 HUD，避免高帧率无谓重绘。
        if(this.renderTime >= 0.05){ this.renderTime=0; this.drawWorld(); this.refreshHUD(); }
        // 每秒刷新一次性能指标：帧 P95 与逻辑 P95。
        if(this.metricTime >= 1){
            this.metricTime=0;
            const p95 = (samples:number[]) => [...samples].sort((a,b)=>a-b)[Math.floor(samples.length*.95)] || 0;
            this.metricLabel!.string=`帧 P95 ${p95(this.frameSamples).toFixed(1)}ms · 逻辑 ${p95(this.stepSamples).toFixed(2)}ms`;
        }
    }

    // 刷新顶部建材、暂停按钮、开始防守按钮，以及目标/战况文本。
    private refreshHUD(): void {
        const world = this.world!;
        // 顶部库存：教学/十字路口显示铜与备战入库；其它显示铜/煤/石墨。
        this.inventoryLabel!.string = world.map.tutorial || this.crossroads ? `建材铜 ${world.inventory.copper}${world.preparationRemaining('copper') !== undefined ? `\n备战入库 ${world.delivered.copper}/${world.map.preparation!.deliveryLimit.copper} · 开战解除` : ''}` : `铜 ${world.inventory.copper}    煤 ${world.inventory.coal}    石墨 ${world.inventory.graphite}`;
        this.pauseLabel!.string = this.session!.outcome !== 'playing' ? '重开' : this.session!.clock.paused ? '继续' : '暂停';
        const session = this.session!;
        // 教学关胜利后才显示「体验第二关」按钮。
        if(this.nextLevelLabel) this.nextLevelLabel.node.parent!.active = session.outcome === 'victory';
        // 手动开始防守按钮：达标前显示提示文字与弱化色，达标后切换为开始防守。
        if(this.startLabel){
            this.startLabel.node.parent!.active = !session.wavesStarted;
            this.startLabel.string = session.canStartDefense ? '开始防守 →' : '先完成供给目标';
            this.startLabel.color = rgba(session.canStartDefense ? palette.mint : palette.muted);
        }
        // 目标文本按阶段/模式分发：教学提示 / 压力测试 / 备战目标 / 战况 / 自由目标。
        if(session.tutorialStage && !session.wavesStarted){
            const hints: Record<string, string> = {
                mine: '① 首次生产：在棕色铜矿上建钻头，箭头为输出方向',
                deliver: '① 核心需要建材：沿钻头输出方向铺带，把铜送入绿色核心',
                supply: '② 自选炮位并接铜线：黄圈是射程，红圈是敌人入口；炮塔 ! 表示缺弹',
                ready: `③ 供给已建立：开始防守后 ${(world.map.waves![0].delayTicks/20).toFixed(0)} 秒来敌，解除备战入库限制`
            };
            this.objectiveLabel!.string = hints[session.tutorialStage];
        }else if(this.stress) this.objectiveLabel!.string = `压力原型 · ${world.buildings.size} 建筑 · 120 移动标记 · 240 子弹标记`;
        else if(world.map.waves?.length){
            const session = this.session!, waves = session.waves;
            if(!session.wavesStarted){
                // 备战阶段：列出核心入库与各类弹药达标情况。
                const condition = world.map.waveStart!, ammo = session.turretAmmo();
                const goals: string[] = [];
                for(const item of items){
                    if(condition.delivered?.[item]) goals.push(`核心${itemNames[item]} ${Math.min(world.delivered[item], condition.delivered[item]!)}/${condition.delivered[item]}`);
                    if(condition.ammo?.[item]) goals.push(`${itemNames[item]}弹药 ${Math.min(ammo[item], condition.ammo[item]!)}/${condition.ammo[item]}`);
                }
                this.objectiveLabel!.string = `备战 · ${goals.join(' · ')}${condition.manual ? ' · 达标后点击开始防守' : ''}`;
            }else this.objectiveLabel!.string = session.outcome === 'defeat' ? '战斗失败 · 核心已被摧毁 · 点击「重开」再次挑战'
                : session.outcome === 'victory' ? `战斗胜利 · 核心 ${session.enemies.core.health}/600 · 击杀 ${session.combat.kills} · 耗弹 ${session.combat.shots} · 可重开改进布局`
                : `核心 ${session.enemies.core.health} · 敌人 ${session.enemies.enemies.size}/120 · 击杀 ${session.combat.kills} · ${waves.complete ? '全部敌人已出生' : `波次 ${waves.waveIndex+1}/${waves.waves.length} ${waves.waves[waves.waveIndex].enemy === 'fast' ? '快速' : waves.waves[waves.waveIndex].enemy === 'armored' ? '重甲' : '普通'} ×${waves.waves[waves.waveIndex].count} · 下次出生 ${(waves.remainingTicks/20).toFixed(1)}秒`}`;
        }else {
            // 自由模式目标：铜入核心 10 与生产石墨 3。
            const copper = Math.min(10,world.delivered.copper), graphite = Math.min(3,world.produced.graphite);
            this.objectiveLabel!.string = `目标 ① 铜送入核心 ${copper}/10    ② 生产石墨 ${graphite}/3${copper===10&&graphite===3 ? '    ✓ 供给链已建立' : ''}`;
        }
        // 战斗中追加空弹炮塔数与被毁建筑数，提示玩家调整供给与防线。
        if(!this.stress && session.wavesStarted && session.outcome === 'playing'){
            let empty = 0;
            for(const building of world.buildings.values()){
                if((building.kind === 'turret' || building.kind === 'heavyTurret') && building.cargo.length === 0) empty++;
            }
            this.objectiveLabel!.string += `\n空弹炮塔 ${empty} · 被毁建筑 ${world.lostBuildings} · 可暂停调整供给和防线`;
        }
        // 浏览/拆除模式下有选中时同步刷新检视面板。
        if((this.selected==='browse' || this.selected==='remove') && this.selection) this.describe();
    }

    // 提交命令到会话：战斗已结束则拒绝，否则入队并按暂停状态提示执行时机。
    private submit(command: Command): boolean {
        if(this.session!.outcome !== 'playing'){ this.say(this.session!.outcome === 'victory' ? '战斗已经胜利，请重开。' : '核心已被摧毁，请重开。'); return false; }
        this.session!.enqueue(command);
        this.say(this.session!.clock.paused ? '操作已排队，点击「继续」后执行。' : '操作已提交');
        return true;
    }
    // 更新底部状态提示文本。
    private say(message: string): void { if(this.statusLabel) this.statusLabel.string = message; }
    // 创建一个具有指定尺寸的 UI 节点并挂到 parent 下。
    private make(parent:Node,name:string,x:number,y:number,width:number,height:number):Node {
        const node=new Node(name);node.layer=Layers.Enum.UI_2D;node.setParent(parent);node.setPosition(x,y,0);
        node.addComponent(UITransform).setContentSize(width,height);return node;
    }
    // 创建一个带圆角背景的矩形节点（用于面板/按钮底）。
    private rect(parent:Node,name:string,x:number,y:number,width:number,height:number,color:string):Node {
        const n=this.make(parent,name,x,y,width,height), g=n.addComponent(Graphics);
        g.fillColor=rgba(color);g.roundRect(-width/2,-height/2,width,height,8);g.fill();return n;
    }
    // 创建一个居中、可缩放、可换行的文本节点。
    private text(parent:Node,value:string,x:number,y:number,size:number,color:string,width=600,height=100):Label {
        const label=this.make(parent,'Text',x,y,width,height).addComponent(Label);
        label.string=value;label.fontSize=size;label.lineHeight=size*1.45;label.color=rgba(color);
        label.horizontalAlign=HorizontalTextAlignment.CENTER;label.verticalAlign=Label.VerticalAlign.CENTER;
        label.overflow=Label.Overflow.SHRINK;label.enableWrapText=true;return label;
    }
    // 创建按钮：底色矩形 + 文本 + 触摸结束回调，返回内部 Label 便于后续更新文字/颜色。
    private button(value:string,x:number,y:number,width:number,height:number,callback:()=>void,color=palette.border,ink=palette.ink):Label {
        const node=this.rect(this.node,value,x,y,width,height,color);
        const label=this.text(node,value,0,0,19,ink,width-10,height-4);
        node.on(Node.EventType.TOUCH_END,(event:EventTouch)=>{event.propagationStopped=true;callback();});return label;
    }
    // 组件销毁：标记已销毁、清理平台回调、取消所有调度。
    onDestroy(): void { this.disposed=true;this.cleanup?.();this.unscheduleAllCallbacks(); }
}
