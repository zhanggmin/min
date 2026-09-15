const test = require('node:test');
const assert = require('node:assert/strict');
const {World} = require('../.test-build/domain/World.js');
const {EnemySystem} = require('../.test-build/domain/EnemySystem.js');
const {DistanceField} = require('../.test-build/domain/DistanceField.js');
const {GameSession} = require('../.test-build/application/GameSession.js');
const {validateMap} = require('../.test-build/domain/MapData.js');
const plan = (kind, x, y) => ({kind, x, y, direction: 0});
const wave = {enemy: 'normal', spawn: 0, count: 6, delayTicks: 1, intervalTicks: 1};
const map = () => ({schemaVersion: 1, mapId: 'enemies', revision: 1, name: 'test', width: 16, height: 16,
    initialResources: {copper: 100, coal: 0, graphite: 0}, ores: [], rocks: [], spawns: [{x: 1, y: 7}],
    buildings: [plan('core', 12, 7)], allowed: ['wall', 'belt', 'storage'], waves: [{...wave}]});
function corridor(){
    const m = map();
    for(let x = 0; x < 16; x++) for(const y of [6, 8]) m.rocks.push({x, y});
    m.buildings.push(plan('wall', 6, 7));
    return m;
}
const run = (s, ticks) => { for(let i = 0; i < ticks; i++) s.advance(0.05); };

test('shared weighted field prefers a short detour over breaking a wall', () => {
    const m = map(); m.buildings.push(plan('wall', 6, 7));
    const w = new World(m), enemies = new EnemySystem(w);
    enemies.spawn(wave);
    for(let i = 0; i < 220; i++) enemies.step();
    assert.equal(w.at({x: 6, y: 7}).health, 200);
    assert.ok(enemies.core.health < 600);
    assert.equal(enemies.field.rebuilds, 1);
});

test('sealed corridor enemies destroy wall without refunds then reach core', () => {
    const s = new GameSession(corridor());
    run(s, 800);
    assert.equal(s.world.at({x: 6, y: 7}), undefined);
    assert.equal(s.world.refunded.copper, 0);
    assert.ok(s.enemies.core.health < 600);
    assert.ok(s.enemies.field.rebuilds >= 2);
});

test('distance rebuild is budgeted and publishes complete fields only', () => {
    const w = new World(map()), field = new DistanceField(w, 7 * 16 + 12);
    assert.equal(field.update(1), 1); assert.equal(field.revision, -1);
    assert.equal(field.at(7 * 16 + 1), Infinity);
    while(field.revision < 0) assert.ok(field.update(7) <= 7);
    assert.equal(field.at(7 * 16 + 1), 11);
    w.build([plan('wall', 6, 7)]);
    field.update(1);
    assert.equal(field.at(7 * 16 + 1), 11);
    while(field.revision !== w.revision) field.update(7);
    assert.equal(field.at(7 * 16 + 1), 13);
    w.remove({x: 6, y: 7});
    while(field.revision !== w.revision) field.update(7);
    assert.equal(field.at(7 * 16 + 1), 11);
});

test('building changes during a rebuild trigger another refresh without starving publication', () => {
    const w = new World(map()), field = new DistanceField(w, 124);
    field.update(1); w.build([plan('wall', 6, 7)]);
    for(let i = 0; i < 600; i++) field.update(1);
    assert.equal(field.revision, w.revision); assert.equal(field.rebuilds, 2);
});

test('enemy reservations reject construction and prevent overlap in crowds', () => {
    const s = new GameSession(corridor());
    for(let i = 0; i < 450; i++){
        s.advance(0.05);
        const reserved = new Set();
        for(const e of s.enemies.enemies.values()){
            for(const cell of new Set([e.cell, e.target])){
                assert.equal(reserved.has(cell), false); reserved.add(cell);
            }
            assert.equal(s.world.build([plan('wall', e.target % 16, Math.floor(e.target / 16))]).ok, false);
        }
        assert.deepEqual(reserved, s.world.unitCells);
    }
    assert.equal(s.enemies.enemies.size, 6);
});

test('spawn congestion retains wave cursor; 120 live units reject further spawns', () => {
    const m = map(); m.spawns = [];
    for(let y = 0; y < 8; y++) for(let x = 0; x < 16; x++) if(x !== 12 || y !== 7) m.spawns.push({x, y});
    const s = new GameSession(m);
    for(let i = 0; i < 120; i++) assert.equal(s.enemies.spawn({...wave, spawn: i}), true);
    assert.equal(s.enemies.spawn({...wave, spawn: 120}), false);
    s.advance(0.05);
    assert.equal(s.waves.spawned, 0); assert.equal(s.waves.complete, false);
    const blocked = new GameSession(map());
    blocked.enemies.spawn(wave); blocked.advance(0.05);
    assert.equal(blocked.waves.spawned, 0);
});

test('destroyed building cargo is accounted exactly once and never refunded', () => {
    const w = new World(map()); w.build([plan('storage', 5, 5)]);
    const b = w.at({x: 5, y: 5}); b.cargo.push({item: 'copper', direction: 0, readyTick: 0});
    assert.equal(w.damage(b.id, 999), true); assert.equal(w.damage(b.id, 999), false);
    assert.equal(w.destroyed.copper, 1); assert.equal(w.refunded.copper, 0);
    assert.equal(w.build([plan('storage', 5, 5)]).ok, true);
});

test('core death freezes session even if resume is requested', () => {
    const m = map(); m.spawns = [{x: 11, y: 7}];
    const s = new GameSession(m); s.enemies.core.health = 1;
    assert.equal(s.advance(0.2), 1);
    assert.equal(s.enemies.defeated, true); assert.equal(s.clock.paused, true);
    const tick = s.world.tick;
    s.clock.resume(); s.enqueue({type: 'build', plans: [plan('wall', 4, 4)]}); run(s, 20);
    assert.equal(s.world.tick, tick); assert.equal(s.world.at({x: 4, y: 4}), undefined);
});

test('rock-isolated wave spawn is rejected before starting', () => {
    const m = map();
    for(const [x, y] of [[0, 7], [2, 7], [1, 6], [1, 8]]) m.rocks.push({x, y});
    assert.throws(() => validateMap(m), /岩石隔断/);
});

test('real wave movement replays across frame partitions and pause', () => {
    const a = new GameSession(corridor()), b = new GameSession(corridor());
    run(a, 300);
    for(let i = 0; i < 100; i++) b.advance(0.15);
    assert.deepEqual([...a.enemies.enemies.values()], [...b.enemies.enemies.values()]);
    assert.deepEqual([...a.world.buildings.values()], [...b.world.buildings.values()]);
    const state = JSON.stringify([...b.enemies.enemies.values()]);
    b.clock.pause(); b.advance(100);
    assert.equal(JSON.stringify([...b.enemies.enemies.values()]), state);
});

test('shipped invasion map runs from spawning through wall destruction and core loss', () => {
    const m = require('../assets/resources/maps/pathfinding.json');
    const s = new GameSession(m);
    run(s, 3000);
    assert.equal(s.enemies.defeated, true);
    assert.equal(s.world.at({x: 25, y: 24}), undefined);
});
