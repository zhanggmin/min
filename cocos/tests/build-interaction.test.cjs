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
    app.confirmAction(); session.advance(0.05);
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
    session.advance(0.05);
    assert.equal(session.world.at(point), undefined);
    assert.equal(session.world.inventory.copper, before+2);
    app.confirmAction(); session.advance(0.05);
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
    app.choose('browse'); app.confirmAction(); session.advance(0.05);
    assert.ok(session.world.at(point));
    assert.equal(session.world.refunded.copper, 0);
    app.choose('remove'); app.touchEnd({}); app.confirmAction(); session.advance(0.05);
    assert.equal(session.world.at(point), undefined);
});

test('paused removal is queued, resumes once, and core or empty cells are rejected clearly', () => {
    const {app, session} = fixture();
    session.clock.pause(); app.choose('remove'); app.confirmAction();
    assert.match(app.statusLabel.string, /已排队/);
    session.advance(1); assert.ok(session.world.at(point));
    session.clock.resume(); session.advance(0.05); assert.equal(session.world.at(point), undefined);
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
