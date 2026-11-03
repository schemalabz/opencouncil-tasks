/** Run with the deployed closure's Node/runtime and EnvironmentFile, never against production. */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const { values: v } = parseArgs({ options: { root: {type:'string'}, cases:{type:'string'}, only:{type:'string'}, output:{type:'string'}, data:{type:'string'}, concurrency:{type:'string'} } });
const concurrency = Number(v.concurrency ?? '0');
if (!Number.isInteger(concurrency) || concurrency < 0 || concurrency > 4) throw Error('Concurrency must be 0..4');
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
const { downloadMedia, downloadYTV, inspectMedia }=await import(pathToFileURL(path.join(v.root,'dist/tasks/downloadYTV.js')));
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
   if(c.container) {
    const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe',['-v','error','-show_format','-of','json',media.combined],{encoding:'utf8',timeout:30000}));
    assert(probe.format.format_name.split(',').includes(c.container),'Unexpected downloaded container');
    row.container=probe.format.format_name;
   }
   if(concurrency) {
    // Real deployed preparation. Keep the earlier outputs alive while later tasks run;
    // same basenames must not mean shared working files or a mutated raw cache.
    const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
    const rawDigest=digest(media.combined);
    const results=await Promise.allSettled(Array.from({length:concurrency},()=>downloadYTV(c.url,()=>{})));
    const prepared=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
    try {
     for(const r of results)if(r.status==='rejected')throw r.reason;
     assert.equal(new Set(prepared.map(r=>r.combined)).size,concurrency,'Shared video working path');
     assert.equal(new Set(prepared.map(r=>r.audioOnly)).size,concurrency,'Shared audio working path');
     for(const r of prepared) {
      assert(await getMediaDurationSeconds(r.combined)>0,'Invalid prepared video');
      assert(await getMediaDurationSeconds(r.audioOnly)>0,'Invalid extracted audio');
      assert.equal(path.parse(r.combined).name,path.parse(media.combined).name,'Upload name stem changed');
     }
     assert.equal(digest(media.combined),rawDigest,'Preparation mutated raw cache');
     row.preparation={tasks:concurrency,isolated:true,rawCacheUnchanged:true};
    } finally {for(const r of prepared)r.cleanup?.();}
   }
   row.download='passed';
  }else row.download='refused';
 }catch(e){row.download='failed';row.error=String(e.message);}
 row.elapsedSeconds=(Date.now()-start)/1000;reports.push(row);writeFileSync(v.output,JSON.stringify(reports,null,2));
 console.log(JSON.stringify({name:row.name,download:row.download,sizeBytes:row.sizeBytes,durationSeconds:row.durationSeconds}));
 // Only remove the explicitly designated isolated test cache, after recording cache reuse.
 rmSync(v.data,{recursive:true,force:true});mkdirSync(v.data,{recursive:true});
}
if(reports.some(r=>r.download==='failed'))process.exitCode=1;
