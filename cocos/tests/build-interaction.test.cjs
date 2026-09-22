const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const {GameSession} = require('../.test-build/application/GameSession.js');
const source = fs.readFileSync(path.join(__dirname, '../assets/scripts/presentation/GameApp.ts'), 'utf8');
// Execute the actual UI handlers with only Cocos lifecycle/rendering replaced.
// These checks do not claim to validate touch hit areas or rendered output.
const compiled = ts.transpileModule(source, {compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true
}}).outputText;
const moduleStub = {exports: {}};
vm.runInNewContext(compiled, {
    exports: moduleStub.exports,
    require(name){
        if(name === 'cc') return {Component: class {}, _decorator: {ccclass: () => value => value, property: () => {}}};
        if(name === './GameWidgets') return {palette: {}, rgba: value => value};
        if(name === '../platform/PlatformService') return {PlatformService: class {}};
        return require(path.join(__dirname, '../.test-build', name.replace('../', '')));
    }
});
const {GameApp} = moduleStub.exports;
const point = {x: 18, y: 20};
const fixture = () => {
    const session = new GameSession(require('../assets/resources/maps/copper-tutorial.json'));
    const app = new GameApp();
    app.session = session; app.world = session.world;
    app.infoLabel = {string: ''}; app.statusLabel = {string: ''}; app.confirmLabel = {string: ''};
    app.selected = 'wall'; app.selection = {...point};
    app.plans = [{kind: 'wall', ...point, direction: 0}];
    app.confirmAction(); session.advance(0.05, result => app.commandResult(result));
    assert.equal(session.world.at(point).kind, 'wall');
    return {app, session};
};

test('built target survives switching to remove and confirmation actually dismantles it', () => {
    const {app, session} = fixture();
    const before = session.world.inventory.copper;
    app.choose('remove');
    assert.equal(app.selection.x, point.x);
    assert.equal(app.confirmLabel.string, '确认拆除');
    assert.match(app.infoLabel.string, /返还 2铜/);
    app.confirmAction();
    assert.ok(session.world.at(point)); // Authoritative change happens at next simulation step.
    session.advance(0.05, result => app.commandResult(result));
    assert.equal(session.world.at(point), undefined);
    assert.equal(session.world.inventory.copper, before+2);
    app.confirmAction(); session.advance(0.05, result => app.commandResult(result));
    assert.equal(session.world.inventory.copper, before+2);
});

test('remove mode supports selecting afterward and cancel does not remove or refund', () => {
    const {app, session} = fixture();
    app.choose('browse'); app.choose('remove');
    app.confirmAction();
    assert.match(app.statusLabel.string, /先点击要拆除/);
    app.grid = () => ({...point});
    app.touchEnd({});
    assert.match(app.infoLabel.string, /拆除 墙/);
    app.choose('browse'); app.confirmAction(); session.advance(0.05, result => app.commandResult(result));
    assert.ok(session.world.at(point));
    assert.equal(session.world.refunded.copper, 0);
    app.choose('remove'); app.touchEnd({}); app.confirmAction(); session.advance(0.05, result => app.commandResult(result));
    assert.equal(session.world.at(point), undefined);
});

test('paused removal applies immediately, resumes once, and core or empty cells are rejected clearly', () => {
    const {app, session} = fixture();
    session.clock.pause(); app.choose('remove'); app.confirmAction();
    assert.match(app.statusLabel.string, /拆除/);
    session.advance(1); assert.equal(session.world.at(point), undefined);
    session.clock.resume(); session.advance(0.05, result => app.commandResult(result)); assert.equal(session.world.at(point), undefined);
    app.selection = {...point}; app.confirmAction();
    assert.match(app.statusLabel.string, /没有建筑/);
    app.selection = {x: 22, y: 24}; app.confirmAction();
    assert.match(app.statusLabel.string, /核心不可拆除/);
    assert.equal(session.world.refunded.copper, 2);
});

test('dragging in browse mode does not change selection and ended battles reject removal', () => {
    const {app, session} = fixture();
    app.choose('browse'); app.touchTravel = 20;
    app.grid = () => ({...point}); app.touchEnd({});
    assert.equal(app.selection, undefined);
    app.touchTravel = 0; app.touchEnd({});
    assert.equal(app.selection.x, point.x);
    app.choose('remove'); session.outcome = 'victory'; app.confirmAction();
    assert.match(app.statusLabel.string, /战斗已经胜利/);
    assert.ok(app.selection);
    assert.ok(session.world.at(point));
});

test('paused building is immediate, invalid batches are atomic, and repeated confirms do not double spend', () => {
    const {app,session}=fixture();
    session.clock.pause();
    const tick=session.world.tick, copper=session.world.inventory.copper;
    app.choose('wall'); app.plans=[{kind:'wall',x:19,y:20,direction:0}];
    app.confirmAction();
    assert.equal(session.world.at({x:19,y:20}).kind,'wall');
    assert.equal(session.world.tick,tick);
    assert.equal(session.world.inventory.copper,copper-4);
    app.confirmAction(); assert.equal(session.world.inventory.copper,copper-4);
    app.plans=[{kind:'wall',x:20,y:20,direction:0},{kind:'wall',x:19,y:20,direction:0}];
    app.confirmAction();
    assert.equal(session.world.at({x:20,y:20}),undefined);
    assert.equal(session.world.inventory.copper,copper-4);
    session.clock.resume(); app.plans=[{kind:'wall',x:20,y:20,direction:0}];
    app.confirmAction(); app.confirmAction();
    session.advance(.05,result => app.commandResult(result));
    assert.equal(session.world.inventory.copper,copper-8);
});

test('paused start-defense resumes only after current supply revalidation succeeds', () => {
    const {app,session}=fixture();
    session.clock.pause(); const tick=session.world.tick;
    assert.equal(app.submit({type:'startDefense'}),false);
    assert.equal(session.clock.paused,true);
    session.world.delivered.copper=10;
    session.world.build([{kind:'turret',x:26,y:22,direction:0}]);
    const turret=session.world.at({x:26,y:22});
    for(let i=0;i<6;i++) turret.cargo.push({item:'copper',direction:0,readyTick:0});
    assert.equal(app.submit({type:'startDefense'}),true);
    assert.equal(session.clock.paused,false);
    assert.equal(session.wavesStarted,true);
    assert.equal(session.world.tick,tick);
    assert.equal(session.waves.remainingTicks,200);
});
