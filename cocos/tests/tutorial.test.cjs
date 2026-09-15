const test = require('node:test');
const assert = require('node:assert/strict');
const {GameSession} = require('../.test-build/application/GameSession.js');

const belt = (x, y) => ({kind: 'belt', x, y, direction: 0});
const run = (session, ticks) => {
    for(let i = 0; i < ticks && session.outcome === 'playing'; i++) session.advance(0.05);
};

test('shipped tutorial connects three supply gaps then reaches a battle result', () => {
    const map = require('../assets/resources/maps/logistics.json');
    const session = new GameSession(map);
    session.enqueue({type: 'build', plans: [belt(20, 19), belt(20, 24), belt(20, 26)]});
    run(session, 500);
    assert.equal(session.wavesStarted, true);
    assert.ok(session.world.delivered.copper >= 5);
    run(session, 2500);
    assert.equal(session.outcome, 'victory');
    assert.equal(session.combat.kills, 7);
});

test('shipped tutorial can fail after the player dismantles the prepared defense', () => {
    const map = require('../assets/resources/maps/logistics.json');
    const session = new GameSession(map);
    session.enqueue({type: 'build', plans: [belt(20, 19), belt(20, 24), belt(20, 26)]});
    run(session, 500);
    assert.equal(session.wavesStarted, true);
    session.enqueue({type: 'remove', point: {x: 24, y: 19}});
    session.enqueue({type: 'remove', point: {x: 28, y: 26}});
    run(session, 2500);
    assert.equal(session.outcome, 'defeat');
    assert.equal(session.enemies.core.health, 0);
});
