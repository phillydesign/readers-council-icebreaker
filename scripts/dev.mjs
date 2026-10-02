import { createServer } from 'node:http';
import { readFile,mkdir } from 'node:fs/promises';
import { createAPI } from '../server/core.mjs';
import { localDB } from './local-db.mjs';
import './build.mjs';
await mkdir('.local-data',{recursive:true});
const db = await localDB('.local-data/postgres');
// Local rehearsal uses a fixed passphrase. It is never a production fallback.
const localAPI = createAPI({db,hostPassword:process.env.HOST_PASSWORD || 'rehearsal-only-local',local:true});
const server = createServer(async(req,res)=>{
  try {
    const url = new URL(req.url,`http://${req.headers.host || '127.0.0.1:4173'}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const request = new Request(url,{method:req.method,headers:req.headers,...(req.method!=='GET'&&req.method!=='HEAD'?{body:Buffer.concat(chunks)}:{})});
      const response = await localAPI(request,{ip:'local'}); res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(await response.text());
    } else {
      const allowed = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/app.css':'app.css','/assets/technically-mark-icon-blue.png':'assets/technically-mark-icon-blue.png','/assets/fonts/lexend-deca-latin-variable.woff2':'assets/fonts/lexend-deca-latin-variable.woff2','/assets/fonts/lora-latin-italic-variable.woff2':'assets/fonts/lora-latin-italic-variable.woff2'};
      const file=allowed[url.pathname]; if(!file){res.writeHead(404);res.end('Not found');return;}
      const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.woff2')?'font/woff2':'text/html';
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(await readFile(`dist/${file}`));
    }
  }catch(error){console.error(error);res.writeHead(500);res.end('Local preview error');}
});
server.listen(4173,'127.0.0.1',()=>console.log('Local rehearsal: http://127.0.0.1:4173 — host password: rehearsal-only-local'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await db.close();process.exit(0);}));
