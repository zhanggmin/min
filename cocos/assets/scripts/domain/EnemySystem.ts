import {Point, vectors} from './Content';
import {DistanceField} from './DistanceField';
import {EnemyKind, WaveDefinition} from './WaveScheduler';
import {Building, World} from './World';

export const enemyDefinitions: Record<EnemyKind, {speed: number; health: number; damage: number; attackTicks: number}> = {
    normal: {speed: 1.6, health: 60, damage: 12, attackTicks: 20},
    fast: {speed: 2.8, health: 35, damage: 7, attackTicks: 14},
    armored: {speed: 0.9, health: 180, damage: 25, attackTicks: 30}
};
export interface Enemy extends Point {
    id: number;
    kind: EnemyKind;
    health: number;
    cell: number;
    target: number;
    progress: number;
    cooldown: number;
}

export class EnemySystem {
    readonly enemies = new Map<number, Enemy>();
    readonly field: DistanceField;
    readonly core: Building;
    readonly limit = 120;
    private nextId = 1;
    private readonly point: Point = {x: 0, y: 0};

    constructor(private readonly world: World){
        this.core = Array.from(world.buildings.values()).find(b => b.kind === 'core')!;
        this.field = new DistanceField(world, world.index(this.core));
    }
    get defeated(): boolean { return this.core.health <= 0; }

    spawn(wave: WaveDefinition): boolean {
        if(this.defeated || this.enemies.size >= this.limit) return false;
        const p = this.world.map.spawns[wave.spawn], cell = this.world.index(p);
        if(this.world.unitCells.has(cell)) return false;
        const enemy: Enemy = {...p, id: this.nextId++, kind: wave.enemy, health: enemyDefinitions[wave.enemy].health,
            cell, target: cell, progress: 0, cooldown: 0};
        this.enemies.set(enemy.id, enemy);
        this.world.unitCells.add(cell);
        return true;
    }

    step(): void {
        if(this.defeated) return;
        this.field.update();
        const width = this.world.map.width;
        for(const enemy of this.enemies.values()){
            if(this.defeated) break;
            if(enemy.cooldown > 0) enemy.cooldown--;
            if(enemy.target === enemy.cell){
                const x = enemy.cell % width, y = Math.floor(enemy.cell / width);
                let best = Infinity, target = enemy.cell;
                for(const v of vectors){
                    const p = this.point;
                    p.x = x + v.x; p.y = y + v.y;
                    if(!this.world.inBounds(p) || this.world.rock(p)) continue;
                    const cell = this.world.index(p), distance = this.field.at(cell);
                    if(this.world.unitCells.has(cell) || distance >= this.field.at(enemy.cell)) continue;
                    const building = this.world.at(p);
                    const score = distance + (building && building.kind !== 'core' ? 9 : 1);
                    if(score < best){ best = score; target = cell; }
                }
                if(target === enemy.cell) continue;
                this.point.x = target % width; this.point.y = Math.floor(target / width);
                const building = this.world.at(this.point);
                if(building){
                    if(enemy.cooldown === 0){
                        const def = enemyDefinitions[enemy.kind];
                        this.world.damage(building.id, def.damage);
                        enemy.cooldown = def.attackTicks;
                    }
                    continue;
                }
                enemy.target = target;
                this.world.unitCells.add(target);
            }
            enemy.progress = Math.min(1, enemy.progress + enemyDefinitions[enemy.kind].speed / 20);
            const x = enemy.cell % width, y = Math.floor(enemy.cell / width);
            enemy.x = x + (enemy.target % width - x) * enemy.progress;
            enemy.y = y + (Math.floor(enemy.target / width) - y) * enemy.progress;
            if(enemy.progress === 1){
                this.world.unitCells.delete(enemy.cell);
                enemy.cell = enemy.target;
                enemy.progress = 0;
            }
        }
    }
}
