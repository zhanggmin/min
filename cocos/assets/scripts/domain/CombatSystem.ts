import {BuildingKind, Item} from './Content';
import {Enemy, EnemySystem} from './EnemySystem';
import {Building, World} from './World';

export interface TurretDefinition {
    ammo: Item;
    range: number;
    reloadTicks: number;
    damage: number;
    armorPiercing: number;
    projectileSpeed: number;
}

export const turretDefinitions: Record<'turret' | 'heavyTurret', TurretDefinition> = {
    turret: {ammo: 'copper', range: 5, reloadTicks: 12, damage: 22, armorPiercing: 0, projectileSpeed: 12},
    heavyTurret: {ammo: 'graphite', range: 6.5, reloadTicks: 24, damage: 75, armorPiercing: 10, projectileSpeed: 10}
};

export interface Bullet {
    id: number;
    x: number;
    y: number;
    velocityX: number;
    velocityY: number;
    targetId: number;
    damage: number;
    armorPiercing: number;
    remainingTicks: number;
    kind: 'turret' | 'heavyTurret';
}

/** Rebuilt from authoritative enemy positions once per combat tick. */
export class EnemySpatialGrid {
    private readonly cells: Enemy[][];

    constructor(private readonly width: number, height: number){
        this.cells = Array.from({length: width * height}, () => []);
    }

    rebuild(enemies: Iterable<Enemy>): void {
        for(const cell of this.cells) cell.length = 0;
        for(const enemy of enemies){
            const x = Math.max(0, Math.min(this.width - 1, Math.floor(enemy.x)));
            const y = Math.max(0, Math.min(this.cells.length / this.width - 1, Math.floor(enemy.y)));
            this.cells[y * this.width + x].push(enemy);
        }
    }

    nearest(x: number, y: number, range: number): Enemy | undefined {
        let result: Enemy | undefined, bestDistance = range * range;
        const height = this.cells.length / this.width;
        const startX = Math.max(0, Math.floor(x - range)), endX = Math.min(this.width - 1, Math.floor(x + range));
        const startY = Math.max(0, Math.floor(y - range)), endY = Math.min(height - 1, Math.floor(y + range));
        for(let cellY = startY; cellY <= endY; cellY++) for(let cellX = startX; cellX <= endX; cellX++){
            for(const enemy of this.cells[cellY * this.width + cellX]){
                const dx = enemy.x - x, dy = enemy.y - y, distance = dx * dx + dy * dy;
                if(distance <= bestDistance && (!result || distance < bestDistance || enemy.id < result.id)){
                    result = enemy;
                    bestDistance = distance;
                }
            }
        }
        return result;
    }

    firstAlong(x1: number, y1: number, x2: number, y2: number, radius: number): Enemy | undefined {
        const dx = x2 - x1, dy = y2 - y1, length2 = dx * dx + dy * dy;
        let result: Enemy | undefined, first = Infinity;
        const height = this.cells.length / this.width;
        const startX = Math.max(0, Math.floor(Math.min(x1, x2) - radius));
        const endX = Math.min(this.width - 1, Math.floor(Math.max(x1, x2) + radius));
        const startY = Math.max(0, Math.floor(Math.min(y1, y2) - radius));
        const endY = Math.min(height - 1, Math.floor(Math.max(y1, y2) + radius));
        for(let cellY = startY; cellY <= endY; cellY++) for(let cellX = startX; cellX <= endX; cellX++){
            for(const enemy of this.cells[cellY * this.width + cellX]){
                if(enemy.health <= 0) continue;
                const projection = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((enemy.x - x1) * dx + (enemy.y - y1) * dy) / length2));
                const ex = x1 + projection * dx - enemy.x, ey = y1 + projection * dy - enemy.y;
                if(ex * ex + ey * ey <= radius * radius && (projection < first || projection === first && (!result || enemy.id < result.id))){
                    first = projection;
                    result = enemy;
                }
            }
        }
        return result;
    }
}

/** Pure combat simulation: ammo, targeting, bullets and damage never depend on rendered nodes. */
export class CombatSystem {
    readonly bullets = new Map<number, Bullet>();
    readonly grid: EnemySpatialGrid;
    shots = 0;
    hits = 0;
    kills = 0;
    private nextBulletId = 1;

    constructor(private readonly world: World, private readonly enemies: EnemySystem){
        this.grid = new EnemySpatialGrid(world.map.width, world.map.height);
    }

    step(): void {
        this.grid.rebuild(this.enemies.enemies.values());
        this.updateBullets();
        this.grid.rebuild(this.enemies.enemies.values());
        for(const building of this.world.buildings.values()){
            if(building.kind !== 'turret' && building.kind !== 'heavyTurret') continue;
            if(building.reload > 0) building.reload--;
            if(building.reload === 0) this.tryFire(building);
        }
    }

    private tryFire(turret: Building): void {
        const kind = turret.kind as 'turret' | 'heavyTurret', definition = turretDefinitions[kind];
        let ammoIndex = -1;
        for(let i = 0; i < turret.cargo.length; i++) if(turret.cargo[i].item === definition.ammo){ ammoIndex = i; break; }
        if(ammoIndex < 0) return;
        const target = this.grid.nearest(turret.x, turret.y, definition.range);
        if(!target) return;
        const enemy = target as Enemy;
        const distance = Math.hypot(enemy.x - turret.x, enemy.y - turret.y);
        if(distance === 0) return;
        turret.cargo.splice(ammoIndex, 1);
        turret.reload = definition.reloadTicks;
        this.bullets.set(this.nextBulletId, {
            id: this.nextBulletId++, x: turret.x, y: turret.y,
            velocityX: (enemy.x - turret.x) / distance * definition.projectileSpeed,
            velocityY: (enemy.y - turret.y) / distance * definition.projectileSpeed,
            targetId: enemy.id, damage: definition.damage, armorPiercing: definition.armorPiercing,
            remainingTicks: Math.ceil(definition.range / definition.projectileSpeed * 20) + 2, kind
        });
        this.shots++;
    }

    private updateBullets(): void {
        for(const bullet of this.bullets.values()){
            const target = this.enemies.enemies.get(bullet.targetId);
            if(target){
                const dx = target.x - bullet.x, dy = target.y - bullet.y, distance = Math.hypot(dx, dy);
                if(distance > 0){
                    const speed = turretDefinitions[bullet.kind].projectileSpeed;
                    bullet.velocityX = dx / distance * speed;
                    bullet.velocityY = dy / distance * speed;
                }
            }
            const oldX = bullet.x, oldY = bullet.y;
            bullet.x += bullet.velocityX / 20;
            bullet.y += bullet.velocityY / 20;
            bullet.remainingTicks--;
            const hit = this.grid.firstAlong(oldX, oldY, bullet.x, bullet.y, 0.3);
            if(hit){
                const health = hit.health;
                this.enemies.damage(hit.id, bullet.damage, bullet.armorPiercing);
                this.hits++;
                if(health > 0 && !this.enemies.enemies.has(hit.id)) this.kills++;
                this.bullets.delete(bullet.id);
            }else if(bullet.remainingTicks <= 0) this.bullets.delete(bullet.id);
        }
    }

}
