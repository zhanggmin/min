const test = require('node:test');
const assert = require('node:assert/strict');
const {GameSession} = require('../.test-build/application/GameSession.js');
const {CombatSystem} = require('../.test-build/domain/CombatSystem.js');
const {EnemySystem} = require('../.test-build/domain/EnemySystem.js');
const {World} = require('../.test-build/domain/World.js');

const plan = (kind, x, y) => ({kind, x, y, direction: 0});
const wave = (enemy = 'normal') => ({enemy, spawn: 0, count: 1, delayTicks: 999, intervalTicks: 1});
const map = (turrets = []) => ({schemaVersion: 1, mapId: 'combat', revision: 1, name: 'test', width: 16, height: 16,
    initialResources: {copper: 100, coal: 0, graphite: 100}, ores: [], rocks: [], spawns: [{x: 4, y: 7}],
    buildings: [plan('core', 14, 7), ...turrets], allowed: ['turret', 'heavyTurret', 'wall'], waves: [wave()]});
const cargo = item => ({item, direction: 0, readyTick: 0});

test('ordinary turret requires copper ammo, acquires nearby target and obeys reload', () => {
    const session = new GameSession(map([plan('turret', 7, 7)]));
    const turret = session.world.at({x: 7, y: 7});
    assert.equal(session.enemies.spawn(wave()), true);
    session.combat.step();
    assert.equal(session.combat.shots, 0);
    turret.cargo.push(cargo('copper'), cargo('copper'));
    session.combat.step();
    assert.equal(session.combat.shots, 1);
    assert.equal(turret.cargo.length, 1);
    for(let i = 0; i < 11; i++) session.combat.step();
    assert.equal(session.combat.shots, 1);
    session.combat.step();
    assert.equal(session.combat.shots, 2);
});

test('heavy turret pierces armor while ordinary damage is reduced', () => {
    const ordinaryWorld = new World(map()), ordinaryEnemies = new EnemySystem(ordinaryWorld);
    ordinaryEnemies.spawn(wave('armored'));
    const ordinary = [...ordinaryEnemies.enemies.values()][0];
    assert.equal(ordinaryEnemies.damage(ordinary.id, 22), 12);
    assert.equal(ordinary.health, 168);

    const heavyWorld = new World(map()), heavyEnemies = new EnemySystem(heavyWorld);
    heavyEnemies.spawn(wave('armored'));
    const heavy = [...heavyEnemies.enemies.values()][0];
    assert.equal(heavyEnemies.damage(heavy.id, 75, 10), 75);
    assert.equal(heavy.health, 105);
});

test('swept collision hits an enemy crossed between two logic positions', () => {
    const world = new World(map()), enemies = new EnemySystem(world), combat = new CombatSystem(world, enemies);
    enemies.spawn(wave());
    const enemy = [...enemies.enemies.values()][0];
    combat.bullets.set(1, {id: 1, x: 0, y: 7, velocityX: 100, velocityY: 0, targetId: -1,
        damage: 60, armorPiercing: 0, remainingTicks: 2, kind: 'turret'});
    combat.step();
    assert.equal(enemies.enemies.has(enemy.id), false);
    assert.equal(combat.hits, 1);
    assert.equal(combat.kills, 1);
});

test('enemy death releases origin and destination reservations', () => {
    const world = new World(map()), enemies = new EnemySystem(world);
    enemies.spawn(wave());
    enemies.field.update(10000);
    enemies.step();
    const enemy = [...enemies.enemies.values()][0];
    assert.notEqual(enemy.cell, enemy.target);
    assert.equal(world.unitCells.size, 2);
    enemies.damage(enemy.id, 999);
    assert.equal(world.unitCells.size, 0);
});

test('two bullets in one tick cannot damage or count the same death twice', () => {
    const world = new World(map()), enemies = new EnemySystem(world), combat = new CombatSystem(world, enemies);
    enemies.spawn(wave('fast'));
    const enemy = [...enemies.enemies.values()][0];
    for(const id of [1, 2]) combat.bullets.set(id, {id, x: 3.5, y: 7, velocityX: 20, velocityY: 0, targetId: enemy.id,
        damage: 100, armorPiercing: 0, remainingTicks: 2, kind: 'turret'});
    combat.step();
    assert.equal(combat.hits, 1);
    assert.equal(combat.kills, 1);
    assert.equal(combat.bullets.size, 1);
});

test('combat state replays identically across frame partitions', () => {
    const source = map([plan('turret', 7, 7), plan('heavyTurret', 8, 8)]);
    const a = new GameSession(source), b = new GameSession(source);
    for(const session of [a, b]){
        session.world.at({x: 7, y: 7}).cargo.push(...Array.from({length: 12}, () => cargo('copper')));
        session.world.at({x: 8, y: 8}).cargo.push(...Array.from({length: 6}, () => cargo('graphite')));
        session.enemies.spawn(wave('armored'));
    }
    for(let frame = 0; frame < 20; frame++){
        a.advance(0.15);
        for(let step = 0; step < 3; step++) b.advance(0.05);
    }
    assert.deepEqual([...a.enemies.enemies.values()], [...b.enemies.enemies.values()]);
    assert.deepEqual([...a.combat.bullets.values()], [...b.combat.bullets.values()]);
    assert.deepEqual([a.combat.shots, a.combat.hits, a.combat.kills], [b.combat.shots, b.combat.hits, b.combat.kills]);
});
