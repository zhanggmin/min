const {GameSession} = require('../.test-build/application/GameSession.js');
const map = require('../assets/resources/maps/crossroads.json');
const plan = (kind,x,y,direction=0) => ({kind,x,y,direction});
const coreLine = [plan('drill',16,24), ...[17,18,19,20,21].map(x=>plan('belt',x,24))];
const starter = [plan('drill',20,26), ...[21,22,23,24,25].map(x=>plan('belt',x,26)), plan('turret',26,26)];
const compact = [plan('router',21,26), ...[21,22,23,24,25].map(x=>plan('belt',x,25)),plan('turret',26,25)];
const remote = [29,31].flatMap(x=>[plan('drill',x,14,1),...[15,16,17,18,19,20,21,22].map(y=>plan('belt',x,y,1)),plan('turret',x,23)]);
function simulate(mode){
    const s=new GameSession(map),events=[];
    const step=()=>s.advance(0.05,r=>{if(!r.ok)throw new Error(mode+': '+r.message);});
    s.enqueue({type:'build',plans:[...coreLine,...starter]});
    for(let i=0;i<100;i++)step();
    s.enqueue({type:'startDefense'});
    const startTick=s.world.tick;
    let expanded=false,firstWaveCleared=false, expansionTick, relocated=false, cutTick, emptyTick, damageTick, repairTick, resumedTick;
    while(s.outcome==='playing' && s.world.tick-startTick<18000){
        step();
        if(!firstWaveCleared && s.waves.waveIndex>=1 && s.enemies.enemies.size===0){
            firstWaveCleared=true;events.push({event:'first-wave-clear',seconds:(s.world.tick-startTick)/20,coreHealth:s.enemies.core.health});
        }
        if(!expanded && firstWaveCleared && mode!=='minimum' && s.world.inventory.copper >= (mode==='remote' ? 56 : 20)){
            expanded=true; expansionTick=s.world.tick;
            if(mode.startsWith('compact')){
                s.enqueue({type:'remove',point:{x:21,y:26}});
                s.enqueue({type:'build',plans:compact});
            }else if(mode==='remote')s.enqueue({type:'build',plans:remote});
            events.push({event:'expand',seconds:(s.world.tick-startTick)/20,copper:s.world.inventory.copper});
        }
        if(mode==='remote' && expanded && !relocated && s.world.tick >= expansionTick+200){
            relocated=true;s.enqueue({type:'remove',point:{x:26,y:26}});
            events.push({event:'relocate-to-front',seconds:(s.world.tick-startTick)/20});
        }
        if(mode.startsWith('compact-') && cutTick === undefined && s.waves.waveIndex===5){
            cutTick=s.world.tick-startTick;
            s.enqueue({type:'remove',point:{x:25,y:25}});
            events.push({event:'cut-supply',seconds:cutTick/20,ammo:s.world.at({x:26,y:25}).cargo.length});
        }
        if(cutTick!==undefined && emptyTick===undefined && s.world.at({x:26,y:25})?.cargo.length===0){
            emptyTick=s.world.tick-startTick;
            events.push({event:'ammo-empty',seconds:emptyTick/20});
        }
        if(damageTick===undefined && s.enemies.core.health<600){
            damageTick=s.world.tick-startTick;
            events.push({event:'core-hit',seconds:damageTick/20,health:s.enemies.core.health});
        }
        if(mode==='compact-repaired' && emptyTick!==undefined && repairTick===undefined && s.world.tick-startTick >= emptyTick+200){
            repairTick=s.world.tick-startTick;
            s.enqueue({type:'build',plans:[plan('belt',25,25)]});
            events.push({event:'repair',seconds:repairTick/20});
        }
        if(repairTick!==undefined && resumedTick===undefined && s.world.at({x:26,y:25})?.reload===12){
            resumedTick=s.world.tick-startTick;events.push({event:'repaired-turret-fired',seconds:resumedTick/20});
        }
    }
    const w=s.world;
    return {mode,mapId:map.mapId,revision:map.revision,outcome:s.outcome,seconds:(w.tick-startTick)/20,
        coreHealth:s.enemies.core.health,kills:s.combat.kills,shots:s.combat.shots,spent:w.spent.copper,buildings:w.buildings.size,refunded:w.refunded.copper,events,
        copperBalance:{actual:w.totals().copper,expected:map.initialResources.copper+w.mined.copper+w.refunded.copper-w.spent.copper-w.destroyed.copper-s.combat.shots}};
}
module.exports={simulate,coreLine,starter,compact,remote};
if(require.main===module)console.log(JSON.stringify(['minimum','compact','remote','compact-disconnected','compact-repaired'].map(simulate),null,2));
