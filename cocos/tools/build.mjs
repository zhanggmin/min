import {accessSync, constants, existsSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2];
if(!['web-mobile', 'wechatgame'].includes(platform)){
    console.error('Usage: node tools/build.mjs <web-mobile|wechatgame>');
    process.exit(2);
}

const candidates = [
    process.env.COCOS_CREATOR,
    '/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator',
    'C:\\Program Files\\CocosCreator\\Creator\\3.8.8\\CocosCreator.exe'
].filter(Boolean);
const creator = candidates.find(path => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});
if(!creator){
    console.error('Cocos Creator 3.8.8 executable not found. Set COCOS_CREATOR to its absolute path.');
    process.exit(2);
}

const config = join(root, 'build-configs', `${platform}.json`);
const sentinel = join(root, 'build', platform, platform === 'web-mobile' ? 'index.html' : 'game.js');
const started = Date.now();
const result = spawnSync(creator, ['--project', root, '--build', `configPath=${config}`], {cwd: root, encoding: 'utf8'});
if(result.stdout) process.stdout.write(result.stdout);
if(result.stderr) process.stderr.write(result.stderr);

// Creator 3.8.8 on macOS may return 36 after logging a successful headless build.
const freshOutput = existsSync(sentinel) && statSync(sentinel).mtimeMs >= started - 2000;
if(result.error || !freshOutput){
    console.error(result.error ? String(result.error) : `Build output was not refreshed: ${sentinel}`);
    process.exit(result.status || 1);
}
if(result.status && result.status !== 36){
    console.error(`Creator exited with unexpected code ${result.status}.`);
    process.exit(result.status);
}
if(result.status === 36) console.warn('Creator exited with its known post-build code 36; refreshed output was verified.');
console.log(`Build ready: ${sentinel}`);
