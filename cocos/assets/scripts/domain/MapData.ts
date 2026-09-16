import {BuildPlan, BuildingKind, definitions, Inventory, Item, items, Point} from './Content';
import {WaveDefinition} from './WaveScheduler';

export interface MapData {
    schemaVersion: number;
    mapId: string;
    revision: number;
    name: string;
    width: number;
    height: number;
    initialResources: Inventory;
    ores: Array<Point & {item: Item}>;
    rocks: Point[];
    spawns: Point[];
    buildings: BuildPlan[];
    allowed: BuildingKind[];
    waves?: WaveDefinition[];
    tutorial?: 'copper';
    /** 准备期累计送入核心的额度；不包含初始库存，消费或拆除不恢复额度。 */
    preparation?: {deliveryLimit: Partial<Inventory>};
    /** 教学关可用真实物流结果作为开战条件；未配置时波次从战斗开始计时。 */
    waveStart?: {
        /** 为 true 时必须由会话命令确认；旧地图仍在达标后自动开战。 */
        manual?: boolean;
        delivered?: Partial<Inventory>;
        ammo?: Partial<Inventory>;
    };
}

export function validateMap(value: unknown): asserts value is MapData {
    if(!value || typeof value !== 'object') throw new Error('地图必须是对象');
    const map = value as MapData;
    const fail = (message: string): never => { throw new Error(`地图配置错误：${message}`); };
    if(map.schemaVersion !== 1 || !map.mapId || !Number.isInteger(map.revision) || map.revision < 1) fail('版本或地图 ID 无效');
    if(!Number.isInteger(map.width) || !Number.isInteger(map.height) || map.width < 8 || map.height < 8 || map.width > 96 || map.height > 96) fail('尺寸必须是 8～96 的整数');
    for(const key of ['ores', 'rocks', 'spawns', 'buildings', 'allowed'] as const){
        if(!Array.isArray(map[key])) fail(`${key} 必须是数组`);
    }
    for(const item of items){
        if(!Number.isSafeInteger(map.initialResources?.[item]) || map.initialResources[item] < 0) fail('初始资源无效');
    }
    const inBounds = (p: Point) => Number.isInteger(p?.x) && Number.isInteger(p?.y) && p.x >= 0 && p.y >= 0 && p.x < map.width && p.y < map.height;
    const key = (p: Point) => p.y * map.width + p.x;
    const rocks = new Set<number>();
    const ores = new Set<number>();
    const spawns = new Set<number>();
    for(const p of map.rocks){
        if(!inBounds(p) || rocks.has(key(p))) fail('岩石越界或重复');
        rocks.add(key(p));
    }
    for(const p of map.ores){
        if(!inBounds(p) || !items.includes(p.item) || p.item === 'graphite' || rocks.has(key(p)) || ores.has(key(p))) fail('矿点无效');
        ores.add(key(p));
    }
    for(const p of map.spawns){
        if(!inBounds(p) || rocks.has(key(p)) || spawns.has(key(p))) fail('出生点无效');
        spawns.add(key(p));
    }
    if(map.allowed.some(kind => !Object.prototype.hasOwnProperty.call(definitions, kind) || kind === 'core')) fail('允许建筑 ID 无效');
    const occupied = new Set<number>();
    for(const p of map.buildings){
        if(!inBounds(p) || !Object.prototype.hasOwnProperty.call(definitions, p.kind) || !Number.isInteger(p.direction) || p.direction < 0 || p.direction > 3) fail('预置建筑无效');
        if(rocks.has(key(p)) || spawns.has(key(p)) || occupied.has(key(p))) fail('预置建筑重叠');
        if(p.kind === 'drill' && !ores.has(key(p))) fail('钻头必须位于矿点');
        occupied.add(key(p));
    }
    if(map.buildings.filter(p => p.kind === 'core').length !== 1) fail('必须有且仅有一个核心');
    if(map.waves !== undefined){
        if(!Array.isArray(map.waves)) fail('waves 必须是数组');
        for(const wave of map.waves){
            if(!wave || !['normal', 'fast', 'armored'].includes(wave.enemy)) fail('波次敌人 ID 无效');
            if(!Number.isInteger(wave.spawn) || wave.spawn < 0 || wave.spawn >= map.spawns.length) fail('波次出生点无效');
            if(!Number.isSafeInteger(wave.count) || wave.count < 1 || wave.count > 10000) fail('波次数量无效');
            if(!Number.isSafeInteger(wave.delayTicks) || wave.delayTicks < 0
                || !Number.isSafeInteger(wave.intervalTicks) || wave.intervalTicks < 1) fail('波次时间无效');
        }
        // Buildings are destructible; only immutable rocks can make a wave impossible.
        const core = map.buildings.find(p => p.kind === 'core')!;
        const queue = [key(core)], reachable = new Set(queue);
        for(let i = 0; i < queue.length; i++){
            const cell = queue[i], x = cell % map.width, y = Math.floor(cell / map.width);
            for(const p of [{x: x + 1, y}, {x: x - 1, y}, {x, y: y + 1}, {x, y: y - 1}]){
                const next = key(p);
                if(inBounds(p) && !rocks.has(next) && !reachable.has(next)){
                    reachable.add(next); queue.push(next);
                }
            }
        }
        if(map.waves.some(wave => !reachable.has(key(map.spawns[wave.spawn])))) fail('波次出生点被岩石隔断，无法到达核心');
    }
    if(map.waveStart !== undefined){
        if(!map.waves?.length || !map.waveStart || typeof map.waveStart !== 'object') fail('开战条件必须配合波次使用');
        if(map.waveStart.manual !== undefined && typeof map.waveStart.manual !== 'boolean') fail('开战确认必须是布尔值');
        for(const group of [map.waveStart.delivered, map.waveStart.ammo]){
            if(group === undefined) continue;
            if(!group || typeof group !== 'object') fail('开战条件资源必须是对象');
            if(Object.keys(group).some(item => !items.includes(item as Item))) fail('开战条件包含未知资源');
            for(const item of items){
                const amount = group[item];
                if(amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) fail('开战条件资源数量无效');
            }
        }
        if((map.waveStart.ammo?.coal || 0) > 0) fail('炮塔不能使用煤作为弹药');
        const hasCondition = items.some(item => (map.waveStart!.delivered?.[item] || 0) > 0 || (map.waveStart!.ammo?.[item] || 0) > 0);
        if(!hasCondition) fail('开战条件不能为空');
    }
    if(map.tutorial !== undefined){
        if(map.tutorial !== 'copper' || map.waveStart?.manual !== true
            || !(map.waveStart.delivered?.copper! > 0) || !(map.waveStart.ammo?.copper! > 0)){
            fail('铜教学需要核心铜、铜弹药目标和手动开战确认');
        }
    }
    if(map.preparation !== undefined){
        const limit = map.preparation?.deliveryLimit;
        if(map.waveStart?.manual !== true || !limit || typeof limit !== 'object'
            || Array.isArray(limit) || Object.keys(limit).length === 0) fail('准备期额度需要手动开战和非空资源配置');
        if(Object.keys(limit).some(item => !items.includes(item as Item))) fail('准备期额度包含未知资源');
        for(const item of items){
            const amount = limit[item];
            if(amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) fail('准备期额度必须是非负整数');
            if(amount !== undefined && amount < (map.waveStart?.delivered?.[item] || 0)) fail('准备期额度不能低于开战送达目标');
        }
    }
}
