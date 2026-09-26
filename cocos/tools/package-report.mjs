import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requested = process.argv[2];
const platform = requested || (existsSync(resolve(root, 'build/wechatgame')) ? 'wechatgame' : 'web-mobile');
if(!['web-mobile', 'wechatgame'].includes(platform)){
    console.error('Usage: node tools/package-report.mjs [web-mobile|wechatgame]'); process.exit(2);
}
const output = resolve(root, 'build', platform);
if(!existsSync(output)){
    console.error(`Build output is missing: ${output}`); process.exit(2);
}
const files = [];
const visit = directory => {
    for(const name of readdirSync(directory)){
        const path = resolve(directory, name), stat = statSync(path);
        if(stat.isDirectory()) visit(path); else files.push({path: relative(output, path), bytes: stat.size});
    }
};
visit(output);
files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
const total = files.reduce((sum, file) => sum + file.bytes, 0);
const size = bytes => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
console.log(`${platform}: ${files.length} files, ${size(total)}`);
console.log('Largest files:');
for(const file of files.slice(0, 20)) console.log(`${size(file.bytes).padStart(10)}  ${file.path}`);
if(platform === 'wechatgame'){
    const game = JSON.parse(readFileSync(resolve(output, 'game.json'), 'utf8'));
    const packages = (game.subpackages || game.subPackages || []).map(pack => ({
        name: pack.name,
        root: pack.root.replace(/\/$/, '') + '/'
    }));
    const inPackage = (file, pack) => file.path.split('\\').join('/').startsWith(pack.root);
    const mainBytes = files.filter(file => !packages.some(pack => inPackage(file, pack)))
        .reduce((sum, file) => sum + file.bytes, 0);
    console.log(`Main package: ${size(mainBytes)} / 4 MiB`);
    for(const pack of packages){
        const bytes = files.filter(file => inPackage(file, pack)).reduce((sum, file) => sum + file.bytes, 0);
        console.log(`Subpackage ${pack.name}: ${size(bytes)}`);
    }
    console.log('Local file sizes; verify final packaged sizes in WeChat DevTools.');
    if(mainBytes > 4 * 1024 * 1024) process.exitCode = 1;
}
