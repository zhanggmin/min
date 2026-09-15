import {World} from './World';

/** One reverse Dijkstra field shared by all units. Each step expands at most budget heap entries. */
export class DistanceField {
    revision = -1;
    rebuilds = 0;
    private distances: Float64Array;
    private work: Float64Array;
    private costs: Uint8Array;
    private heap: number[] = [];
    private workingRevision = -1;
    private active = false;
    private readonly size: number;

    constructor(private readonly world: World, private readonly coreCell: number){
        this.size = world.map.width * world.map.height;
        this.distances = new Float64Array(this.size).fill(Infinity);
        this.work = new Float64Array(this.size);
        this.costs = new Uint8Array(this.size);
    }

    at(cell: number): number { return this.distances[cell]; }

    update(budget = 256): number {
        if(!this.active && this.revision !== this.world.revision){
            this.workingRevision = this.world.revision;
            this.work.fill(Infinity);
            this.costs.fill(1);
            for(const p of this.world.map.rocks) this.costs[this.world.index(p)] = 0;
            for(const b of this.world.buildings.values()) this.costs[this.world.index(b)] = b.kind === 'core' ? 1 : 9;
            this.work[this.coreCell] = 0;
            this.heap.length = 0;
            this.push(this.coreCell);
            this.active = true;
        }
        let expanded = 0;
        const width = this.world.map.width;
        while(this.active && this.heap.length && expanded < budget){
            const entry = this.pop();
            const cell = entry % this.size, distance = Math.floor(entry / this.size);
            expanded++;
            if(distance !== this.work[cell]) continue;
            const next = distance + this.costs[cell];
            if(cell % width > 0) this.relax(cell - 1, next);
            if(cell % width < width - 1) this.relax(cell + 1, next);
            if(cell >= width) this.relax(cell - width, next);
            if(cell + width < this.size) this.relax(cell + width, next);
        }
        if(this.active && !this.heap.length){
            const old = this.distances;
            this.distances = this.work;
            this.work = old;
            this.revision = this.workingRevision;
            this.active = false;
            this.rebuilds++;
        }
        return expanded;
    }

    private relax(cell: number, distance: number): void {
        if(this.costs[cell] && distance < this.work[cell]){
            this.work[cell] = distance;
            this.push(distance * this.size + cell);
        }
    }
    private push(entry: number): void {
        let i = this.heap.length;
        this.heap.push(entry);
        while(i > 0){
            const parent = (i - 1) >> 1;
            if(this.heap[parent] <= entry) break;
            this.heap[i] = this.heap[parent]; i = parent;
        }
        this.heap[i] = entry;
    }
    private pop(): number {
        const first = this.heap[0], last = this.heap.pop()!;
        if(this.heap.length){
            let i = 0;
            while(i * 2 + 1 < this.heap.length){
                let child = i * 2 + 1;
                if(child + 1 < this.heap.length && this.heap[child + 1] < this.heap[child]) child++;
                if(this.heap[child] >= last) break;
                this.heap[i] = this.heap[child]; i = child;
            }
            this.heap[i] = last;
        }
        return first;
    }
}
