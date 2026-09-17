const test = require('node:test');
const assert = require('node:assert/strict');
const {World, beltLine} = require('../.test-build/domain/World.js');
const {validateMap} = require('../.test-build/domain/MapData.js');
const {items, definitions} = require('../.test-build/domain/Content.js');
const {SimulationClock} = require('../.test-build/application/SimulationClock.js');
const map = () => ({schemaVersion: 1, mapId: 'test', revision: 1, name: 'test', width: 16, height: 16,
    initialResources: {copper: 1000, coal: 0, graphite: 0}, ores: [{x: 1, y: 1, item: 'copper'}, {x: 1, y: 3, item: 'coal'}],
    rocks: [], spawns: [], buildings: [{kind: 'core', x: 8, y: 1, direction: 0}], allowed: Object.keys(definitions).filter(k => k !== 'core')});
const plan = (kind, x, y, direction = 0) => ({kind, x, y, direction});
const run = (w, ticks) => { for(let i = 0; i < ticks; i++) w.step(); };
const cargo = (item = 'copper', direction = 0) => ({item, direction, readyTick: 0});
function conserved(w){
    const total = w.totals();
    for(const item of items){
        assert.equal(total[item], w.map.initialResources[item] - w.spent[item] + w.refunded[item]
            + w.mined[item] + w.produced[item] - w.consumed[item] - w.destroyed[item], item);
    }
}

test('invalid maps fail before constructing simulation', () => {
    const m = map(); m.buildings.push(plan('storage', 16, 0));
    assert.throws(() => validateMap(m), /预置建筑无效/);
    const overlap = map(); overlap.rocks.push({x: 8, y: 1});
    assert.throws(() => validateMap(overlap), /重叠/);
});
test('failed batch build never partially spends or occupies cells', () => {
    const w = new World(map());
    const before = {...w.inventory};
    assert.equal(w.build([plan('belt', 2, 1), plan('belt', 8, 1)]).ok, false);
    assert.deepEqual(w.inventory, before); assert.equal(w.at({x: 2, y: 1}), undefined);
    assert.equal(w.build([plan('drill', 2, 2)]).ok, false);
    assert.equal(w.build([plan('belt', 2, 1), plan('belt', 2, 1)]).ok, false);
});
test('insufficient graphite and invalid directions are rejected', () => {
    const w = new World(map());
    assert.equal(w.build([plan('heavyTurret', 2, 2)]).ok, false);
    assert.equal(w.build([plan('belt', 2, 2, -1)]).ok, false);
    assert.equal(w.inventory.copper, 1000);
});
test('copper travels from drill through a line to core without loss', () => {
    const w = new World(map());
    w.build([plan('drill', 1, 1), ...beltLine({x: 2, y: 1}, {x: 7, y: 1}, 0)]);
    run(w, 400); assert.ok(w.delivered.copper >= 17); conserved(w);
});
test('cargo never passes two connections in the same tick', () => {
    const w = new World(map()); w.build(beltLine({x: 2, y: 1}, {x: 4, y: 1}, 0));
    w.at({x: 2, y: 1}).cargo.push(cargo()); w.step();
    assert.equal(w.at({x: 3, y: 1}).cargo.length, 1);
    assert.equal(w.at({x: 4, y: 1}).cargo.length, 0);
});
test('full downstream applies backpressure and restarts when removed', () => {
    const w = new World(map()); w.build([plan('drill', 1, 1), plan('belt', 2, 1)]);
    run(w, 400); assert.equal(w.mined.copper, 9); conserved(w);
    w.build(beltLine({x: 3, y: 1}, {x: 7, y: 1}, 0)); run(w, 200);
    assert.ok(w.delivered.copper > 0); conserved(w);
});
test('crossing keeps horizontal and vertical cargo independent', () => {
    const w = new World(map()); w.build([plan('junction', 3, 3), plan('belt', 4, 3), plan('belt', 3, 4, 1)]);
    w.at({x: 3, y: 3}).cargo.push(cargo('copper', 0), cargo('coal', 1)); w.step();
    assert.equal(w.at({x: 4, y: 3}).cargo[0].item, 'copper');
    assert.equal(w.at({x: 3, y: 4}).cargo[0].item, 'coal');
});
test('competing sources cannot overfill one target', () => {
    const w = new World(map()); w.build([plan('belt', 2, 2), plan('belt', 3, 1, 1), plan('storage', 3, 2)]);
    w.at({x: 2, y: 2}).cargo.push(cargo()); w.at({x: 3, y: 1}).cargo.push(cargo('coal', 1));
    w.at({x: 3, y: 2}).cargo = Array.from({length: 59}, () => cargo()); w.step();
    assert.equal(w.at({x: 3, y: 2}).cargo.length, 60);
    assert.equal(w.at({x: 2, y: 2}).cargo.length + w.at({x: 3, y: 1}).cargo.length, 1);
});
test('router distributes rather than sends cargo immediately back', () => {
    const w = new World(map()); w.build([plan('router', 3, 3), plan('storage', 4, 3), plan('storage', 3, 4), plan('storage', 2, 3)]);
    const router = w.at({x: 3, y: 3});
    for(let i = 0; i < 8; i++){ router.cargo.push(cargo()); w.step(); }
    assert.equal(w.at({x: 4, y: 3}).cargo.length, 4);
    assert.equal(w.at({x: 3, y: 4}).cargo.length, 4);
    assert.equal(w.at({x: 2, y: 3}).cargo.length, 0);
});
test('processing consumes coal once and preserves completed output under blockage', () => {
    const w = new World(map()); w.build([plan('drill', 1, 3), plan('crafter', 2, 3)]);
    run(w, 600); const factory = w.at({x: 2, y: 3});
    assert.equal(factory.output, 4); assert.equal(factory.progress, 40); conserved(w);
    const before = w.produced.graphite;
    w.build([plan('storage', 3, 3)]); run(w, 2);
    assert.equal(w.produced.graphite, before + 1); conserved(w);
});
test('removal accounts for discarded cargo and cannot remove core', () => {
    const w = new World(map()); w.build([plan('drill', 1, 1)]); run(w, 100);
    w.remove({x: 1, y: 1}); assert.equal(w.destroyed.copper, 5); conserved(w);
    assert.equal(w.remove({x: 8, y: 1}).ok, false);
});
test('closed transport loop conserves all cargo for 1000 ticks', () => {
    const w = new World(map()); w.build([plan('belt', 3, 3), plan('belt', 4, 3, 1), plan('belt', 4, 4, 2), plan('belt', 3, 4, 3)]);
    w.at({x: 3, y: 3}).cargo.push(cargo()); const before = w.totals(); run(w, 1000);
    assert.deepEqual(w.totals(), before);
});
test('L-shaped belt preview computes the turn direction', () => {
    const line = beltLine({x: 1, y: 1}, {x: 3, y: 3}, 0);
    assert.equal(line.length, 5); assert.equal(line[2].direction, 1); assert.equal(line[4].direction, 0);
});
test('clock caps catchup and never simulates time spent paused', () => {
    const clock = new SimulationClock(); let ticks = 0;
    assert.equal(clock.advance(10, () => ticks++), 4);
    clock.pause(); clock.advance(100, () => ticks++); clock.resume(); clock.advance(0.01, () => ticks++);
    assert.equal(ticks, 4);
});

test('destroyed-building feedback counts enemy damage once and excludes voluntary removal and the core', () => {
    const w = new World(map());
    w.build([plan('wall', 3, 3), plan('wall', 4, 3)]);
    const id = w.at({x:3,y:3}).id;
    w.damage(id, 1); assert.equal(w.lostBuildings, 0);
    w.damage(id, 999); assert.equal(w.lostBuildings, 1);
    w.damage(id, 999); assert.equal(w.lostBuildings, 1);
    w.remove({x:4,y:3}); assert.equal(w.lostBuildings, 1);
    w.damage(w.at({x:8,y:1}).id, 999); assert.equal(w.lostBuildings, 1);
});
