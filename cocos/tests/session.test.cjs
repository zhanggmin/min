const test = require('node:test');
const assert = require('node:assert/strict');
const {GameSession, SeededRandom} = require('../.test-build/application/GameSession.js');
const {WaveScheduler} = require('../.test-build/domain/WaveScheduler.js');
const {validateMap} = require('../.test-build/domain/MapData.js');
const map = () => ({schemaVersion: 1, mapId: 'session', revision: 1, name: 'test', width: 8, height: 8,
    initialResources: {copper: 20, coal: 0, graphite: 0}, ores: [], rocks: [], spawns: [{x: 0, y: 0}],
    buildings: [{kind: 'core', x: 7, y: 7, direction: 0}], allowed: ['belt', 'wall']});
const build = () => ({type: 'build', plans: [{kind: 'belt', x: 1, y: 1, direction: 0}]});
const wave = (changes = {}) => ({enemy: 'normal', spawn: 0, count: 2, delayTicks: 3, intervalTicks: 2, ...changes});

test('commands execute FIFO at a step boundary and keep independent results', () => {
    const session = new GameSession(map());
    session.enqueue(build());
    session.enqueue(build());
    session.enqueue({type: 'rotate', point: {x: 1, y: 1}});
    assert.equal(session.world.buildings.size, 1);
    const results = [];
    session.advance(0.05, result => results.push(result));
    assert.deepEqual(results.map(r => [r.sequence, r.tick, r.ok]), [[1, 1, true], [2, 1, false], [3, 1, true]]);
    assert.equal(session.world.inventory.copper, 19);
    assert.equal(session.world.at({x: 1, y: 1}).direction, 1);
});

test('queued commands and source map cannot be changed by callers', () => {
    const source = map(), session = new GameSession(source), command = build();
    session.enqueue(command);
    command.plans[0].x = 6;
    source.allowed.length = 0;
    session.advance(0.05);
    assert.ok(session.world.at({x: 1, y: 1}));
    assert.equal(session.world.at({x: 6, y: 1}), undefined);
});

test('paused commands wait and background time never catches up', () => {
    const session = new GameSession(map());
    session.advance(0.04);
    session.clock.pause(); session.enqueue(build());
    assert.equal(session.advance(600), 0);
    assert.equal(session.world.buildings.size, 1);
    session.clock.resume(); session.advance(0.01);
    assert.equal(session.world.tick, 0);
    session.advance(0.04);
    assert.equal(session.world.tick, 1);
    assert.equal(session.world.buildings.size, 2);
});

test('same commands and seed replay identically across frame partitions', () => {
    const a = new GameSession(map(), 123), b = new GameSession(map(), 123);
    for(const session of [a, b]) session.enqueue(build());
    assert.equal(a.advance(0.15), 3);
    for(let i = 0; i < 15; i++) b.advance(0.01);
    assert.equal(a.world.tick, b.world.tick);
    assert.deepEqual([...a.world.buildings.values()], [...b.world.buildings.values()]);
    assert.deepEqual(a.world.inventory, b.world.inventory);
    assert.deepEqual(Array.from({length: 20}, () => a.random.next()), Array.from({length: 20}, () => b.random.next()));
    const restored = new SeededRandom(a.random.state);
    assert.equal(restored.next(), a.random.next());
    assert.throws(() => new SeededRandom(NaN));
});

test('wave delay, spacing and next-wave cursor use exact ticks', () => {
    const waves = new WaveScheduler([wave(), wave({enemy: 'fast', count: 1, delayTicks: 2})]);
    const events = [];
    for(let tick = 1; tick <= 10; tick++) waves.step(w => { events.push([tick, w.enemy]); return true; });
    assert.deepEqual(events, [[3, 'normal'], [5, 'normal'], [7, 'fast']]);
    assert.equal(waves.complete, true);
});

test('enemy cap delays spawns without losing count or completing early', () => {
    const waves = new WaveScheduler([wave({delayTicks: 0})]);
    for(let i = 0; i < 100; i++) waves.step(() => false);
    assert.equal(waves.complete, false); assert.equal(waves.spawned, 0);
    let spawned = 0;
    waves.step(() => { spawned++; return true; });
    waves.step(() => { throw new Error('interval must elapse'); });
    assert.equal(waves.complete, false);
    waves.step(() => false);
    waves.step(() => { spawned++; return true; });
    assert.equal(spawned, 2); assert.equal(waves.complete, true);
    assert.equal(new WaveScheduler([]).complete, true);
});

test('wave config rejects bad IDs, missing spawns, counts and noninteger times', () => {
    for(const changes of [{enemy: 'unknown'}, {spawn: 1}, {count: 0}, {delayTicks: -1}, {intervalTicks: 0}, {intervalTicks: 1.5}]){
        assert.throws(() => validateMap({...map(), waves: [wave(changes)]}), /波次/);
    }
    validateMap({...map(), waves: [wave()]});
    validateMap(map());
});
