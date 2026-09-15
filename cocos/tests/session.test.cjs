const test = require('node:test');
const assert = require('node:assert/strict');
const {GameSession, SeededRandom} = require('../.test-build/application/GameSession.js');
const {WaveScheduler} = require('../.test-build/domain/WaveScheduler.js');
const {validateMap} = require('../.test-build/domain/MapData.js');
const plan = (kind, x, y) => ({kind, x, y, direction: 0});
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

test('victory waits for the final spawn and final enemy death then freezes', () => {
    const source = {...map(), waves: [wave({count: 1, delayTicks: 1})]};
    const session = new GameSession(source);
    session.advance(0.05);
    assert.equal(session.waves.complete, true);
    assert.equal(session.enemies.enemies.size, 1);
    assert.equal(session.outcome, 'playing');
    const enemy = [...session.enemies.enemies.values()][0];
    session.enemies.damage(enemy.id, 999);
    session.advance(0.05);
    assert.equal(session.outcome, 'victory');
    assert.equal(session.clock.paused, true);
    const tick = session.world.tick;
    session.clock.resume();
    assert.equal(session.advance(10), 0);
    assert.equal(session.world.tick, tick);
});

test('core death has priority over clearing the final enemy in the same tick', () => {
    const source = {...map(), buildings: [plan('core', 7, 7)], spawns: [{x: 6, y: 7}],
        waves: [wave({count: 1, delayTicks: 999})]};
    const session = new GameSession(source);
    session.enemies.core.health = 1;
    session.enemies.spawn(source.waves[0]);
    const enemy = [...session.enemies.enemies.values()][0];
    session.combat.bullets.set(1, {id: 1, x: 5.5, y: 7, velocityX: 20, velocityY: 0, targetId: enemy.id,
        damage: 999, armorPiercing: 99, remainingTicks: 2, kind: 'heavyTurret'});
    session.advance(0.05);
    assert.equal(session.enemies.core.health, 0);
    assert.equal(session.enemies.enemies.size, 0);
    assert.equal(session.outcome, 'defeat');
});

test('tutorial waves wait for real delivery and both turret ammo requirements', () => {
    const source = {...map(), buildings: [plan('core', 7, 7), plan('turret', 5, 5), plan('heavyTurret', 5, 6)],
        waves: [wave({count: 1, delayTicks: 3})], waveStart: {delivered: {copper: 2}, ammo: {copper: 1, graphite: 1}}};
    const session = new GameSession(source);
    session.advance(5);
    assert.equal(session.wavesStarted, false);
    assert.equal(session.waves.remainingTicks, 3);
    session.world.delivered.copper = 2;
    session.world.at({x: 5, y: 5}).cargo.push({item: 'copper', direction: 0, readyTick: 0});
    session.advance(0.05);
    assert.equal(session.wavesStarted, false);
    session.world.at({x: 5, y: 6}).cargo.push({item: 'graphite', direction: 0, readyTick: 0});
    session.advance(0.05);
    assert.equal(session.wavesStarted, true);
    assert.equal(session.waves.remainingTicks, 2);
});

test('wave start config rejects empty, negative and wave-less conditions', () => {
    assert.throws(() => validateMap({...map(), waveStart: {delivered: {copper: 1}}}), /开战条件/);
    assert.throws(() => validateMap({...map(), waves: [wave()], waveStart: {}}), /开战条件/);
    assert.throws(() => validateMap({...map(), waves: [wave()], waveStart: {ammo: {graphite: -1}}}), /开战条件/);
    assert.throws(() => validateMap({...map(), waves: [wave()], waveStart: {ammo: {coal: 1}}}), /炮塔不能使用煤/);
    assert.throws(() => validateMap({...map(), waves: [wave()], waveStart: {delivered: {unknown: 1, copper: 1}}}), /未知资源/);
});
