const test = require('node:test');
const assert = require('node:assert/strict');
const {GameSession} = require('../.test-build/application/GameSession.js');
const {validateMap} = require('../.test-build/domain/MapData.js');
const map = require('../assets/resources/maps/copper-tutorial.json');
const plan = (kind, x, y, direction = 0) => ({kind, x, y, direction});
const run = (session, ticks) => {
    for(let i = 0; i < ticks && session.outcome === 'playing'; i++) session.advance(0.05);
};
const build = (session, plans) => {
    session.enqueue({type: 'build', plans});
    session.advance(0.05, result => assert.equal(result.ok, true, result.message));
};
const coreLine = [plan('drill', 16, 24), ...[17, 18, 19, 20, 21].map(x => plan('belt', x, 24))];
const ammoLine = [plan('drill', 20, 22), ...[21, 22, 23, 24, 25].map(x => plan('belt', x, 22)), plan('turret', 26, 22)];
const ready = () => {
    const session = new GameSession(map);
    build(session, [...coreLine, ...ammoLine]);
    run(session, 100);
    assert.equal(session.canStartDefense, true);
    return session;
};

test('formal copper lesson starts empty, advances goals from real supply and requires confirmation', () => {
    const session = new GameSession(map);
    assert.notEqual(map.mapId, require('../assets/resources/maps/logistics.json').mapId);
    assert.equal(session.world.buildings.size, 1);
    assert.ok(map.ores.every(ore => ore.item === 'copper'));
    assert.equal(session.tutorialStage, 'mine');
    session.enqueue({type: 'startDefense'});
    session.advance(0.05, result => assert.equal(result.ok, false));
    build(session, [coreLine[0]]);
    assert.equal(session.tutorialStage, 'deliver');
    run(session, 100);
    assert.equal(session.world.delivered.copper, 0);
    build(session, coreLine.slice(1));
    run(session, 100);
    assert.equal(session.tutorialStage, 'supply');
    build(session, ammoLine);
    run(session, 100);
    assert.equal(session.tutorialStage, 'ready');
    run(session, 1000);
    assert.equal(session.wavesStarted, false);
    assert.equal(session.waves.remainingTicks, 200);
    assert.equal(session.enemies.enemies.size, 0);
    session.enqueue({type: 'startDefense'});
    session.advance(0.05, result => assert.equal(result.ok, true));
    assert.equal(session.tutorialStage, 'defend');
    assert.equal(session.waves.remainingTicks, 199);
    run(session, 198);
    assert.equal(session.enemies.enemies.size, 0);
    run(session, 1);
    assert.equal(session.enemies.enemies.size, 1);
});

test('confirmation obeys pause, FIFO revalidation and duplicate command rejection', () => {
    const session = ready();
    session.clock.pause();
    session.enqueue({type: 'remove', point: {x: 26, y: 22}});
    session.enqueue({type: 'startDefense'});
    session.advance(60);
    assert.equal(session.tutorialStage, 'ready');
    session.clock.resume();
    const results = [];
    session.advance(0.05, result => results.push(result.ok));
    assert.deepEqual(results, [true, false]);
    assert.equal(session.tutorialStage, 'supply');
    build(session, [plan('turret', 26, 22)]);
    run(session, 100);
    session.enqueue({type: 'startDefense'});
    session.enqueue({type: 'startDefense'});
    results.length = 0;
    session.advance(0.05, result => results.push(result.ok));
    assert.deepEqual(results, [true, false]);
});

test('player-built copper lines clear all three waves and a fresh session resets the lesson', () => {
    const session = ready();
    session.enqueue({type: 'startDefense'});
    run(session, 6000);
    assert.equal(session.outcome, 'victory');
    assert.equal(session.combat.kills, 14);
    assert.ok(session.enemies.core.health > 0);
    const ticks = session.world.tick;
    session.enqueue({type: 'startDefense'});
    session.advance(1);
    assert.equal(session.world.tick, ticks);
    const fresh = new GameSession(map);
    assert.equal(fresh.tutorialStage, 'mine');
    assert.equal(fresh.world.buildings.size, 1);
    assert.equal(fresh.world.inventory.copper, 64);
    assert.equal(fresh.world.delivered.copper, 0);
    assert.equal(fresh.combat.kills, 0);
    assert.equal(fresh.clock.paused, false);
});

test('a supplied turret placed away from the approach naturally loses without dismantling defenses', () => {
    const session = new GameSession(map);
    build(session, [...coreLine, plan('drill', 24, 19), plan('turret', 25, 19)]);
    run(session, 100);
    assert.equal(session.canStartDefense, true);
    session.enqueue({type: 'startDefense'});
    run(session, 6000);
    assert.equal(session.outcome, 'defeat');
    assert.equal(session.enemies.core.health, 0);
});

test('map validation rejects malformed manual start and incomplete copper teaching rules', () => {
    for(const manual of [1, 'true', null]){
        assert.throws(() => validateMap({...map, waveStart: {...map.waveStart, manual}}), /开战确认/);
    }
    for(const change of [{tutorial: 'unknown'}, {waveStart: {manual: true, ammo: {copper: 1}}},
        {waveStart: {...map.waveStart, manual: false}}]){
        assert.throws(() => validateMap({...map, ...change}), /铜教学/);
    }
});
