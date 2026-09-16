// Deterministic balance evidence; run after npm test compiles the simulation.
const {GameSession} = require('../.test-build/application/GameSession.js');
const map = require('../assets/resources/maps/copper-tutorial.json');
const plan = (kind, x, y, direction = 0) => ({kind, x, y, direction});
const coreLine = [plan('drill', 16, 24), ...[17, 18, 19, 20, 21].map(x => plan('belt', x, 24))];
const ammoLine = [plan('drill', 20, 22), ...[21, 22, 23, 24, 25].map(x => plan('belt', x, 22)), plan('turret', 26, 22)];
function simulate(mode){
    const session = new GameSession(map);
    session.enqueue({type: 'build', plans: [...coreLine, ...(mode === 'misplaced'
        ? [plan('drill', 24, 19), plan('turret', 25, 19)] : ammoLine)]});
    const step = () => session.advance(0.05, result => {
        if(!result.ok) throw new Error(result.message);
    });
    for(let i=0;i<100;i++) step();
    const ammoBeforeCut = session.turretAmmo().copper;
    if(mode === 'disconnected' || mode === 'repaired') session.enqueue({type: 'remove', point: {x: 25, y: 22}});
    session.enqueue({type: 'startDefense'});
    const startTick = session.world.tick;
    let firstDamage, emptyTick, repairTick, resumedTick, shotsAtRepair, minimumHealth = 600;
    const waveSpawns = [], originalSpawn = session.enemies.spawn.bind(session.enemies);
    session.enemies.spawn = wave => {
        const spawned = originalSpawn(wave);
        if(spawned) waveSpawns.push({tick: session.world.tick-startTick, enemy: wave.enemy});
        return spawned;
    };
    while(session.outcome === 'playing' && session.world.tick-startTick < 6000){
        step();
        const tick = session.world.tick-startTick;
        minimumHealth = Math.min(minimumHealth, session.enemies.core.health);
        if(firstDamage === undefined && session.enemies.core.health < 600) firstDamage = tick;
        if(emptyTick === undefined && session.turretAmmo().copper === 0) emptyTick = tick;
        if(mode === 'repaired' && firstDamage !== undefined && repairTick === undefined && tick >= firstDamage+200){
            shotsAtRepair = session.combat.shots;
            repairTick = tick;
            session.enqueue({type: 'build', plans: [plan('belt', 25, 22)]});
        }
        if(repairTick !== undefined && resumedTick === undefined && session.combat.shots > shotsAtRepair) resumedTick = tick;
    }
    const world = session.world;
    return {mode, mapId: map.mapId, revision: map.revision, outcome: session.outcome,
        battleSeconds: (world.tick-startTick)/20, coreHealth: session.enemies.core.health,
        kills: session.combat.kills, shots: session.combat.shots, ammoBeforeCut,
        firstDamageSeconds: firstDamage === undefined ? null : firstDamage/20,
        emptyAmmoSeconds: emptyTick === undefined ? null : emptyTick/20,
        repairSeconds: repairTick === undefined ? null : repairTick/20,
        resumedFireSeconds: resumedTick === undefined ? null : resumedTick/20,
        minimumHealth, waveSpawns,
        copperBalance: {actual: world.totals().copper, expected: map.initialResources.copper-world.spent.copper
            +world.refunded.copper+world.mined.copper-world.consumed.copper-world.destroyed.copper-session.combat.shots}};
}
module.exports = {simulate, coreLine, ammoLine};
if(require.main === module) console.log(JSON.stringify(['reference', 'misplaced', 'disconnected', 'repaired'].map(simulate), null, 2));
