export class SimulationClock {
    paused = false;
    private accumulator = 0;
    droppedFrames = 0;
    advance(delta: number, step: () => void): number {
        if(this.paused || !Number.isFinite(delta) || delta <= 0) return 0;
        this.accumulator += Math.min(delta, 0.25);
        let count = 0;
        while(this.accumulator + 1e-10 >= 0.05 && count < 4){
            step();
            this.accumulator = Math.max(0, this.accumulator - 0.05);
            count++;
        }
        if(this.accumulator + 1e-10 >= 0.05){ this.accumulator = 0; this.droppedFrames++; }
        return count;
    }
    pause(): void { this.paused = true; this.accumulator = 0; }
    resume(): void { this.paused = false; this.accumulator = 0; }
}
