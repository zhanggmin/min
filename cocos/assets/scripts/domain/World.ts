import {BuildPlan, BuildingKind, definitions, emptyInventory, Inventory, Item, itemNames, items, Point, vectors} from './Content';
import {MapData, validateMap} from './MapData';

export interface Cargo { item: Item; direction: number; readyTick: number }
export interface Building extends BuildPlan {
    id: number;
    health: number;
    cargo: Cargo[];
    progress: number;
    crafting: boolean;
    output: number;
    cursor: number;
    reload: number;
    lastDamageTick: number;
}
export interface Result { ok: boolean; message: string }
interface Transfer { source: Building; target: Building; cargo?: Cargo; item: Item; direction: number }

/** Pure simulation. No cc / wx / node / browser dependencies. */
export class World {
    readonly buildings = new Map<number, Building>();
    readonly inventory: Inventory;
    readonly mined = emptyInventory();
    readonly consumed = emptyInventory();
    readonly produced = emptyInventory();
    readonly destroyed = emptyInventory();
    readonly spent = emptyInventory();
    readonly refunded = emptyInventory();
    readonly delivered = emptyInventory();
    /** Enemy origin and destination reservations, owned by EnemySystem. */
    readonly unitCells = new Set<number>();
    tick = 0;
    revision = 0;
    lostBuildings = 0;
    private preparing: boolean;
    private nextId = 1;
    private readonly occupied: Int32Array;
    private readonly rocks = new Set<number>();
    private readonly spawns = new Set<number>();
    private readonly ores = new Map<number, Item>();

    constructor(readonly map: MapData){
        validateMap(map);
        this.preparing = !!map.preparation;
        this.inventory = {...map.initialResources};
        this.occupied = new Int32Array(map.width * map.height);
        for(const p of map.rocks) this.rocks.add(this.index(p));
        for(const p of map.spawns) this.spawns.add(this.index(p));
        for(const p of map.ores) this.ores.set(this.index(p), p.item);
        for(const plan of map.buildings) this.insert(plan);
    }

    index(p: Point): number { return p.y * this.map.width + p.x; }
    inBounds(p: Point): boolean {
        return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < this.map.width && p.y < this.map.height;
    }
    at(p: Point): Building | undefined { return this.inBounds(p) ? this.buildings.get(this.occupied[this.index(p)]) : undefined; }
    ore(p: Point): Item | undefined { return this.ores.get(this.index(p)); }
    rock(p: Point): boolean { return this.rocks.has(this.index(p)); }
    private insert(plan: BuildPlan): void {
        const b: Building = {...plan, id: this.nextId++, health: definitions[plan.kind].health, cargo: [], progress: 0, crafting: false, output: 0, cursor: 0, reload: 0, lastDamageTick: -100};
        this.buildings.set(b.id, b);
        this.occupied[this.index(b)] = b.id;
    }

    checkBuild(plans: readonly BuildPlan[]): Result {
        if(plans.length === 0) return {ok: false, message: '先选择建造位置'};
        if(this.buildings.size + plans.length > 600) return {ok: false, message: '已达到 600 建筑上限'};
        const total = emptyInventory();
        const cells = new Set<number>();
        for(const plan of plans){
            if(!this.inBounds(plan)) return {ok: false, message: '超出地图范围'};
            if(!this.map.allowed.includes(plan.kind) || plan.kind === 'core') return {ok: false, message: '当前地图未开放该建筑'};
            if(!Number.isInteger(plan.direction) || plan.direction < 0 || plan.direction > 3) return {ok: false, message: '方向无效'};
            const cell = this.index(plan);
            if(this.unitCells.has(cell)) return {ok: false, message: '敌人正在占用或进入该格'};
            if(this.occupied[cell] || cells.has(cell) || this.rocks.has(cell) || this.spawns.has(cell)) return {ok: false, message: '位置被占用或禁止建造'};
            if(plan.kind === 'drill' && !this.ore(plan)) return {ok: false, message: '钻头需要建在铜或煤矿上'};
            cells.add(cell);
            for(const item of items) total[item] += definitions[plan.kind].cost[item] || 0;
        }
        if(items.some(item => total[item] > this.inventory[item])) return {ok: false, message: '核心中的建材不足'};
        return {ok: true, message: `可建造 ${plans.length} 个建筑`};
    }

    build(plans: readonly BuildPlan[]): Result {
        const result = this.checkBuild(plans);
        if(!result.ok) return result;
        for(const plan of plans){
            for(const item of items){
                const amount = definitions[plan.kind].cost[item] || 0;
                this.inventory[item] -= amount;
                this.spent[item] += amount;
            }
            this.insert(plan);
        }
        this.revision++;
        return {ok: true, message: `已建造 ${plans.length} 个建筑`};
    }

    rotate(p: Point): Result {
        const b = this.at(p);
        if(!b || b.kind === 'core') return {ok: false, message: '选择可旋转建筑'};
        b.direction = (b.direction + 1) % 4;
        this.revision++;
        return {ok: true, message: '方向已旋转'};
    }

    checkRemove(p: Point): Result {
        const b = this.at(p);
        if(!b) return {ok: false, message: '此处没有建筑，请点击要拆除的建筑'};
        if(b.kind === 'core') return {ok: false, message: '核心不可拆除'};
        return {ok: true, message: '可拆除'};
    }

    remove(p: Point): Result {
        const result = this.checkRemove(p);
        if(!result.ok) return result;
        const b = this.at(p)!;
        for(const item of items){
            const refund = Math.floor((definitions[b.kind].cost[item] || 0) * 0.5);
            this.inventory[item] += refund;
            this.refunded[item] += refund;
        }
        this.erase(b);
        return {ok: true, message: '已拆除：返还 50% 建材（向下取整），内部存货销毁'};
    }

    damage(id: number, amount: number): boolean {
        const b = this.buildings.get(id);
        if(!b || !Number.isFinite(amount) || amount <= 0) return false;
        b.lastDamageTick = this.tick;
        b.health = Math.max(0, b.health - amount);
        if(b.health === 0){
            if(b.kind !== 'core') this.lostBuildings++;
            this.erase(b);
        }
        return true;
    }

    private erase(b: Building): void {
        for(const cargo of b.cargo) this.destroyed[cargo.item]++;
        this.destroyed.graphite += b.output;
        this.buildings.delete(b.id);
        this.occupied[this.index(b)] = 0;
        this.revision++;
    }

    step(preparing = this.preparing): void {
        this.preparing = preparing;
        this.tick++;
        for(const b of this.buildings.values()){
            if(b.kind === 'drill' && b.cargo.length < definitions.drill.capacity){
                b.progress++;
                if(b.progress >= 20){
                    const item = this.ore(b)!;
                    b.cargo.push({item, direction: b.direction, readyTick: this.tick});
                    this.mined[item]++;
                    b.progress = 0;
                }
            }
            if(b.kind === 'crafter') this.updateCrafter(b);
        }
        this.transport();
    }

    private updateCrafter(b: Building): void {
        if(!b.crafting && b.cargo.length >= 2){
            b.cargo.splice(0, 2);
            this.consumed.coal += 2;
            b.crafting = true;
            b.progress = 0;
        }
        if(b.crafting){
            b.progress = Math.min(40, b.progress + 1);
            if(b.progress === 40 && b.output < 4){
                b.output++;
                this.produced.graphite++;
                b.crafting = false;
                b.progress = 0;
            }
        }
    }

    private accepts(target: Building, item: Item, direction: number, reserved: number, laneReserved: number): boolean {
        const kind = target.kind;
        if(kind === 'drill' || kind === 'wall') return false;
        if(kind === 'core'){
            const remaining = this.preparationRemaining(item);
            return this.inventory[item] + reserved < definitions.core.capacity
                && (remaining === undefined || reserved < remaining);
        }
        if(kind === 'crafter' && item !== 'coal') return false;
        if(kind === 'turret' && item !== 'copper') return false;
        if(kind === 'heavyTurret' && item !== 'graphite') return false;
        if(kind === 'belt' && (direction + 2) % 4 === target.direction) return false;
        if(kind === 'junction'){
            const lane = target.cargo.filter(c => c.direction % 2 === direction % 2).length;
            if(lane + laneReserved >= 3) return false;
        }
        return target.cargo.length + reserved < definitions[kind].capacity;
    }

    private transport(): void {
        const sources = Array.from(this.buildings.values());
        if(sources.length === 0) return;
        const transfers: Transfer[] = [];
        const reserved = new Map<string, number>();
        // Rotate the first source each tick so shared capacity cannot starve one input forever.
        for(let n = 0; n < sources.length; n++){
            const source = sources[(n + this.tick) % sources.length];
            if(['core', 'wall', 'turret', 'heavyTurret'].includes(source.kind)) continue;
            const candidates = source.kind === 'junction'
                ? [source.cargo.find(c => c.direction % 2 === 0), source.cargo.find(c => c.direction % 2 === 1)]
                : [source.cargo[0]];
            for(const cargo of candidates){
                const output = source.kind === 'crafter';
                if(output ? source.output === 0 : !cargo || cargo.readyTick > this.tick) continue;
                const item: Item = output ? 'graphite' : cargo!.item;
                const dirs = source.kind === 'router'
                    ? [0, 1, 2, 3].map(i => (i + source.cursor) % 4).filter(d => d !== (cargo!.direction + 2) % 4)
                    : [source.kind === 'junction' ? cargo!.direction : source.direction];
                for(const direction of dirs){
                    const v = vectors[direction];
                    const target = this.at({x: source.x + v.x, y: source.y + v.y});
                    if(!target) continue;
                    const capacityKey = target.kind === 'core' ? `${target.id}:${item}` : `${target.id}`;
                    const laneKey = `${target.id}:lane:${direction % 2}`;
                    const count = reserved.get(capacityKey) || 0;
                    const laneCount = reserved.get(laneKey) || 0;
                    if(!this.accepts(target, item, direction, count, laneCount)) continue;
                    reserved.set(capacityKey, count + 1);
                    reserved.set(laneKey, laneCount + 1);
                    transfers.push({source, target, cargo: output ? undefined : cargo, item, direction});
                    if(source.kind === 'router') source.cursor = (direction + 1) % 4;
                    break;
                }
            }
        }
        // No arrival is visible during intent collection; it can never move twice in one tick.
        for(const move of transfers){
            if(move.cargo) move.source.cargo.splice(move.source.cargo.indexOf(move.cargo), 1);
            else move.source.output--;
            if(move.target.kind === 'core'){
                this.inventory[move.item]++;
                this.delivered[move.item]++;
            }else{
                move.target.cargo.push({item: move.item, direction: move.direction, readyTick: this.tick + 5});
            }
        }
    }

    totals(): Inventory {
        const total = {...this.inventory};
        for(const b of this.buildings.values()){
            for(const c of b.cargo) total[c.item]++;
            total.graphite += b.output;
        }
        return total;
    }

    preparationRemaining(item: Item): number | undefined {
        const limit = this.preparing ? this.map.preparation?.deliveryLimit[item] : undefined;
        return limit === undefined ? undefined : Math.max(0, limit-this.delivered[item]);
    }

    status(b: Building): string {
        if(b.kind === 'core'){
            const limits = items.filter(item => this.preparationRemaining(item) !== undefined);
            return limits.length ? `备战还可接收 ${limits.map(item => `${this.preparationRemaining(item)}${itemNames[item]}`).join(' ')}\n花费不恢复额度\n满额留在线上，开战解除` : '收到的物品成为可用建材';
        }
        if(b.kind === 'crafter') return b.output >= 4 ? '输出已满' : b.crafting ? `加工 ${Math.floor(b.progress / 40 * 100)}%` : '缺料：需要 2 煤 → 1 石墨';
        if(b.kind === 'turret' || b.kind === 'heavyTurret'){
            const ammo = b.kind === 'turret' ? 'copper' : 'graphite';
            return b.cargo.some(cargo => cargo.item === ammo) ? `弹药 ${b.cargo.length}/${definitions[b.kind].capacity}` : `缺弹：需要${b.kind === 'turret' ? '铜' : '石墨'}`;
        }
        if(b.cargo.length >= definitions[b.kind].capacity) return '缓存已满，请检查下游';
        if(b.kind === 'drill') return `采集 ${this.ore(b) === 'copper' ? '铜' : '煤'} · 每秒 1 个`;
        return `缓存 ${b.cargo.length}/${definitions[b.kind].capacity} · 箭头为输出方向`;
    }
}

export function beltLine(start: Point, end: Point, lastDirection: number): BuildPlan[] {
    const points: Point[] = [{...start}];
    const current = {...start};
    while(current.x !== end.x){ current.x += Math.sign(end.x - current.x); points.push({...current}); }
    while(current.y !== end.y){ current.y += Math.sign(end.y - current.y); points.push({...current}); }
    return points.map((p, i) => {
        const next = points[i + 1];
        const direction = next ? vectors.findIndex(v => v.x === next.x - p.x && v.y === next.y - p.y) : lastDirection;
        return {...p, kind: 'belt', direction};
    });
}
