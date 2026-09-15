import {createReadStream, existsSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {extname, join, normalize, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('../build/web-mobile/', import.meta.url)));
if(!existsSync(join(root, 'index.html'))){
    console.error('Web build is missing. Run npm run build:web first.');
    process.exit(2);
}
const port = Number(process.env.PREVIEW_PORT || 8090);
if(!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PREVIEW_PORT must be a valid port');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.bin': 'application/octet-stream'};

createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    let file = resolve(root, `.${normalize(pathname)}`);
    if(file !== root && !file.startsWith(root + sep)){
        response.writeHead(403).end('Forbidden'); return;
    }
    if(existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if(!existsSync(file) || !statSync(file).isFile()){
        response.writeHead(404).end('Not found'); return;
    }
    response.writeHead(200, {'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
    createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}`));
