import {BuildPlan, emptyInventory, Inventory, items, Point} from '../domain/Content';
import {MapData} from '../domain/MapData';
import {Result, World} from '../domain/World';
import {SimulationClock} from './SimulationClock';
import {EnemySystem} from '../domain/EnemySystem';
import {WaveScheduler} from '../domain/WaveScheduler';
import {CombatSystem} from '../domain/CombatSystem';

export type Command = {type: 'build'; plans: readonly BuildPlan[]}
    | {type: 'startDefense'}
    | {type: 'rotate' | 'remove'; point: Point};
export interface CommandResult extends Result { sequence: number; tick: number }
export type SessionOutcome = 'playing' | 'victory' | 'defeat';
export type TutorialStage = 'mine' | 'deliver' | 'supply' | 'ready' | 'defend' | SessionOutcome;

/** A serializable uint32 state; zero is a valid seed. */
export class SeededRandom {
    state: number;
    constructor(seed: number){
        if(!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('随机种子必须是 uint32');
        this.state = seed;
    }
    next(): number {
        this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
        return this.state / 0x100000000;
    }
}

/** Commands are copied on submission and executed FIFO before production/transport. */
export class GameSession {
    readonly world: World;
    readonly clock = new SimulationClock();
    readonly random: SeededRandom;
    readonly enemies: EnemySystem;
    readonly waves: WaveScheduler;
    readonly combat: CombatSystem;
    outcome: SessionOutcome = 'playing';
    wavesStarted: boolean;
    private nextSequence = 1;
    private pending: Array<{sequence: number; command: Command}> = [];

    constructor(map: MapData, seed = 1){
        this.world = new World(JSON.parse(JSON.stringify(map)) as MapData);
        this.random = new SeededRandom(seed);
        this.enemies = new EnemySystem(this.world);
        this.waves = new WaveScheduler(this.world.map.waves || []);
        this.combat = new CombatSystem(this.world, this.enemies);
        this.wavesStarted = !this.world.map.waveStart;
    }

    enqueue(command: Command): number {
        const sequence = this.nextSequence++;
        const copy: Command = command.type === 'build'
            ? {type: 'build', plans: command.plans.map(plan => ({...plan}))}
            : command.type === 'startDefense' ? {type: 'startDefense'}
            : {type: command.type, point: {...command.point}};
        this.pending.push({sequence, command: copy});
        return sequence;
    }

    advance(delta: number, report?: (result: CommandResult) => void): number {
        if(this.outcome !== 'playing') return 0;
        const results: CommandResult[] = [];
        const steps = this.clock.advance(delta, () => {
            const commands = this.pending;
            this.pending = [];
            for(const {sequence, command} of commands){
                const result = command.type === 'build' ? this.world.build(command.plans)
                    : command.type === 'startDefense' ? this.startDefense()
                    : command.type === 'rotate' ? this.world.rotate(command.point) : this.world.remove(command.point);
                results.push({...result, sequence, tick: this.world.tick + 1});
            }
            this.world.step(!this.wavesStarted);
            // 教学关先检查真实物流成果，条件满足后的下一阶段才允许推进波次游标。
            if(!this.wavesStarted && !this.world.map.waveStart?.manual && this.checkWaveStart()) this.wavesStarted = true;
            if(this.wavesStarted) this.waves.step(wave => this.enemies.spawn(wave));
            if(this.world.map.waves?.length){
                this.enemies.step();
                this.combat.step();
                if(this.enemies.defeated) this.outcome = 'defeat';
                else if(this.waves.complete && this.enemies.enemies.size === 0) this.outcome = 'victory';
            }
            if(this.outcome !== 'playing'){ this.pending = []; this.clock.pause(); }
        });
        // Presentation callbacks cannot influence another step in the same frame.
        for(const result of results) report?.(result);
        return steps;
    }

    /** 开战命令执行时重新检查实际库存，拆炮或命令排队不能绕过门槛。 */
    get canStartDefense(): boolean {
        return this.outcome === 'playing' && !this.wavesStarted
            && this.world.map.waveStart?.manual === true && this.checkWaveStart();
    }

    get tutorialStage(): TutorialStage | undefined {
        if(this.world.map.tutorial !== 'copper') return undefined;
        if(this.outcome !== 'playing') return this.outcome;
        if(this.wavesStarted) return 'defend';
        if(this.world.delivered.copper < (this.world.map.waveStart!.delivered!.copper!)){
            for(const building of this.world.buildings.values()){
                if(building.kind === 'drill') return 'deliver';
            }
            return 'mine';
        }
        return this.canStartDefense ? 'ready' : 'supply';
    }

    private startDefense(): Result {
        if(!this.canStartDefense) return {ok: false, message: '尚未满足供给目标，或防守已经开始'};
        this.wavesStarted = true;
        return {ok: true, message: '防守已开始，第一波进入倒计时'};
    }

    /** 汇总所有炮塔内的弹药，UI 与开战门槛都读取同一份逻辑状态。 */
    turretAmmo(): Inventory {
        const result = emptyInventory();
        for(const building of this.world.buildings.values()){
            if(building.kind !== 'turret' && building.kind !== 'heavyTurret') continue;
            for(const cargo of building.cargo) result[cargo.item]++;
        }
        return result;
    }

    private checkWaveStart(): boolean {
        const condition = this.world.map.waveStart;
        if(!condition) return true;
        const ammo = this.turretAmmo();
        return items.every(item => this.world.delivered[item] >= (condition.delivered?.[item] || 0)
            && ammo[item] >= (condition.ammo?.[item] || 0));
    }
}
