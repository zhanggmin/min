// 供给前线 / 关卡编辑器：可视化编辑 MapData，支持放置地形/建筑、调整尺寸与初始资源、校验并导出 JSON。
import {_decorator, Color, Component, director, EventTouch, Graphics, HorizontalTextAlignment, JsonAsset,
    Label, Layers, Node, ResolutionPolicy, resources, UITransform, Vec3, view} from 'cc';
import {BuildPlan, BuildingKind, definitions, Item, itemNames, items, Point, vectors} from '../domain/Content';
import {MapData, validateMap} from '../domain/MapData';
import {PlatformService} from '../platform/PlatformService';
import {ArtLayer, buildingAngle, loadGameArt} from './GameArt';

const {ccclass} = _decorator;
// 复用 GameApp 的色板与工具函数，保持编辑器与战斗界面视觉一致。
const palette = {bg: '#101a23', panel: '#192833', border: '#2e4552', ink: '#e5efec', muted: '#8da6b0', mint: '#73e0c1', amber: '#edba75', red: '#e78378'};
const rgba = (hex: string) => new Color().fromHEX(hex);
const arrows = ['→', '↑', '←', '↓'];
// 编辑工具：地形类 + 橡皮 + 建筑类。
type Tool = 'rock' | 'copper' | 'coal' | 'spawn' | 'erase' | BuildingKind;
const terrainTools: Array<{tool: Tool; name: string}> = [
    {tool: 'rock', name: '岩石'}, {tool: 'copper', name: '铜矿'}, {tool: 'coal', name: '煤矿'},
    {tool: 'spawn', name: '出生点'}, {tool: 'erase', name: '橡皮'}
];
const buildingKinds: BuildingKind[] = ['core', 'drill', 'belt', 'router', 'junction', 'storage', 'crafter', 'turret', 'heavyTurret', 'wall'];

@ccclass('MapEditor')
export class MapEditor extends Component {
    private map!: MapData;                                  // 正在编辑的地图数据
    private rocks = new Set<number>();                      // 岩石格子索引缓存
    private ores = new Map<number, Item>();                 // 矿点格子索引缓存
    private spawns = new Set<number>();                     // 出生点格子索引缓存
    private buildings = new Map<number, BuildPlan>();       // 建筑格子索引缓存
    private tool: Tool = 'rock';                            // 当前工具
    private direction = 0;                                  // 建筑方向（0-3 顺时针）
    private board?: Node;                                   // 视口节点
    private terrainArt?: ArtLayer;
    private worldArt?: ArtLayer;
    private terrain?: Graphics;                             // 地形层
    private drawing?: Graphics;                             // 建筑层
    private overlay?: Graphics;                             // 预览/光标层
    private statusLabel?: Label;                            // 底部状态文本
    private infoLabel?: Label;                              // 顶部地图信息文本
    private toolLabel?: Label;                              // 当前工具显示
    private cell = 24;                                      // 单格像素
    private center = {x: 16, y: 16};                        // 相机中心（格子坐标）
    private gesture = false;                               // 多指手势中
    private pinchDistance = 0;                             // 双指上一帧距离
    private touchTravel = 0;                               // 单指累计移动距离
    private dragStart?: Point;                             // 拖动起点
    private lastPaint?: Point;                             // 上次绘制格子，避免重复绘制
    private disposed = false;                              // 已销毁
    private toolbarLabels: Array<{tool: Tool; label: Label}> = []; // 工具按钮与其类型，用于高亮

    private portrait = false;
    private width = 1200;
    private height = 720;
    private halfX = 426;
    private halfY = 240;
    private top = 360;
    private bottom = -360;

    onLoad(): void {
        const frame = view.getFrameSize();
        this.portrait = frame.height > frame.width;
        if(this.portrait){
            this.width = 600; this.height = 600*frame.height/Math.max(1,frame.width);
            const safe = new PlatformService().safeInsets(), scale = 600/Math.max(1,frame.width);
            this.top = this.height/2-safe.top*scale;
            this.bottom = -this.height/2+safe.bottom*scale;
            this.halfX = 280; this.halfY = Math.max(100,(this.top-this.bottom-576)/2);
        }
        view.setDesignResolutionSize(this.width, this.height, ResolutionPolicy.SHOW_ALL);
        this.newMap();
    }

    async start(): Promise<void> {
        await loadGameArt();
        if(this.disposed) return;
        this.rect(this.node, 'Background', 0, 0, this.width, this.height, palette.bg);
        this.editorUI();
    }

    // 新建 32×32 空地图，中心放一个核心，开放除核心外的所有建筑。
    private newMap(): void {
        this.map = {
            schemaVersion: 1, mapId: `custom-${Date.now()}`, revision: 1, name: '自定义地图',
            width: 32, height: 32,
            initialResources: {copper: 64, coal: 0, graphite: 0},
            ores: [], rocks: [], spawns: [],
            buildings: [{kind: 'core', x: 16, y: 16, direction: 0}],
            allowed: ['drill', 'belt', 'router', 'junction', 'storage', 'crafter', 'turret', 'heavyTurret', 'wall']
        };
        this.rebuild();
    }

    // 从 map 数组重建索引缓存（载入/清空/尺寸变更后调用）。
    private rebuild(): void {
        this.rocks.clear(); this.ores.clear(); this.spawns.clear(); this.buildings.clear();
        for(const p of this.map.rocks) this.rocks.add(this.key(p));
        for(const p of this.map.ores) this.ores.set(this.key(p), p.item);
        for(const p of this.map.spawns) this.spawns.add(this.key(p));
        for(const b of this.map.buildings) this.buildings.set(this.key(b), b);
        this.center = {x: this.map.width / 2, y: this.map.height / 2};
    }

    private key(p: Point): number { return p.y * this.map.width + p.x; }
    private unkey(k: number): Point { return {x: k % this.map.width, y: Math.floor(k / this.map.width)}; }
    private inBounds(p: Point): boolean { return p.x >= 0 && p.y >= 0 && p.x < this.map.width && p.y < this.map.height; }

    // 搭建编辑器界面：顶部工具条、视口、右侧建筑面板、底部地形工具栏。
    private editorUI(): void {
        if(!this.portrait){
        this.text(this.node, '关卡编辑器', -468, 306, 29, palette.ink, 220);
        this.button('菜单', 514, 306, 100, 46, () => director.loadScene('Menu'));
        this.button('新建', 200, 306, 90, 46, () => { this.newMap(); this.refreshAll(); this.say('已新建空地图'); });
        this.button('加载示例', 294, 306, 120, 46, () => this.loadSample());
        this.button('校验', 418, 306, 80, 46, () => this.validate());
        this.button('导出', 488, 306, 80, 46, () => this.export(), palette.mint, palette.bg);
        this.infoLabel = this.text(this.node, '', -138, 248, 19, palette.muted, 850);
        }
        // 视口：三层 Graphics，触摸交互统一在 board 处理。
        this.board = this.make(this.node, 'Viewport', this.portrait ? 0 : -138, this.portrait ? this.top-160-this.halfY : -17, this.halfX*2, this.halfY*2);
        this.rect(this.board, 'World ground', 0, 0, this.halfX*2, this.halfY*2, '#272E2D');
        this.terrainArt = new ArtLayer(this.board, 'Terrain artwork');
        this.terrain = this.make(this.board, 'Terrain', 0, 0, this.halfX*2, this.halfY*2).addComponent(Graphics);
        this.worldArt = new ArtLayer(this.board, 'World artwork');
        this.drawing = this.make(this.board, 'Buildings', 0, 0, this.halfX*2, this.halfY*2).addComponent(Graphics);
        this.overlay = this.make(this.board, 'Overlay', 0, 0, this.halfX*2, this.halfY*2).addComponent(Graphics);
        this.board.on(Node.EventType.TOUCH_START, this.touchStart, this);
        this.board.on(Node.EventType.TOUCH_MOVE, this.touchMove, this);
        this.board.on(Node.EventType.TOUCH_END, this.touchEnd, this);
        this.board.on(Node.EventType.TOUCH_CANCEL, () => {
            this.dragStart = undefined; this.lastPaint = undefined; this.gesture = true; this.pinchDistance = 0;
        }, this);
        if(this.portrait){ this.portraitControls(); this.refreshAll(); return; }
        // 右侧面板：建筑工具垂直列表 + 方向旋转 + 地图属性。
        this.rect(this.node, 'Panel', 440, -5, 252, 504, palette.panel);
        this.text(this.node, '建筑工具', 440, 230, 22, palette.ink, 220);
        this.toolLabel = this.text(this.node, '岩石', 440, 200, 18, palette.mint, 220);
        let y = 162;
        for(const kind of buildingKinds){
            const label = this.button(definitions[kind].name, 440, y, 214, 32, () => this.choose(kind));
            label.fontSize = 16; label.lineHeight = 20;
            this.toolbarLabels.push({tool: kind, label});
            y -= 34;
        }
        this.button('旋转 ↻', 440, y - 4, 214, 40, () => {
            this.direction = (this.direction + 1) % 4;
            this.say(`方向：${arrows[this.direction]}`);
        });
        y -= 50;
        // 地图属性：宽高 +/−、初始资源 +/−。
        this.text(this.node, '地图属性', 440, y, 18, palette.ink, 220);
        y -= 28;
        this.button('宽 −', 395, y, 50, 32, () => this.resize(-1, 0));
        this.button('宽 +', 485, y, 50, 32, () => this.resize(1, 0));
        y -= 34;
        this.button('高 −', 395, y, 50, 32, () => this.resize(0, -1));
        this.button('高 +', 485, y, 50, 32, () => this.resize(0, 1));
        y -= 34;
        this.text(this.node, '初始资源', 440, y, 16, palette.muted, 220);
        y -= 26;
        for(const [i, item] of items.entries()){
            const dy = y - i * 30;
            this.text(this.node, itemNames[item], 410, dy, 15, palette.ink, 60, 28);
            this.button('−', 460, dy, 40, 28, () => this.adjustResource(item, -8));
            this.button('+', 500, dy, 40, 28, () => this.adjustResource(item, 8));
        }
        // 底部地形工具栏 + 缩放/清空。
        for(let i = 0; i < terrainTools.length; i++){
            const {tool, name} = terrainTools[i];
            const label = this.button(name, -504 + i * 108, -310, 100, 56, () => this.choose(tool));
            label.fontSize = 18;
            this.toolbarLabels.push({tool, label});
        }
        this.button('－', 58, -310, 46, 56, () => this.zoom(-4));
        this.button('＋', 110, -310, 46, 56, () => this.zoom(4));
        this.button('归位', 180, -310, 70, 56, () => {
            this.center = {x: this.map.width / 2, y: this.map.height / 2}; this.drawTerrain();
        });
        this.button('清空', 258, -310, 70, 56, () => this.clearAll());
        this.statusLabel = this.text(this.node,
            '选择工具，点击或拖动地图放置。双指缩放浏览。完成后点「校验」再「导出」。',
            -138, -270, 16, palette.amber, 850);
        this.refreshAll();
    }

    private portraitControls(): void {
        this.text(this.node, '关卡编辑器', -140, this.top-32, 26, palette.ink, 280, 44);
        this.button('菜单', 230, this.top-32, 100, 44, () => director.loadScene('Menu'));
        const actions = [
            {name:'新建', run:() => { this.newMap(); this.refreshAll(); }},
            {name:'加载示例', run:() => this.loadSample()},
            {name:'校验', run:() => this.validate()}, {name:'导出', run:() => this.export()}
        ];
        actions.forEach((a,i) => this.button(a.name,-210+i*140,this.top-84,128,44,a.run));
        this.infoLabel=this.text(this.node,'',0,this.top-132,16,palette.muted,560,44);
        this.toolLabel=this.text(this.node,'',-180,this.bottom+390,18,palette.mint,180,32);
        this.statusLabel=this.text(this.node,'双指缩放浏览，单指绘制',80,this.bottom+390,14,palette.amber,360,36);
        const tools: Array<{tool:Tool;name:string}> = [...terrainTools,...buildingKinds.map(tool => ({tool,name:definitions[tool].name}))];
        tools.forEach((entry,i) => {
            const label=this.button(entry.name,-224+i%5*112,this.bottom+344-Math.floor(i/5)*48,104,42,() => this.choose(entry.tool));
            label.fontSize=16; this.toolbarLabels.push({tool:entry.tool,label});
        });
        const controls = [
            {name:'旋转',run:() => { this.direction=(this.direction+1)%4; this.say(`方向：${arrows[this.direction]}`); }},
            {name:'－',run:() => this.zoom(-4)}, {name:'＋',run:() => this.zoom(4)},
            {name:'归位',run:() => { this.center={x:this.map.width/2,y:this.map.height/2}; this.refreshAll(); }},
            {name:'清空',run:() => this.clearAll()}
        ];
        controls.forEach((a,i) => this.button(a.name,-224+i*112,this.bottom+188,104,42,a.run));
        ['宽 −','宽 +','高 −','高 +'].forEach((name,i) => this.button(name,-210+i*140,this.bottom+134,128,42,() => this.resize(i<2 ? (i ? 1 : -1) : 0,i>=2 ? (i===3 ? 1 : -1) : 0)));
        items.forEach((item,i) => {
            const x=-190+i*190;
            this.text(this.node,itemNames[item],x,this.bottom+88,16,palette.muted,180,28);
            this.button('−',x-44,this.bottom+44,80,42,() => this.adjustResource(item,-8));
            this.button('+',x+44,this.bottom+44,80,42,() => this.adjustResource(item,8));
        });
    }

    // 切换工具并刷新高亮。
    private choose(tool: Tool): void {
        this.tool = tool;
        const name = tool === 'rock' ? '岩石' : tool === 'copper' ? '铜矿' : tool === 'coal' ? '煤矿'
            : tool === 'spawn' ? '出生点' : tool === 'erase' ? '橡皮' : definitions[tool].name;
        this.toolLabel!.string = name;
        for(const entry of this.toolbarLabels) entry.label.color = rgba(entry.tool === tool ? palette.mint : palette.ink);
        this.say(`已选：${name}${buildingKinds.includes(tool as BuildingKind) ? ` ${arrows[this.direction]}` : ''}`);
    }

    // 调整地图尺寸：缩小时丢弃越界内容；若无核心则补一个。
    private resize(dx: number, dy: number): void {
        const w = this.map.width + dx, h = this.map.height + dy;
        if(w < 8 || w > 96 || h < 8 || h > 96){ this.say('尺寸需在 8～96 之间'); return; }
        this.map.width = w; this.map.height = h;
        const inBounds = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
        this.map.rocks = this.map.rocks.filter(inBounds);
        this.map.ores = this.map.ores.filter(inBounds);
        this.map.spawns = this.map.spawns.filter(inBounds);
        this.map.buildings = this.map.buildings.filter(inBounds);
        if(!this.map.buildings.some(b => b.kind === 'core')){
            this.map.buildings.push({kind: 'core', x: Math.floor(w / 2), y: Math.floor(h / 2), direction: 0});
        }
        this.rebuild(); this.refreshAll();
        this.say(`地图尺寸：${w} × ${h}`);
    }

    private adjustResource(item: Item, delta: number): void {
        this.map.initialResources[item] = Math.max(0, this.map.initialResources[item] + delta);
        this.refreshInfo();
        this.say(`${itemNames[item]} ${this.map.initialResources[item]}`);
    }

    // 在指定格执行当前工具：地形工具替换内容，建筑工具独占格子，橡皮清空。
    private paint(p: Point): void {
        if(!this.inBounds(p)) return;
        const k = this.key(p);
        const tool = this.tool;
        if(tool === 'erase'){
            this.rocks.delete(k); this.ores.delete(k); this.spawns.delete(k); this.buildings.delete(k);
        }else if(tool === 'rock'){
            this.ores.delete(k); this.spawns.delete(k); this.buildings.delete(k); this.rocks.add(k);
        }else if(tool === 'copper' || tool === 'coal'){
            this.rocks.delete(k); this.spawns.delete(k); this.buildings.delete(k); this.ores.set(k, tool);
        }else if(tool === 'spawn'){
            this.rocks.delete(k); this.ores.delete(k); this.buildings.delete(k); this.spawns.add(k);
        }else{
            // 建筑：钻头需要矿点，若格子无矿则自动补一个铜矿；放置 core 前先删除旧核心。
            this.rocks.delete(k); this.ores.delete(k); this.spawns.delete(k);
            if(tool === 'drill' && !this.ores.has(k)){
                this.ores.set(k, 'copper'); this.map.ores.push({x: p.x, y: p.y, item: 'copper'});
            }
            if(tool === 'core'){
                for(const [ck, b] of this.buildings) if(b.kind === 'core') this.buildings.delete(ck);
            }
            this.buildings.set(k, {x: p.x, y: p.y, kind: tool, direction: this.direction});
        }
        this.syncMap();
        this.drawTerrain(); this.drawWorld(); this.refreshInfo();
    }

    // 将索引缓存同步回 map 数组，供校验/导出使用。
    private syncMap(): void {
        this.map.rocks = []; this.map.ores = []; this.map.spawns = []; this.map.buildings = [];
        for(const k of this.rocks) this.map.rocks.push(this.unkey(k));
        for(const [k, item] of this.ores) this.map.ores.push({...this.unkey(k), item});
        for(const k of this.spawns) this.map.spawns.push(this.unkey(k));
        for(const [, b] of this.buildings) this.map.buildings.push({...b});
    }

    // 校验地图：调用域层的 validateMap 并显示结果。
    private validate(): void {
        this.syncMap();
        try {
            validateMap(this.map);
            this.say(`✓ 校验通过：${this.map.width}×${this.map.height}，建筑 ${this.map.buildings.length}，矿点 ${this.map.ores.length}，出生点 ${this.map.spawns.length}`);
        } catch(error){ this.say(`✗ ${String(error)}`); }
    }

    // 导出 JSON：浏览器下载文件，微信环境存入 storage。
    private export(): void {
        this.syncMap();
        try { validateMap(this.map); }
        catch(error){ this.say(`校验失败，无法导出：${String(error)}`); return; }
        const json = JSON.stringify(this.map, null, 2);
        // 微信小游戏：保存到 storage，提示用户用开发者工具查看。
        const wxRuntime = (globalThis as {wx?: {setStorageSync: (k: string, v: string) => void}}).wx;
        if(wxRuntime?.setStorageSync){
            wxRuntime.setStorageSync('editor.export', json);
            this.say('已保存到微信 storage（key: editor.export）');
            return;
        }
        // 浏览器：触发文件下载。
        const blob = new Blob([json], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${this.map.mapId}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        this.say(`已导出 ${this.map.mapId}.json`);
    }

    // 加载 copper-tutorial 示例作为编辑起点。
    private loadSample(): void {
        resources.load('maps/copper-tutorial', JsonAsset, (error, asset) => {
            if(this.disposed) return;
            if(error){ this.say(`加载失败：${error.message}`); return; }
            this.map = JSON.parse(JSON.stringify(asset.json)) as MapData;
            this.rebuild(); this.refreshAll();
            this.say('已载入示例：亲手建立供给');
        });
    }

    // 清空所有地形与建筑，保留核心。
    private clearAll(): void {
        const core = this.map.buildings.find(b => b.kind === 'core');
        this.map.rocks = []; this.map.ores = []; this.map.spawns = [];
        this.map.buildings = core ? [core] : [];
        this.rebuild(); this.refreshAll();
        this.say('已清空（保留核心）');
    }

    // 相机与坐标换算，逻辑与 GameApp 一致以便编辑/战斗视图手感统一。
    private clampCamera(): void {
        this.center.x = Math.max(0, Math.min(this.map.width, this.center.x));
        this.center.y = Math.max(0, Math.min(this.map.height, this.center.y));
    }
    private screen(p: Point): Point { return {x: (p.x + 0.5 - this.center.x) * this.cell, y: (p.y + 0.5 - this.center.y) * this.cell}; }
    private visible(p: Point): boolean { return Math.abs(p.x) < this.halfX - this.cell / 2 && Math.abs(p.y) < this.halfY - this.cell / 2; }
    private zoom(d: number): void { this.cell = Math.max(16, Math.min(48, this.cell + d)); this.drawTerrain(); }
    private local(event: EventTouch): Vec3 {
        const p = event.getUILocation();
        return this.board!.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(p.x, p.y));
    }
    private grid(event: EventTouch): Point {
        const p = this.local(event);
        return {x: Math.floor(p.x / this.cell + this.center.x), y: Math.floor(p.y / this.cell + this.center.y)};
    }

    // 触摸：多指缩放/平移；单指点击或拖动连续绘制。
    private touchStart(event: EventTouch): void {
        this.gesture = event.getAllTouches().length > 1;
        this.pinchDistance = 0; this.touchTravel = 0;
        this.dragStart = this.grid(event);
        if(!this.gesture){ this.paint(this.dragStart); this.lastPaint = this.dragStart; }
    }
    private touchMove(event: EventTouch): void {
        const touches = event.getAllTouches();
        if(touches.length > 1){
            this.gesture = true;
            const a = touches[0].getUILocation(), b = touches[1].getUILocation();
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if(this.pinchDistance > 0) this.cell = Math.max(16, Math.min(48, this.cell * d / this.pinchDistance));
            this.pinchDistance = d;
            const delta = event.getUIDelta();
            this.center.x -= delta.x / this.cell / 2; this.center.y -= delta.y / this.cell / 2;
            this.clampCamera(); this.drawTerrain(); return;
        }
        if(this.gesture) return;
        const p = this.grid(event);
        const delta = event.getUIDelta();
        this.touchTravel += Math.hypot(delta.x, delta.y);
        // 拖动绘制：每当进入新格子就再画一次，实现连续涂刷。
        if(!this.lastPaint || this.lastPaint.x !== p.x || this.lastPaint.y !== p.y){
            this.paint(p); this.lastPaint = p;
        }
    }
    private touchEnd(_event: EventTouch): void {
        this.dragStart = undefined; this.lastPaint = undefined; this.pinchDistance = 0;
    }

    // 重绘地形：背景、可见格子（岩石/矿/棋盘空地）、出生点红圈、网格线。
    private drawTerrain(): void {
        if(!this.terrain) return;
        const g = this.terrain; g.clear();
        this.terrainArt?.begin();
        const halfX = Math.ceil(this.halfX / this.cell), halfY = Math.ceil(this.halfY / this.cell);
        for(let y = Math.floor(this.center.y) - halfY; y <= this.center.y + halfY; y++){
            for(let x = Math.floor(this.center.x) - halfX; x <= this.center.x + halfX; x++){
                const point = {x, y}, p = this.screen(point);
                if(!this.inBounds(point) || !this.visible(p)) continue;
                const k = this.key(point);
                const ore = this.ores.get(k);
                if(this.terrainArt?.draw(this.rocks.has(k) ? 'rock' : ore === 'copper' ? 'copper' : ore === 'coal' ? 'coal' : 'ground', p.x, p.y, this.cell+.25)) continue;
                g.fillColor = rgba(this.rocks.has(k) ? '#35454f' : ore === 'copper' ? '#5d4937' : ore === 'coal' ? '#33434d' : (x + y) % 2 ? '#192832' : '#1c2d37');
                g.rect(p.x - this.cell / 2 + 1, p.y - this.cell / 2 + 1, this.cell - 2, this.cell - 2); g.fill();
                if(ore){
                    g.fillColor = rgba(ore === 'copper' ? '#a27c52' : '#677984');
                    g.circle(p.x - 6, p.y + 5, 3); g.circle(p.x + 5, p.y - 4, 4); g.fill();
                }
            }
        }
        this.terrainArt?.end();
        // 出生点：红圈提示。
        for(const s of this.spawns){
            const p = this.screen(this.unkey(s));
            if(!this.visible(p)) continue;
            g.strokeColor = rgba(palette.red); g.lineWidth = 3;
            g.circle(p.x, p.y, this.cell * 0.4); g.stroke();
        }
        // 网格线：帮助定位格子边界。
        g.strokeColor = rgba('#1a2630'); g.lineWidth = 0.5;
        for(let x = Math.floor(this.center.x) - halfX; x <= this.center.x + halfX; x++){
            const p = this.screen({x, y: 0});
            g.moveTo(p.x - this.cell / 2, -this.halfY); g.lineTo(p.x - this.cell / 2, this.halfY);
        }
        for(let y = Math.floor(this.center.y) - halfY; y <= this.center.y + halfY; y++){
            const p = this.screen({x: 0, y});
            g.moveTo(-this.halfX, p.y - this.cell / 2); g.lineTo(this.halfX, p.y - this.cell / 2);
        }
        g.stroke();
    }

    // 重绘建筑：与 GameApp.drawBuilding 风格一致，但用 BuildPlan（无运行时状态）。
    private drawWorld(): void {
        if(!this.drawing || !this.overlay) return;
        const g = this.drawing; g.clear(); const o = this.overlay; o.clear();
        this.worldArt?.begin();
        for(const [, b] of this.buildings){
            const p = this.screen(b); if(!this.visible(p)) continue;
            this.drawBuilding(g, b, p);
        }
        this.worldArt?.end();
        // 光标提示：在最近绘制格上画琥珀色边框。
        if(this.dragStart){
            const p = this.screen(this.dragStart);
            if(this.visible(p)){
                o.strokeColor = rgba(palette.amber); o.lineWidth = 2;
                o.rect(p.x - this.cell / 2 + 2, p.y - this.cell / 2 + 2, this.cell - 4, this.cell - 4); o.stroke();
            }
        }
    }

    // 绘制单个建筑：底色 + 类型图标（与 GameApp.drawBuilding 风格一致，但无血条/货物）。
    private drawBuilding(g: Graphics, b: BuildPlan, p: Point): void {
        if(this.worldArt?.draw(b.kind,p.x,p.y,this.cell*.96,buildingAngle(b.kind,b.direction))) return;
        const size = this.cell * 0.78;
        g.fillColor = rgba(definitions[b.kind].color);
        g.roundRect(p.x - size / 2, p.y - size / 2, size, size, 3); g.fill();
        g.strokeColor = rgba('#15232d'); g.lineWidth = 2;
        if(b.kind === 'core'){
            g.rect(p.x - size * 0.28, p.y - size * 0.28, size * 0.56, size * 0.56); g.stroke();
            g.fillColor = rgba('#e5fff3'); g.circle(p.x, p.y, size * 0.12); g.fill();
        }else if(b.kind === 'drill'){
            g.moveTo(p.x - size * 0.3, p.y - size * 0.3); g.lineTo(p.x + size * 0.3, p.y + size * 0.3);
            g.moveTo(p.x + size * 0.3, p.y - size * 0.3); g.lineTo(p.x - size * 0.3, p.y + size * 0.3); g.stroke();
            const v = vectors[b.direction];
            this.arrow(g, p.x + v.x * size * .32, p.y + v.y * size * .32, b.direction, size * .16, '#fff4d8');
        }else if(b.kind === 'junction'){
            g.moveTo(p.x - size * .4, p.y); g.lineTo(p.x + size * .4, p.y);
            g.moveTo(p.x, p.y - size * .4); g.lineTo(p.x, p.y + size * .4); g.stroke();
        }else if(b.kind === 'crafter' || b.kind === 'router'){
            g.circle(p.x, p.y, size * 0.26); g.stroke();
        }else if(b.kind === 'turret' || b.kind === 'heavyTurret'){
            const scale = b.kind === 'heavyTurret' ? 0.34 : 0.27;
            g.circle(p.x, p.y, size * scale); g.stroke();
            g.moveTo(p.x, p.y); g.lineTo(p.x + size * .38, p.y); g.stroke();
        }else this.arrow(g, p.x, p.y, b.direction, size * 0.27, '#203746');
    }

    // 方向箭头：与 GameApp.arrow 一致，供建筑图标与钻头输出方向使用。
    private arrow(g: Graphics, x: number, y: number, direction: number, size: number, color: string): void {
        const v = vectors[direction], side = {x: -v.y, y: v.x}; g.strokeColor = rgba(color); g.lineWidth = 2;
        g.moveTo(x - v.x * size, y - v.y * size); g.lineTo(x + v.x * size, y + v.y * size);
        g.moveTo(x + side.x * size * .6, y + side.y * size * .6); g.lineTo(x + v.x * size, y + v.y * size);
        g.lineTo(x - side.x * size * .6, y - side.y * size * .6); g.stroke();
    }

    // 刷新全部视图与信息。
    private refreshAll(): void { this.drawTerrain(); this.drawWorld(); this.refreshInfo(); this.choose(this.tool); }
    // 顶部地图信息：尺寸、各类对象数量、核心位置。
    private refreshInfo(): void {
        if(!this.infoLabel) return;
        const core = this.map.buildings.find(b => b.kind === 'core');
        this.infoLabel.string = `${this.map.name} · ${this.map.width}×${this.map.height} · 建筑 ${this.map.buildings.length} · 矿点 ${this.map.ores.length} · 岩石 ${this.map.rocks.length} · 出生点 ${this.map.spawns.length} · 核心 ${core ? `(${core.x},${core.y})` : '无'}`;
    }
    // 更新底部状态文本。
    private say(m: string): void { if(this.statusLabel) this.statusLabel.string = m; }

    // UI 工具：与 GameApp 同构，便于复用布局风格。
    private make(parent: Node, name: string, x: number, y: number, w: number, h: number): Node {
        const n = new Node(name); n.layer = Layers.Enum.UI_2D; n.setParent(parent); n.setPosition(x, y, 0);
        n.addComponent(UITransform).setContentSize(w, h); return n;
    }
    private rect(parent: Node, name: string, x: number, y: number, w: number, h: number, color: string): Node {
        const n = this.make(parent, name, x, y, w, h), g = n.addComponent(Graphics);
        g.fillColor = rgba(color); g.roundRect(-w / 2, -h / 2, w, h, 8); g.fill(); return n;
    }
    private text(parent: Node, value: string, x: number, y: number, size: number, color: string, w = 600, h = 100): Label {
        const label = this.make(parent, 'Text', x, y, w, h).addComponent(Label);
        label.string = value; label.fontSize = size; label.lineHeight = size * 1.45; label.color = rgba(color);
        label.horizontalAlign = HorizontalTextAlignment.CENTER; label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK; label.enableWrapText = true; return label;
    }
    private button(value: string, x: number, y: number, w: number, h: number, cb: () => void, color = palette.border, ink = palette.ink): Label {
        const node = this.rect(this.node, value, x, y, w, h, color);
        const label = this.text(node, value, 0, 0, 19, ink, w - 10, h - 4);
        node.on(Node.EventType.TOUCH_END, (event: EventTouch) => { event.propagationStopped = true; cb(); });
        return label;
    }

    onDestroy(): void { this.disposed = true; this.unscheduleAllCallbacks(); }
}