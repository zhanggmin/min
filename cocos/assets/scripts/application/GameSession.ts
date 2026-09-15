import {BuildPlan, Point} from '../domain/Content';
import {MapData} from '../domain/MapData';
import {Result, World} from '../domain/World';
import {SimulationClock} from './SimulationClock';
import {EnemySystem} from '../domain/EnemySystem';
import {WaveScheduler} from '../domain/WaveScheduler';

export type Command = {type: 'build'; plans: readonly BuildPlan[]}
    | {type: 'rotate' | 'remove'; point: Point};
export interface CommandResult extends Result { sequence: number; tick: number }

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
    private nextSequence = 1;
    private pending: Array<{sequence: number; command: Command}> = [];

    constructor(map: MapData, seed = 1){
        this.world = new World(JSON.parse(JSON.stringify(map)) as MapData);
        this.random = new SeededRandom(seed);
        this.enemies = new EnemySystem(this.world);
        this.waves = new WaveScheduler(this.world.map.waves || []);
    }

    enqueue(command: Command): number {
        const sequence = this.nextSequence++;
        const copy: Command = command.type === 'build'
            ? {type: 'build', plans: command.plans.map(plan => ({...plan}))}
            : {type: command.type, point: {...command.point}};
        this.pending.push({sequence, command: copy});
        return sequence;
    }

    advance(delta: number, report?: (result: CommandResult) => void): number {
        if(this.enemies.defeated) return 0;
        const results: CommandResult[] = [];
        const steps = this.clock.advance(delta, () => {
            const commands = this.pending;
            this.pending = [];
            for(const {sequence, command} of commands){
                const result = command.type === 'build' ? this.world.build(command.plans)
                    : command.type === 'rotate' ? this.world.rotate(command.point) : this.world.remove(command.point);
                results.push({...result, sequence, tick: this.world.tick + 1});
            }
            this.world.step();
            this.waves.step(wave => this.enemies.spawn(wave));
            if(this.world.map.waves?.length) this.enemies.step();
            if(this.enemies.defeated){ this.pending = []; this.clock.pause(); }
        });
        // Presentation callbacks cannot influence another step in the same frame.
        for(const result of results) report?.(result);
        return steps;
    }
}
