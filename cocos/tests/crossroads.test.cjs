const test = require('node:test');
const assert = require('node:assert/strict');
const {validateMap} = require('../.test-build/domain/MapData.js');
const {simulate, compact, remote} = require('../tools/crossroads-scenarios.cjs');
const map = require('../assets/resources/maps/crossroads.json');

test('second map uses copper, six waves and player-built defenses with a bounded preparation budget', () => {
    validateMap(map);
    assert.notEqual(map.mapId, require('../assets/resources/maps/copper-tutorial.json').mapId);
    assert.equal(map.buildings.length, 1);
    assert.equal(map.buildings[0].kind, 'core');
    assert.ok(map.allowed.includes('router'));
    assert.equal(map.ores.length, 4);
    assert.ok(map.ores.every(ore => ore.item === 'copper'));
    assert.equal(map.waves.length, 6);
    assert.equal(map.waves.reduce((sum,wave) => sum+wave.count, 0), 88);
    assert.equal(map.waveStart.manual, true);
    assert.equal(map.preparation.deliveryLimit.copper, 24);
});

test('minimum clears the first wave but loses without expansion; compact and remote defenses both win', () => {
    const minimum = simulate('minimum'), near = simulate('compact'), far = simulate('remote');
    assert.equal(minimum.events[0].event, 'first-wave-clear');
    assert.equal(minimum.events[0].coreHealth, 600);
    assert.equal(minimum.outcome, 'defeat');
    for(const row of [near, far]){
        assert.equal(row.outcome, 'victory');
        assert.equal(row.kills, 88);
        assert.ok(row.coreHealth > 0);
        assert.ok(row.events.some(event => event.event === 'expand'));
    }
    assert.ok(near.spent < far.spent);
    assert.ok(near.buildings < far.buildings);
    assert.ok(compact.some(building => building.kind === 'router'));
    assert.equal(remote.filter(building => building.kind === 'drill').length, 2);
    assert.ok(far.events.some(event => event.event === 'relocate-to-front'));
    for(const row of [minimum, near, far]) assert.equal(row.copperBalance.actual, row.copperBalance.expected);
});

test('one missing supply line drains actual cached ammo; delayed repair improves core health and restores that turret', () => {
    const broken = simulate('compact-disconnected'), repaired = simulate('compact-repaired');
    const event = (row, name) => row.events.find(event => event.event === name);
    for(const row of [broken, repaired]){
        assert.equal(event(row, 'cut-supply').ammo, 12);
        assert.ok(event(row, 'ammo-empty').seconds > event(row, 'cut-supply').seconds);
        assert.ok(event(row, 'core-hit').seconds > event(row, 'ammo-empty').seconds);
        assert.equal(row.outcome, 'victory'); // A single missed line is recoverable, not immediate defeat.
        assert.equal(row.copperBalance.actual, row.copperBalance.expected);
    }
    assert.equal(event(repaired, 'repair').seconds-event(repaired, 'ammo-empty').seconds, 10);
    assert.ok(event(repaired, 'repaired-turret-fired').seconds > event(repaired, 'repair').seconds);
    assert.ok(repaired.coreHealth > broken.coreHealth);
    assert.ok(repaired.seconds < broken.seconds);
});
