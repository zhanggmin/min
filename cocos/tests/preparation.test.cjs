const test = require('node:test');
const assert = require('node:assert/strict');
const {GameSession} = require('../.test-build/application/GameSession.js');
const {validateMap} = require('../.test-build/domain/MapData.js');
const {simulate, coreLine, ammoLine} = require('../tools/tutorial-scenarios.cjs');
const map = require('../assets/resources/maps/copper-tutorial.json');
const run = (session, ticks) => {
    for(let i=0;i<ticks;i++) session.advance(0.05, result => assert.equal(result.ok, true, result.message));
};
const prepare = () => {
    const s = new GameSession(map);
    s.enqueue({type:'build', plans:[...coreLine, ...ammoLine]});
    run(s, 2000);
    return s;
};
const conserved = s => assert.equal(s.world.totals().copper, map.initialResources.copper-s.world.spent.copper
    +s.world.refunded.copper+s.world.mined.copper-s.world.destroyed.copper-s.combat.shots);

test('preparation caps cumulative core deliveries, backpressures intact cargo and spending never resets it', () => {
    const s = prepare(), w = s.world;
    assert.equal(w.delivered.copper, 24);
    assert.equal(w.preparationRemaining('copper'), 0);
    const totals = w.totals(), mined = w.mined.copper;
    assert.equal(w.at({x:21,y:24}).cargo.length, 3);
    assert.equal(s.turretAmmo().copper, 12);
    run(s, 10000);
    assert.equal(w.mined.copper, mined);
    assert.deepEqual(w.totals(), totals);
    s.enqueue({type:'build', plans:[{kind:'wall',x:18,y:20,direction:0}]});
    run(s, 1);
    s.enqueue({type:'remove', point:{x:18,y:20}});
    run(s, 100);
    assert.equal(w.inventory.copper, 64-38+24-2);
    assert.equal(w.delivered.copper, 24);
    assert.equal(w.destroyed.copper, 0);
    conserved(s);
});

test('pause freezes supply and queued confirmation; starting releases backpressure without losing stock', () => {
    const s = prepare(), w = s.world, before = w.tick, stock = w.inventory.copper;
    s.clock.pause();
    s.enqueue({type:'startDefense'});
    assert.equal(s.advance(1000), 0);
    assert.equal(w.tick, before);
    assert.equal(w.inventory.copper, stock);
    assert.equal(s.wavesStarted, false);
    s.clock.resume(); run(s, 1);
    assert.equal(s.wavesStarted, true);
    assert.equal(w.preparationRemaining('copper'), undefined);
    assert.equal(w.delivered.copper, 25);
    assert.equal(w.inventory.copper, stock+1);
    assert.equal(s.waves.remainingTicks, map.waves[0].delayTicks-1);
    conserved(s);
});

test('simultaneous core inputs reserve the last preparation slot only once', () => {
    const s = new GameSession({...map, preparation:{deliveryLimit:{copper:1}},
        ores:[{x:21,y:24,item:'copper'},{x:22,y:23,item:'copper'}]});
    s.enqueue({type:'build', plans:[{kind:'drill',x:21,y:24,direction:0},{kind:'drill',x:22,y:23,direction:1}]});
    run(s, 100);
    assert.equal(s.world.delivered.copper, 1);
    assert.equal(s.world.mined.copper, 10);
    conserved(s);
});

test('legacy maps without preparation budget still deliver freely', () => {
    const source = {...map}; delete source.preparation;
    const s = new GameSession(source);
    s.enqueue({type:'build', plans:coreLine}); run(s, 1000);
    assert.ok(s.world.delivered.copper > 24);
    assert.equal(s.world.preparationRemaining('copper'), undefined);
});

test('preparation configuration rejects invalid budgets, impossible goals and nonmanual maps', () => {
    for(const deliveryLimit of [{}, [], {copper:-1}, {copper:0.5}, {copper:0}, {unknown:3}, null]){
        assert.throws(() => validateMap({...map, preparation:{deliveryLimit}}), /准备期/);
    }
    assert.throws(() => validateMap({...map, tutorial:undefined, waveStart:{...map.waveStart,manual:false}}), /准备期/);
});

test('reference, natural failure and delayed supply repair retain real ammo accounting and a recovery window', () => {
    const reference = simulate('reference'), misplaced = simulate('misplaced');
    const broken = simulate('disconnected'), repaired = simulate('repaired');
    for(const row of [reference, misplaced, broken, repaired]) assert.equal(row.copperBalance.actual, row.copperBalance.expected);
    assert.equal(reference.outcome, 'victory'); assert.equal(reference.kills, 14);
    assert.equal(misplaced.outcome, 'defeat');
    assert.equal(broken.outcome, 'defeat'); assert.equal(broken.shots, broken.ammoBeforeCut);
    assert.ok(broken.emptyAmmoSeconds > 10); // Cached ammo is fired against real enemies after the countdown.
    assert.ok(broken.firstDamageSeconds > broken.emptyAmmoSeconds);
    assert.equal(repaired.outcome, 'victory'); assert.equal(repaired.kills, 14);
    assert.ok(repaired.coreHealth > 0 && repaired.coreHealth < 600);
    assert.equal(repaired.repairSeconds-repaired.firstDamageSeconds, 10);
    assert.ok(repaired.resumedFireSeconds > repaired.repairSeconds);
    assert.ok(repaired.repairSeconds < broken.battleSeconds);
    assert.equal(reference.waveSpawns[3].tick-reference.waveSpawns[2].tick, map.waves[1].delayTicks);
    assert.equal(reference.waveSpawns[8].tick-reference.waveSpawns[7].tick, map.waves[2].delayTicks);
});
