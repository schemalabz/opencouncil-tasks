/** Synthetic transport faults, loopback only. Used by a preview-only reverse proxy route. */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
const file=process.argv[2];const port=Number(process.argv[3]);
if(!file?.startsWith('/var/lib/opencouncil-tasks-previews/pr-121/media-preview-fixtures/')||port!==48121)throw Error('Only PR121 fixture scope is allowed');
const data=readFileSync(file);
http.createServer((req,res)=>{
 if(!['/media-test-faults/interrupted.mp4','/media-test-faults/temporary.mp4'].includes(req.url?.split('?')[0])){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');
 if(req.method==='HEAD'){res.setHeader('Content-Length',data.length);return res.end();}
 // Metadata/ffprobe Range probes are deliberately healthy; the direct HTTP transfer uses a plain GET.
 if(req.headers.range){const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range);if(!match){res.writeHead(416);return res.end();}const from=Number(match[1]);const to=match[2]?Math.min(Number(match[2]),data.length-1):data.length-1;res.writeHead(206,{'Content-Range':`bytes ${from}-${to}/${data.length}`,'Content-Length':to-from+1});return res.end(data.subarray(from,to+1));}
 if(req.url.includes('interrupted')&&existsSync(file+'.recovered')){res.setHeader('Content-Length',data.length);return res.end(data);}
 if(req.url.includes('temporary')){res.writeHead(503,{'Retry-After':'1'});return res.end('Synthetic preview outage');}
 res.writeHead(200,{'Content-Length':data.length});res.write(data.subarray(0,Math.floor(data.length/2)));setTimeout(()=>res.destroy(),100);
}).listen(port,'127.0.0.1',()=>console.log('Preview transport fixtures listening on loopback'));
