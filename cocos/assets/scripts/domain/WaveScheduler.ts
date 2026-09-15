export type EnemyKind = 'normal' | 'fast' | 'armored';

/** Times are integer simulation ticks, relative to the previous wave's last spawn. */
export interface WaveDefinition {
    enemy: EnemyKind;
    spawn: number;
    count: number;
    delayTicks: number;
    intervalTicks: number;
}

export class WaveScheduler {
    waveIndex = 0;
    spawned = 0;
    remainingTicks: number;

    constructor(readonly waves: readonly WaveDefinition[]){
        this.remainingTicks = waves[0]?.delayTicks ?? 0;
    }

    get complete(): boolean { return this.waveIndex >= this.waves.length; }

    /** Returning false leaves the cursor in place (for example, at the live enemy cap). */
    step(spawn: (wave: WaveDefinition) => boolean): void {
        if(this.complete) return;
        if(this.remainingTicks > 0) this.remainingTicks--;
        if(this.remainingTicks > 0) return;
        const wave = this.waves[this.waveIndex];
        if(!spawn(wave)) return;
        this.spawned++;
        if(this.spawned === wave.count){
            this.waveIndex++;
            this.spawned = 0;
            this.remainingTicks = this.waves[this.waveIndex]?.delayTicks ?? 0;
        }else this.remainingTicks = wave.intervalTicks;
    }
}
