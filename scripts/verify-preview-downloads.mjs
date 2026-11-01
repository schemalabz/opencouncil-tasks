/** Run with the deployed closure's Node/runtime and EnvironmentFile, never against production. */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { values: v } = parseArgs({ options: { root: {type:'string'}, cases:{type:'string'}, only:{type:'string'}, output:{type:'string'}, data:{type:'string'} } });
if (!/^\/var\/lib\/opencouncil-tasks-previews\/pr-[0-9]+\/app$/.test(v.root ?? '') || !/^\/var\/lib\/opencouncil-tasks-previews\/pr-[0-9]+\/media-verification(?:-[a-z0-9-]+)?$/.test(v.data ?? '')) throw Error('Require isolated tasks preview root/data paths');
if (path.dirname(v.root)!==path.dirname(v.data)) throw Error('Preview root and test cache must belong to the same PR');
const selected=v.only?.split(',');
const allCases=JSON.parse(readFileSync(v.cases,'utf8'));
if(!Array.isArray(allCases)||!selected?.length||selected.some(name=>!name||!allCases.some(c=>c.name===name)))throw Error('Every requested case must exist in the matrix');
const cases=allCases.filter(c=>selected.includes(c.name));
if(!cases.length)throw Error('No download cases selected');
const startScript=readFileSync(path.join(v.root,'start.sh'),'utf8');
for (const key of ['FFMPEG_BIN_PATH','YTDLP_BIN_PATH','PATH']) {
 const match=startScript.match(new RegExp('export '+key+'="([^"\\n]+)"'));
 if(!match)throw Error('Missing runtime path '+key);
 process.env[key]=match[1].replace('$PATH',process.env.PATH ?? '/run/current-system/sw/bin');
}
process.env.DATA_DIR=v.data;
process.env.YTDLP_AUTO_UPDATE='false';
mkdirSync(v.data,{recursive:true});
const { downloadMedia, inspectMedia }=await import(pathToFileURL(path.join(v.root,'dist/tasks/downloadYTV.js')));
const { getMediaDurationSeconds }=await import(pathToFileURL(path.join(v.root,'dist/tasks/utils/mediaOperations.js')));
const reports=[];
for (const c of cases) {
 const start=Date.now();const row={name:c.name,url:c.url};
 try {
  row.inspection=await inspectMedia(c.url);
  if(c.supported!==undefined&&row.inspection.supported!==c.supported)throw Error('Unexpected support result');
  if(c.kind&&row.inspection.source?.kind!==c.kind)throw Error('Unexpected route kind');
  if(row.inspection.supported) {
   const media=await downloadMedia(c.url,()=>{});
   row.sizeBytes=statSync(media.combined).size;row.durationSeconds=await getMediaDurationSeconds(media.combined);row.source=media.source;
   const mtime=statSync(media.combined).mtimeMs;
   const cached=await downloadMedia(c.url,()=>{});
   row.cacheReused=cached.combined===media.combined&&statSync(cached.combined).mtimeMs===mtime;
   if(!row.cacheReused||!row.sizeBytes||!row.durationSeconds)throw Error('Empty result or cache reuse failed');
   row.download='passed';
  }else row.download='refused';
 }catch(e){row.download='failed';row.error=String(e.message);}
 row.elapsedSeconds=(Date.now()-start)/1000;reports.push(row);writeFileSync(v.output,JSON.stringify(reports,null,2));
 console.log(JSON.stringify({name:row.name,download:row.download,sizeBytes:row.sizeBytes,durationSeconds:row.durationSeconds}));
 // Only remove the explicitly designated isolated test cache, after recording cache reuse.
 rmSync(v.data,{recursive:true,force:true});mkdirSync(v.data,{recursive:true});
}
if(reports.some(r=>r.download==='failed'))process.exitCode=1;
