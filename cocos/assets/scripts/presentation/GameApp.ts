// 供给前线 / 表现层入口：负责渲染游戏世界、处理触摸交互、驱动战斗循环与教学提示。
import {_decorator, Component, director, EventTouch, Graphics, HorizontalTextAlignment, JsonAsset,
    Label, Layers, Mask, Node, ResolutionPolicy, resources, ScrollView, UITransform, Vec3, view} from 'cc';
import {BuildPlan, BuildingKind, costText, definitions, itemNames, items, logisticsKinds, Point, vectors} from '../domain/Content';
import {MapData, validateMap} from '../domain/MapData';
import {beltLine, Building, World} from '../domain/World';
import {Command, CommandResult, GameSession} from '../application/GameSession';
import {PlatformService} from '../platform/PlatformService';
import {turretDefinitions} from '../domain/CombatSystem';
import {enemyDefinitions} from '../domain/EnemySystem';

const {ccclass, property} = _decorator;
import {buildingIcon, GameButton, palette, rgba} from './GameWidgets';
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
    private renderTime = 0;                                // 距下次重绘累计时间
    private metricTime = 0;                                // 距下次刷新性能指标累计时间
    private frameSamples: number[] = [];                   // 最近帧时长采样（用于 P95）
    private stepSamples: number[] = [];                    // 最近逻辑步长采样（用于 P95）
    private elapsed = 0;                                   // 战斗累计时长（用于压力测试动画）
    private lastWavesStarted = false;                      // 记录敌袭是否已开始（用于首次提示）
    private toolbarLabels: Array<{kind: BuildingKind; label: Label}> = []; // 建造工具栏按钮与其类型

    private uiRoot?: Node;
    private inspector?: Node;
    private inspectorTitle?: Label;
    private rotateLabel?: Label;
    private bendLabel?: Label;
    private removeLabel?: Label;
    private lifeLabel?: Label;
    private phaseLabel?: Label;
    private alertLabel?: Label;
    private goalPanel?: Node;
    private modal?: Node;
    private resultShown = false;
    private buttons = new Map<Label, GameButton>();
    private width = 1200;
    private height = 720;
    private boardWidth = 1200;
    private boardHeight = 480;
    private safeLeft = 0;
    private safeRight = 0;
    private safeTop = 0;
    private safeBottom = 0;
    private verticalFirst = false;
    private lineStart?: Point;
    private lineEnd?: Point;
    private pendingAction?: number;
    private pendingPlans: BuildPlan[] = [];
    private toastTime = 0;
    private markers: Array<{point: Point; node: Node; permanent: boolean}> = [];
    private successPoint?: Point;
    private successTime = 0;
    private readonly resized = () => {
        this.configureView();
        if(this.world){ this.session!.clock.pause(); this.processPaused(); this.resultShown=false; this.battleUI(); }
        else if(this.page === 'Menu'){ this.clearUI(); this.menu(); }
    };

    private configureView(): void {
        const frame = view.getFrameSize();
        this.height = Math.max(480, Math.min(720, frame.height));
        this.width = Math.max(480, this.height*frame.width/Math.max(1,frame.height));
        view.setDesignResolutionSize(this.width, this.height, ResolutionPolicy.SHOW_ALL);
        const safe = this.platform.safeInsets();
        const scale = this.height/Math.max(1,frame.height);
        this.safeLeft = safe.left*scale; this.safeRight = safe.right*scale;
        this.safeTop = safe.top*scale; this.safeBottom = safe.bottom*scale;
    }

    private clearUI(): void {
        this.uiRoot?.destroy(); this.modal = undefined;
        this.uiRoot = this.make(this.node, 'Game interface', 0, 0, this.width, this.height);
        this.buttons.clear(); this.toolbarLabels = []; this.markers = [];
        this.rect(this.uiRoot, 'Background', 0, 0, this.width, this.height, palette.bg);
    }

    // 组件加载时：设置设计分辨率并注册平台可见性回调（页面切回时暂停、被中断时提示）。
    onLoad(): void {
        this.configureView();
        view.on('canvas-resize', this.resized, this);
        this.cleanup = this.platform.onVisibility(() => {
            this.session?.clock.pause(); this.plans = []; this.dragStart = undefined; this.gesture = true;
            this.processPaused();
        }, () => { this.session?.clock.pause(); this.say('已暂停，点击「继续」恢复。当前原型尚未提供战斗存档。'); });
    }

    // 入口：根据 page 渲染启动页 / 主菜单 / 战斗场景。
    start(): void {
        this.clearUI();
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
        const root = this.uiRoot!, top = this.height/2-this.safeTop, w = Math.min(this.width-this.safeLeft-this.safeRight-48, 1000);
        this.text(root, '供给前线', 0, top-60, 40, palette.ink, w, 54);
        this.text(root, '采矿  →  运输  →  防守', 0, top-108, 18, palette.muted, w, 30);
        const cardWidth = (w-24)/2, cardHeight = Math.min(300,this.height-210), y = -10;
        for(let i=0;i<2;i++){
            const x = (i ? 1 : -1)*(cardWidth+24)/2;
            const card = this.rect(root, 'Level card', x,y,cardWidth,cardHeight,palette.panel);
            const art = this.make(card,'Factory illustration',0,cardHeight/2-65,cardWidth-24,72).addComponent(Graphics);
            buildingIcon(art, 'drill', -70,0,45); buildingIcon(art, 'belt', 0,0,35); buildingIcon(art, i ? 'turret' : 'core',70,0,45);
            this.text(card,i ? '02  两处防区' : '01  供给起步',0,cardHeight/2-118,24,palette.ink,cardWidth-20,34);
            this.text(card,i ? '分配铜矿，建立两处防线' : '从铜矿开始，连接核心与炮塔',0,-28,18,palette.muted,cardWidth-28,44);
            this.button(i ? '体验第二关  →' : '开始第一关  →',0,-cardHeight/2+38,cardWidth-32,52,() => {
                this.platform.write('supply.mode',i ? 'crossroads' : 'tutorial'); this.go('Battle');
            },i ? palette.panel : palette.mint,i ? palette.ink : palette.white,card);
        }
        this.button('开发区', w/2-64,-this.height/2+this.safeBottom+34,128,48,() => {
            this.platform.write('supply.mode','development'); this.go('Menu');
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
        this.clearUI();
        const root = this.uiRoot!, left = -this.width/2+this.safeLeft+12, right = this.width/2-this.safeRight-12;
        const top = this.height/2-this.safeTop, bottom = -this.height/2+this.safeBottom;
        const available = right-left, compact = available < 800;
        const hudY = top-34, toolbarY = bottom+46;
        this.boardWidth = this.width;
        this.boardHeight = Math.max(120,top-bottom-158);
        this.board = this.make(root,'World viewport',0,bottom+92+this.boardHeight/2,this.boardWidth,this.boardHeight);
        this.board.addComponent(Mask);
        this.terrain = this.make(this.board,'Terrain',0,0,this.boardWidth,this.boardHeight).addComponent(Graphics);
        this.drawing = this.make(this.board,'Buildings',0,0,this.boardWidth,this.boardHeight).addComponent(Graphics);
        this.overlay = this.make(this.board,'Preview',0,0,this.boardWidth,this.boardHeight).addComponent(Graphics);
        this.board.on(Node.EventType.TOUCH_START,this.touchStart,this);
        this.board.on(Node.EventType.TOUCH_MOVE,this.touchMove,this);
        this.board.on(Node.EventType.TOUCH_END,this.touchEnd,this);
        this.board.on(Node.EventType.TOUCH_CANCEL,() => {
            this.dragStart=undefined; this.plans=[]; this.gesture=true; this.pinchDistance=0; this.describe();
        });
        const markerPoints = [
            {point:this.session!.enemies.core,text:'核心',permanent:true},
            ...this.world!.map.spawns.map(point => ({point,text:'敌人入口',permanent:true})),
            ...this.world!.map.ores.filter((ore,i,ores) => !ores.slice(0,i).some(p => p.item === ore.item && Math.abs(p.x-ore.x)+Math.abs(p.y-ore.y)<3))
                .map(point => ({point,text:point.item === 'copper' ? '铜矿' : '煤矿',permanent:false}))
        ];
        for(const marker of markerPoints){
            const n=this.rect(this.board,'Map label',0,0,80,25,palette.panel);
            this.text(n,marker.text,0,0,15,palette.ink,76,24);
            this.markers.push({...marker,node:n});
        }
        this.rect(root,'Status bar',0,hudY,this.width,68,palette.panel);
        const titleWidth = compact ? 136 : 220;
        this.titleLabel=this.text(root,this.crossroads ? '02  两处防区' : this.stress ? '性能实验' : this.invasion ? '封路实验' : '01  供给起步',left+titleWidth/2,hudY,compact ? 18 : 22,palette.ink,titleWidth,40);
        this.lifeLabel=this.text(root,'',left+titleWidth+70,hudY,18,palette.ink,130,42);
        this.inventoryLabel=this.text(root,'',left+titleWidth+185,hudY,18,palette.mint,110,50);
        this.pauseLabel=this.button('暂停',right-120,hudY,80,48,() => {
            if(this.session!.outcome !== 'playing') return;
            if(this.session!.clock.paused) this.session!.clock.resume();
            else { this.session!.clock.pause(); this.processPaused(); }
            this.refreshHUD();
        });
        this.button('菜单',right-36,hudY,72,48,() => this.openMenu());
        const goalWidth=Math.min(compact ? 340 : 430,available-230);
        this.goalPanel=this.rect(root,'Current objective',left+goalWidth/2,top-112,goalWidth,76,palette.panel);
        this.blockInput(this.goalPanel);
        this.objectiveLabel=this.text(this.goalPanel,'',-25,0,18,palette.ink,goalWidth-66,66);
        this.objectiveLabel.horizontalAlign=HorizontalTextAlignment.LEFT;
        this.button('?',goalWidth/2-27,0,44,48,() => this.showGoals(),palette.panel,palette.ink,this.goalPanel);
        this.phaseLabel=this.text(root,'',0,bottom+113,18,palette.ink,Math.max(200,available-300),30);
        this.startLabel=this.button('完成供给目标',right-105,top-102,210,48,() => this.submit({type:'startDefense'}),palette.mint,palette.white);
        this.startLabel.node.parent!.active=!!this.world!.map.waveStart?.manual;
        this.alertLabel=this.button('',left+95,bottom+148,190,44,() => this.locateEmptyTurret(),palette.panel,palette.amber);
        this.statusLabel=this.text(root,'',0,bottom+177,17,palette.amber,Math.min(available-24,780),48);
        this.statusLabel.node.active=false;
        const detailWidth=compact ? 224 : 264, detailHeight=compact ? 222 : 266;
        this.inspector=this.rect(root,'Inspector',right-detailWidth/2,top-148-detailHeight/2,detailWidth,detailHeight,palette.panel);
        this.blockInput(this.inspector);
        this.inspectorTitle=this.text(this.inspector,'',0,detailHeight/2-24,20,palette.ink,detailWidth-24,30);
        this.infoLabel=this.text(this.inspector,'',0,compact ? 26 : 34,17,palette.muted,detailWidth-24,compact ? 84 : 124);
        this.infoLabel.horizontalAlign=HorizontalTextAlignment.LEFT;
        const actionY=-detailHeight/2+84;
        this.rotateLabel=this.button('旋转',-detailWidth/4+4,actionY,detailWidth/2-18,44,() => this.rotateSelection(),palette.panel,palette.ink,this.inspector);
        this.bendLabel=this.button('切换拐弯',detailWidth/4-4,actionY,detailWidth/2-18,44,() => {
            this.verticalFirst=!this.verticalFirst;
            if(this.lineStart && this.lineEnd) this.plans=beltLine(this.lineStart,this.lineEnd,this.direction,this.verticalFirst);
            this.describe();
        },palette.panel,palette.ink,this.inspector);
        this.removeLabel=this.button('拆除',detailWidth/4-4,actionY,detailWidth/2-18,44,() => this.choose('remove'),palette.panel,palette.red,this.inspector);
        this.confirmLabel=this.button('确认建造',-38,-detailHeight/2+30,detailWidth-100,48,() => this.confirmAction(),palette.mint,palette.white,this.inspector);
        this.button('取消',detailWidth/2-44,-detailHeight/2+30,72,48,() => this.choose('browse'),palette.panel,palette.ink,this.inspector);
        this.button('－',right-162,bottom+121,48,48,() => this.zoom(-4));
        this.button('＋',right-108,bottom+121,48,48,() => this.zoom(4));
        this.button('归位',right-38,bottom+121,80,48,() => { this.resetCamera(); this.drawTerrain(); });
        // Scroll only the tools, never reduce the touch target to fit additional kinds.
        this.rect(root,'Tool shelf',0,toolbarY,this.width,92,palette.panel);
        const shelf=this.make(root,'Tools', (left+right)/2,toolbarY,available,84);
        const clip=this.make(shelf,'Tool clip',0,0,available,84); clip.addComponent(Mask);
        const kinds=this.stress ? logisticsKinds : this.world!.map.allowed;
        const toolWidth=Math.max(140,Math.min(220,(available-(kinds.length-1)*12)/kinds.length));
        const contentWidth=Math.max(available,kinds.length*(toolWidth+12)-12);
        const content=this.make(clip,'Tool content',(contentWidth-available)/2,0,contentWidth,84);
        const scroll=shelf.addComponent(ScrollView); scroll.content=content; scroll.horizontal=true; scroll.vertical=false;
        scroll.elastic=false; scroll.inertia=true;
        for(let i=0;i<kinds.length;i++){
            const kind=kinds[i], x=-contentWidth/2+toolWidth/2+i*(toolWidth+12);
            const label=this.button(`${definitions[kind].name}\n${costText(kind)}`,x,0,toolWidth,72,() => this.choose(kind),palette.panel,palette.ink,content);
            label.node.setPosition(20,0,0); label.node.getComponent(UITransform)!.setContentSize(toolWidth-52,66);
            label.fontSize=17; label.lineHeight=24;
            const icon=this.make(label.node.parent!,'Building icon',-toolWidth/2+26,0,40,40).addComponent(Graphics);
            buildingIcon(icon,kind,0,0,34);
            this.toolbarLabels.push({kind,label});
        }
        this.metricLabel=this.text(root,'',0,top-56,14,palette.muted,400,20);
        this.metricLabel.node.active=this.stress || this.invasion;
        this.describe(); this.drawTerrain(); this.drawWorld(); this.refreshHUD();
    }

    private rotateSelection(): void {
        if(this.pendingAction !== undefined) return;
        if(this.selected === 'browse' && this.selection) this.submit({type:'rotate',point:this.selection});
        else if(this.selected !== 'remove'){
            this.direction=(this.direction+1)%4;
            if(this.plans.length) this.plans[this.plans.length-1].direction=this.direction;
        }
        this.describe();
    }

    // 切换工具：browse / remove / 具体建筑类型，并刷新检视面板与工具栏高亮。
    private choose(kind: BuildingKind | 'browse' | 'remove'): void {
        // 从已选建筑进入拆除时保留目标，避免玩家必须重新选点却没有提示。
        const target = kind === 'remove' && this.selection && this.world?.at(this.selection) ? this.selection : undefined;
        this.selected = kind; this.plans = []; this.selection = target; this.dragStart = undefined; this.lineStart=undefined; this.lineEnd=undefined;
        this.describe();
        // 高亮当前工具按钮，其它按钮恢复默认色。
        for(const entry of this.toolbarLabels) this.buttons.get(entry.label)?.setState(true,entry.kind === kind);
        this.drawTerrain();
        if(kind === 'remove') this.say(target ? '已选中拆除目标，点击「确认拆除」执行；取消不会拆除。' : '先点建筑，再点「确认拆除」。返还 50% 建材（向下取整），存货销毁。');
        else if(kind === 'browse') this.say('单指拖动浏览；点击查看建筑；双指缩放。');
        else this.say(kind === 'belt' ? '拖动预览整条传送带，确认后统一建造；末端方向可旋转。' : '点击网格预览，再点击确认建造。');
    }

    // 确认按钮分发：拆除走 remove，浏览给提示，其它走 build。
    private confirmAction(): void {
        if(this.pendingAction !== undefined){ this.say('正在执行，请稍候'); return; }
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
                this.submit({type: 'build', plans: this.plans});
            }else this.say(result.message);
        }
        this.describe();
    }

    // 刷新右侧检视面板：根据当前工具与选中状态显示建筑信息/拆除预览/建造预览/浏览提示。
    private describe(): void {
        if(!this.infoLabel || !this.world) return;
        if(this.confirmLabel) this.confirmLabel.string = this.selected === 'remove' ? '确认拆除' : '确认建造';
        const selectedBuilding = this.selection && this.world.at(this.selection);
        if(this.inspector){
            this.inspector.active=this.selected !== 'browse' || !!selectedBuilding;
            this.inspectorTitle!.string=this.selected === 'remove' ? '拆除预览' : this.selected === 'browse' ? '建筑状态' : definitions[this.selected].name;
            this.confirmLabel!.node.parent!.active=this.selected !== 'browse';
            const valid=this.selected === 'remove' ? !!this.selection && this.world.checkRemove(this.selection).ok
                : this.selected !== 'browse' && this.plans.length > 0 && this.world.checkBuild(this.plans).ok;
            this.buttons.get(this.confirmLabel!)?.setState(valid && this.pendingAction === undefined);
            if(this.pendingAction !== undefined) this.confirmLabel!.string='处理中…';
            const kind=this.selected === 'browse' ? selectedBuilding?.kind : this.selected;
            this.rotateLabel!.node.parent!.active=!!kind && !['remove','core','wall','router','junction','storage'].includes(kind);
            this.bendLabel!.node.parent!.active=this.selected === 'belt';
            this.removeLabel!.node.parent!.active=this.selected === 'browse' && !!selectedBuilding && selectedBuilding.kind !== 'core';
        }
        if(this.selected === 'browse' && selectedBuilding){
            this.infoLabel.string = `${definitions[selectedBuilding.kind].name}  ${arrows[selectedBuilding.direction]}\n${this.world.status(selectedBuilding)}\n生命 ${selectedBuilding.health}/${definitions[selectedBuilding.kind].health}`;
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
            const cost=items.map(item => {
                const amount=(definitions[this.selected as BuildingKind].cost[item] || 0)*this.plans.length;
                return amount ? `${amount}${itemNames[item]}` : '';
            }).filter(Boolean).join(' ');
            this.infoLabel.string = `${costText(this.selected)} / 个   ${arrows[this.direction]}\n${this.plans.length ? `预览 ${this.plans.length} 格 · 总计 ${cost}` : '点击地图选择位置'}\n${result ? result.ok ? '✓ 可以建造' : result.message : this.selected === 'drill' ? '需放在矿点上，箭头为输出方向' : this.selected === 'router' ? '自动轮流分流，不送回入口' : this.selected === 'crafter' ? '2 煤 → 1 石墨 / 2 秒' : '预览后确认，取消不扣费'}`;
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
        if(this.session?.outcome !== 'playing' || this.modal || this.pendingAction !== undefined) return;
        this.gesture = event.getAllTouches().length > 1;
        this.pinchDistance = 0;
        this.touchTravel = 0;
        this.dragStart = this.grid(event);
        if(!this.gesture && this.selected !== 'browse' && this.selected !== 'remove') this.preview(this.dragStart);
    }
    // 移动：多指走缩放与平移；单指在浏览模式拖动地图，其它模式刷新预览。
    private touchMove(event: EventTouch): void {
        if(this.session?.outcome !== 'playing' || this.modal || this.pendingAction !== undefined) return;
        const touches = event.getAllTouches();
        if(touches.length > 1){
            this.gesture = true; this.plans = []; this.describe();
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
        if(this.session?.outcome !== 'playing' || this.modal || this.pendingAction !== undefined) return;
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
        if(this.dragStart) this.lineStart={...this.dragStart};
        this.lineEnd={...end};
        this.plans = this.selected === 'belt' && this.lineStart ? beltLine(this.lineStart, end, this.direction,this.verticalFirst)
            : [{...end, kind: this.selected, direction: this.direction}];
        this.describe();
    }
    // 相机归位到当前模式的默认中心与缩放。
    private resetCamera(): void {
        this.center = this.stress ? {x:40,y:29} : this.crossroads ? {x:26,y:22} : {x:23,y:22.5};
        this.cell = Math.max(16,Math.min(this.stress ? 20 : this.crossroads ? 26 : 32,(this.height-190)/(this.crossroads ? 18 : 14)));
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
    private visible(p: Point): boolean { return Math.abs(p.x) < this.boardWidth/2-this.cell/2 && Math.abs(p.y) < this.boardHeight/2-this.cell/2; }

    // 重绘地形：背景、可见格子（含矿石/岩石），以及敌人出生点提示圈与朝向箭头。
    private drawTerrain(): void {
        if(!this.world || !this.terrain) return;
        const g = this.terrain; g.clear();
        g.fillColor = rgba(palette.bg); g.rect(-this.boardWidth/2,-this.boardHeight/2,this.boardWidth,this.boardHeight); g.fill();
        const halfX = Math.ceil(this.boardWidth/2/this.cell), halfY = Math.ceil(this.boardHeight/2/this.cell);
        for(let y=Math.floor(this.center.y)-halfY;y<=this.center.y+halfY;y++){
            for(let x=Math.floor(this.center.x)-halfX;x<=this.center.x+halfX;x++){
                const point = {x,y}, p = this.screen(point);
                if(!this.world.inBounds(point) || !this.visible(p)) continue;
                // 格子底色按地形类型区分：岩石、铜矿、煤矿、空地棋盘色。
                const ore = this.world.ore(point);
                g.fillColor = rgba(this.world.rock(point) ? '#9AAEA0' : ore === 'copper' ? '#DCC5A0' : ore === 'coal' ? '#ABBEB1' : (x+y)%2 ? '#DDE8D5' : '#D8E4CF');
                const gap=this.selected === 'browse' ? 0 : .6;
                g.rect(p.x-this.cell/2+gap,p.y-this.cell/2+gap,this.cell-gap*2,this.cell-gap*2); g.fill();
                if(ore){
                    // 矿石点缀：用两个小圆点暗示矿点位置。
                    g.fillColor = rgba(ore === 'copper' ? '#B47743' : '#4E6670');
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
        for(const marker of this.markers){
            const p=this.screen(marker.point);
            marker.node.active=this.visible(p) && (!this.session!.wavesStarted || this.selection?.x === marker.point.x && this.selection?.y === marker.point.y);
            marker.node.setPosition(Math.max(-this.boardWidth/2+44,Math.min(this.boardWidth/2-44,p.x)),p.y+this.cell*.8,0);
        }
        // 叠加层：先画炮塔射程圈，再画建造/拆除预览。
        const o = this.overlay; o.clear();
        if(this.successPoint && this.successTime>0){
            const p=this.screen(this.successPoint);
            if(this.visible(p)){ o.strokeColor=rgba(palette.green); o.lineWidth=2; o.circle(p.x,p.y,this.cell*(.5+.45-this.successTime)); o.stroke(); }
        }
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
        o.strokeColor = rgba(valid ? palette.green : palette.red); o.lineWidth = 2;
        for(const plan of this.plans){
            const p = this.screen(plan); if(!this.visible(p)) continue;
            o.rect(p.x-this.cell/2+2,p.y-this.cell/2+2,this.cell-4,this.cell-4); o.stroke();
            this.arrow(o,p.x,p.y,plan.direction,this.cell*0.24,valid ? palette.green : palette.red);
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
        buildingIcon(g,b.kind,p.x,p.y,size,b.direction);
        if(this.world!.tick-b.lastDamageTick < 6){
            g.strokeColor=rgba(palette.red); g.lineWidth=3;
            g.roundRect(p.x-size/2,p.y-size/2,size,size,4); g.stroke();
        }
        if((b.kind === 'turret' || b.kind === 'heavyTurret') && b.cargo.length === 0){
            g.fillColor=rgba(palette.panel); g.circle(p.x+size*.34,p.y+size*.34,5); g.fill();
            g.strokeColor=rgba(palette.amber); g.lineWidth=2;
            g.moveTo(p.x+size*.34,p.y+size*.24); g.lineTo(p.x+size*.34,p.y+size*.43); g.stroke();
        }
        // 血条：不满血时显示在建筑下方。
        if(b.health < definitions[b.kind].health){
            g.fillColor = rgba(palette.red); g.rect(p.x-size/2, p.y+size/2+2, size, 3); g.fill();
            g.fillColor = rgba(palette.mint); g.rect(p.x-size/2, p.y+size/2+2, size*b.health/definitions[b.kind].health, 3); g.fill();
        }
        // 货物点缀：最多显示 3 个，颜色按物品类型区分。
        const count = Math.min(3,b.cargo.length+b.output);
        for(let i=0;i<count;i++){
            const item = b.cargo[i]?.item || 'graphite';
            g.fillColor = rgba(item === 'copper' ? '#B96D35' : item === 'coal' ? '#263F4A' : '#667D89');
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
        const steps = this.session!.advance(delta, result => this.commandResult(result));
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
        this.successTime=Math.max(0,this.successTime-delta);
        this.toastTime=Math.max(0,this.toastTime-delta);
        if(this.statusLabel) this.statusLabel.node.active=this.toastTime>0;
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
        if(!this.lifeLabel) return;
        const world=this.world!, session=this.session!, waves=session.waves;
        this.lifeLabel.string=`核心 ${session.enemies.core.health}/${definitions.core.health}`;
        this.lifeLabel.color=rgba(session.enemies.core.health<definitions.core.health*.3 ? palette.red : palette.ink);
        this.inventoryLabel!.string=world.map.tutorial || this.crossroads ? `铜 ${world.inventory.copper}` : `铜 ${world.inventory.copper}\n煤 ${world.inventory.coal} · 石墨 ${world.inventory.graphite}`;
        this.pauseLabel!.string=session.clock.paused ? '继续' : '暂停';
        this.phaseLabel!.string=session.clock.paused ? 'Ⅱ 已暂停 · 可调整建设' : session.wavesStarted ? '防守中 · 随时可暂停建设' : '准备阶段 · 建立供给后开战';
        this.startLabel!.node.parent!.active=!!world.map.waveStart?.manual && !session.wavesStarted && session.outcome === 'playing';
        this.startLabel!.string=session.canStartDefense ? session.clock.paused ? '开始防守并继续' : '开始防守 →' : '完成供给后开战';
        this.buttons.get(this.startLabel!)?.setState(session.canStartDefense && this.pendingAction === undefined);
        const hints: Record<string,string>={mine:'① 在铜矿上建造钻头',deliver:'② 铺设传送带，将铜送入核心',supply:'③ 建造炮塔，并连接铜供弹线',ready:'✓ 供给就绪，可以开始防守'};
        if(!session.wavesStarted){
            const stage=session.tutorialStage;
            this.objectiveLabel!.string=`当前目标\n${stage ? hints[stage] || '建立供给' : '连接核心与炮塔，准备防线'}`;
        }else if(waves.waves.length){
            const next=waves.waves[waves.waveIndex];
            this.objectiveLabel!.string=waves.complete ? `清除剩余敌人 ${session.enemies.enemies.size}`
                : `波次 ${waves.waveIndex+1}/${waves.waves.length} · ${next.enemy === 'fast' ? '快速' : next.enemy === 'armored' ? '重甲' : '普通'} ×${next.count}\n下次出生 ${(waves.remainingTicks/20).toFixed(1)} 秒`;
        }else this.objectiveLabel!.string=this.stress ? '性能实验 · 合成负载' : `供给目标\n核心铜 ${Math.min(10,world.delivered.copper)}/10 · 石墨 ${Math.min(3,world.produced.graphite)}/3`;
        let empty=0;
        for(const b of world.buildings.values()) if((b.kind === 'turret' || b.kind === 'heavyTurret') && !b.cargo.length) empty++;
        this.alertLabel!.node.parent!.active=empty>0;
        this.alertLabel!.string=`! 空弹炮塔 ${empty} · 定位`;
        this.describe();
        if(session.outcome !== 'playing' && !this.resultShown){ this.resultShown=true; this.showResult(); }
    }

    private locateEmptyTurret(): void {
        const buildings=[...this.world!.buildings.values()].filter(b => (b.kind === 'turret' || b.kind === 'heavyTurret') && !b.cargo.length);
        if(!buildings.length) return;
        const index=buildings.findIndex(b => this.selection?.x === b.x && this.selection?.y === b.y);
        const b=buildings[(index+1)%buildings.length];
        this.choose('browse'); this.selection={x:b.x,y:b.y}; this.center={x:b.x,y:b.y};
        this.drawTerrain(); this.describe();
    }

    private showGoals(): void {
        this.session!.clock.pause(); this.processPaused();
        const world=this.world!, session=this.session!, ammo=session.turretAmmo(), condition=world.map.waveStart;
        const lines=['供给目标'];
        for(const item of items){
            if(condition?.delivered?.[item]) lines.push(`核心累计入库 ${itemNames[item]}：${world.delivered[item]} / ${condition.delivered[item]}`);
            if(condition?.ammo?.[item]) lines.push(`炮塔真实弹药 ${itemNames[item]}：${ammo[item]} / ${condition.ammo[item]}`);
        }
        const cap=world.map.preparation?.deliveryLimit.copper;
        if(cap && !session.wavesStarted) lines.push(world.preparationRemaining('copper') === 0 ? '核心暂时停收，继续准备炮塔供弹' : `准备阶段核心最多累计接收 ${cap} 铜`, '开战后解除接收上限');
        if(session.wavesStarted) lines.push(`空弹可点击地图告警定位`, `被毁建筑 ${world.lostBuildings}（不含主动拆除）`);
        lines.push('单指拖动浏览 · 双指平移缩放');
        this.dialog('任务与操作',lines.join('\n'),[{text:'返回建设',action:() => this.closeModal()}]);
    }

    private openMenu(): void {
        this.session!.clock.pause(); this.processPaused();
        this.dialog('已暂停','当前战斗进度不会保存。\n关闭菜单后可在暂停状态调整建设。',[
            {text:'继续游戏',action:() => { this.closeModal(); if(this.session!.outcome === 'playing') this.session!.clock.resume(); }},
            {text:'重开本关',action:() => this.confirmLeave('Battle')},
            {text:'返回主菜单',action:() => this.confirmLeave('Menu')},
            {text:'返回建设',action:() => this.closeModal()}
        ]);
    }

    private confirmLeave(scene: string): void {
        this.dialog(scene === 'Battle' ? '重开本关？' : '离开本局？','当前战斗进度不会保存。',[
            {text:'确认',action:() => this.go(scene)}, {text:'取消',action:() => this.openMenu()}
        ]);
    }

    private showResult(): void {
        const session=this.session!;
        const actions=[{text:'重试本关',action:() => this.go('Battle')},{text:'返回主菜单',action:() => this.go('Menu')}];
        if(session.outcome === 'victory' && this.world!.map.tutorial) actions.unshift({text:'进入第二关 →',action:() => {
            this.platform.write('supply.mode','crossroads'); this.go('Battle');
        }});
        this.dialog(session.outcome === 'victory' ? '防守成功！' : '核心已被摧毁',
            `核心生命 ${session.enemies.core.health} / ${definitions.core.health}\n击杀 ${session.combat.kills} · 耗弹 ${session.combat.shots}\n被毁建筑 ${this.world!.lostBuildings}`,actions);
    }

    private closeModal(): void { this.modal?.destroy(); this.modal=undefined; }

    private dialog(title: string, message: string, actions: Array<{text:string;action:()=>void}>): void {
        this.closeModal();
        const root=this.uiRoot!;
        this.modal=this.rect(root,'Modal backdrop',0,0,this.width,this.height,'#263F4ADD'); this.blockInput(this.modal);
        const width=Math.min(520,this.width-this.safeLeft-this.safeRight-32);
        const height=Math.min(this.height-this.safeTop-this.safeBottom-24,440);
        const card=this.rect(this.modal,'Dialog',0,0,width,height,palette.panel);
        this.text(card,title,0,height/2-36,26,palette.ink,width-32,40);
        const rows=Math.ceil(actions.length/2), textHeight=height-102-rows*60;
        this.text(card,message,0,rows*30-14,18,palette.muted,width-40,textHeight);
        actions.forEach((action,i) => {
            const pair=actions.length === 1, w=pair ? width-40 : (width-52)/2;
            this.button(action.text,pair ? 0 : (i%2 ? 1 : -1)*(w+12)/2,-height/2+36+Math.floor(i/2)*60,w,48,action.action,
                i===0 ? palette.mint : palette.panel,i===0 ? palette.white : palette.ink,card);
        });
    }

    private blockInput(node: Node): void {
        for(const type of [Node.EventType.TOUCH_START,Node.EventType.TOUCH_MOVE,Node.EventType.TOUCH_END,Node.EventType.TOUCH_CANCEL]){
            node.on(type,(event: EventTouch) => { event.propagationStopped=true; });
        }
    }

    // 提交命令到会话：战斗已结束则拒绝，否则入队并按暂停状态提示执行时机。
    private submit(command: Command): boolean {
        const session=this.session!;
        if(session.outcome !== 'playing'){ this.say(session.outcome === 'victory' ? '战斗已经胜利，请重开。' : '核心已被摧毁，请重开。'); return false; }
        if(this.pendingAction !== undefined) return false;
        this.pendingPlans=command.type === 'build' ? command.plans.map(p => ({...p})) : [];
        this.pendingAction=session.enqueue(command);
        this.say('操作已提交');
        if(session.clock.paused){
            const sequence=this.pendingAction;
            const results=session.flushPaused();
            const result=results.find(r => r.sequence === sequence);
            for(const entry of results) this.commandResult(entry);
            if(command.type === 'startDefense' && result?.ok) session.clock.resume();
            this.drawTerrain(); this.drawWorld();
            return !!result?.ok;
        }
        return true;
    }

    private processPaused(): void {
        if(!this.session) return;
        for(const result of this.session.flushPaused()) this.commandResult(result);
    }

    private commandResult(result: CommandResult): void {
        if(result.sequence === this.pendingAction){
            this.pendingAction=undefined;
            if(result.ok){
                if(this.pendingPlans.length){ this.successPoint=this.pendingPlans[this.pendingPlans.length-1]; this.successTime=.45; this.plans=[]; }
            }else if(this.pendingPlans.length) this.plans=this.pendingPlans;
            this.pendingPlans=[];
        }
        this.say(result.message); this.describe();
    }

    private say(message: string): void {
        if(this.statusLabel){ this.statusLabel.string=message; if(this.statusLabel.node) this.statusLabel.node.active=true; }
        this.toastTime=4;
    }
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
        label.overflow=Label.Overflow.CLAMP;label.enableWrapText=true;return label;
    }
    // 创建按钮：底色矩形 + 文本 + 触摸结束回调，返回内部 Label 便于后续更新文字/颜色。
    private button(value:string,x:number,y:number,width:number,height:number,callback:()=>void,color=palette.panel,ink=palette.ink,parent=this.uiRoot || this.node):Label {
        const node=this.rect(parent,value,x,y,width,height,color);
        const label=this.text(node,value,0,0,18,ink,width-12,height-4);
        this.buttons.set(label,new GameButton(label,color,ink,callback));
        return label;
    }
    // 组件销毁：标记已销毁、清理平台回调、取消所有调度。
    onDestroy(): void { this.disposed=true;this.cleanup?.();view.off('canvas-resize',this.resized,this);this.unscheduleAllCallbacks(); }
}
