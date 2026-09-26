const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const moduleStub = {exports: {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,
    '../assets/scripts/presentation/BattleLayout.ts'), 'utf8'), {compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS
}}).outputText, {exports: moduleStub.exports});
const {battleLayout} = moduleStub.exports;
for(const [width,height,left,right] of [[1280,720,0,0],[960,720,0,0],[854,480,32,24],[1040,480,44,44]]){
    test(`battle controls and inspector fit ${width}x${height} with safe insets`, () => {
        const l = battleLayout(width,height,left,right);
        assert.ok(l.mapHeight >= 224);
        assert.ok(l.mapTop <= l.missionY-28);
        assert.ok(l.mapBottom >= l.statusY+16);
        assert.ok(l.detailHeight+8 <= l.mapHeight);
        assert.ok(l.dockY+32 < l.statusY-16);
        assert.ok(l.left+84+l.toolArea <= l.right-160);
        assert.ok(l.toolArea>=2*112+8, 'at least two whole tools visible');
        const cell=Math.max(28,Math.min(64,l.available/21,l.mapHeight/8));
        assert.ok((33.5-24.5)*cell<width/2-cell/2,'enemy entrance visible on first level');
        assert.ok(Math.abs(19.5-23)*cell<l.mapHeight/2,'lower mine visible on first level');
    });
}

for(const [width,height,top,bottom] of [[600,1068,0,0],[600,1299,72,52],[600,800,30,24]]){
    test(`portrait map and two-row controls fit ${width}x${height}`, () => {
        const l=battleLayout(width,height,0,0,top,bottom);
        assert.equal(l.portrait,true);
        assert.ok(l.mapHeight>=224);
        assert.ok(l.mapTop<=l.missionY-l.mission/2);
        assert.ok(l.mapBottom>=l.statusY+16);
        assert.ok(l.left+84+l.toolArea<=l.right);
        assert.ok(l.toolArea>=3*112+16);
        assert.ok(l.dockY+28+32<l.statusY-16);
        assert.ok(l.dockY-44-24>=l.bottom);
        const cell=Math.max(16,Math.min(64,l.available/21,l.mapHeight/8));
        assert.ok(9*cell<width/2-cell/2,'enemy entrance visible in portrait');
    });
}
