import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb } from "../src/store/db.ts";
import { captureSettledSession } from "../src/capture.ts";
import { enqueueExtraction } from "../src/store/jobs.ts";
import { v1PromptHash } from "../src/extraction/v1.ts";
import { v2PromptHash } from "../src/extraction/v2.ts";
import { getPublishedGeneration } from "../src/store/consolidation.ts";

const moduleUrl = (path: string) => JSON.stringify(new URL(`../src/${path}.ts`, import.meta.url).href);
const worker = `
import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {createHash} from 'node:crypto';
import {openStateDb} from ${moduleUrl("store/db")};
import {enqueueExtraction,claimDueExtractions} from ${moduleUrl("store/jobs")};
import {runV1Extraction,runV2Extraction} from ${moduleUrl("extraction/runner")};
import {v1PromptHash} from ${moduleUrl("extraction/v1")}; import {v2PromptHash} from ${moduleUrl("extraction/v2")};
import {claimConsolidation,selectConsolidation} from ${moduleUrl("store/consolidation")};
import {buildStaging,evidencePath} from ${moduleUrl("pipeline/staging")};
import {validateV1Artifacts,validateV2Artifacts} from ${moduleUrl("pipeline/validate")};
import {publishGeneration} from ${moduleUrl("pipeline/publish")};
const [root,version,sourceId,cwd]=process.argv.slice(1); const db=openStateDb(root);
const owner=String(process.pid), promptHash=version==='v1'?v1PromptHash():v2PromptHash(); let extraction,consolidation;
process.on('message',async ({phase})=>{try {
  if(phase==='claim-extraction'){
    enqueueExtraction(db,{sourceId,memoryVersion:version,promptHash,now:Date.now()});
    extraction=claimDueExtractions(db,{owner,now:Date.now(),limit:1,slots:2,versions:[version]})[0];
    process.send({phase,claimed:!!extraction});
  } else if(phase==='finish-extraction'){
    let result;
    if(extraction) result=await (version==='v1'?runV1Extraction:runV2Extraction)({db,root,job:extraction,
      modelRef:{provider:'mock',modelId:'memory'},now:Date.now(),timezone:'UTC',signal:new AbortController().signal,
      limits:{outputBytes:49152,v2RolloutSummaryBytes:9000,dailyInputTokens:100000,dailyOutputTokens:20000,dailyRequests:20},
      port:{resolve:()=>({provider:'mock',modelId:'memory',contextWindow:200000,maxTokens:8000}),
        request:async()=>({stopReason:'stop',text:JSON.stringify({...version==='v1'?{raw_memory:'Use TypeScript'}:{},
          rollout_summary:'Use TypeScript for typed interfaces',rollout_slug:'typescript'}),usage:{input:20,output:10}})}});
    process.send({phase,status:result?.status??'not-claimed'});
  } else if(phase==='claim-consolidation'){
    consolidation=claimConsolidation(db,{memoryVersion:version,owner,now:Date.now(),promptHash:'concurrency-writer'});
    process.send({phase,claimed:!!consolidation});
  } else if(phase==='publish'){
    let published=false;
    if(consolidation){
      const snapshot=selectConsolidation(db,{memoryVersion:version,now:Date.now()});
      const staged=buildStaging({root,jobId:consolidation.jobId,snapshot,promptHash:consolidation.promptHash});
      const source=snapshot.sources[0], evidence=evidencePath(source.sourceId,source.rolloutSlug);
      if(version==='v1') writeFileSync(join(staged.directory,'MEMORY.md'),
        '# Task Group: TypeScript\\nscope: '+cwd+'\\napplies_to: '+cwd+'\\n\\n## Task 1: TypeScript\\n\\n### rollout_summary_files\\n- '+evidence+'\\n\\n### keywords\\n- TypeScript\\n\\n### learnings\\n- Use TypeScript for typed interfaces.\\n');
      writeFileSync(join(staged.directory,'memory_summary.md'),
        'v1\\n\\n## User Profile\\n\\n## User preferences\\n\\n## General Tips\\n\\n## What\\'s in Memory\\n\\n### '+cwd+'\\n\\n#### '+new Date().toISOString().slice(0,10)+'\\n\\n- '+evidence+' — Use TypeScript for typed interfaces.\\n');
      staged.manifest.fileHashes=(version==='v1'?validateV1Artifacts:validateV2Artifacts)({directory:staged.directory,snapshot}).fileHashes;
      const manifest=JSON.stringify(staged.manifest); writeFileSync(join(staged.directory,'manifest.json'),manifest);
      published=publishGeneration({db,root,stagingDir:staged.directory,lease:consolidation,snapshot,inputHash:staged.inputHash,
        manifestHash:createHash('sha256').update(manifest).digest('hex'),now:Date.now()}).published;
    }
    process.send({phase,published});
  } else if(phase==='quit'){db.close();process.send({phase},()=>process.exit(0));}
} catch(error){process.send({phase,error:String(error)});process.exitCode=1;}});
process.send({phase:'ready'});
`;

function startWorker(root: string, version: string, sourceId: string, cwd: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", worker, root, version, sourceId, cwd], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
  const response = (phase: string) => new Promise<{ claimed?: boolean; published?: boolean; status?: string }>((resolve, reject) => {
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`worker exited ${code}: ${stderr}`)); };
    const onMessage = (message: any) => { if (message.phase !== phase) return; cleanup();
      if (message.error) reject(new Error(message.error)); else resolve(message); };
    const cleanup = () => { child.off("exit", onExit); child.off("message", onMessage); };
    child.on("exit", onExit); child.on("message", onMessage);
  });
  const ready = response("ready");
  return { child, ready, exchange(phase: string) { const pending = response(phase); child.send({ phase }); return pending; } };
}

for (const version of ["v1", "v2"] as const) test(`${version}: two live processes accept one extraction and publish one consolidation winner`, { timeout: 30_000 }, async t => {
  const base = mkdtempSync(join(tmpdir(), "pi-process-race-")); const cwd = join(base, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd }); const agentDir = join(base, "agent"); const root = join(agentDir, "memory");
  const children: ChildProcess[] = [];
  t.after(() => { for (const child of children) child.kill(); rmSync(base, { recursive: true, force: true }); });
  const file = join(base, "session.jsonl"); const header = { type: "session", version: 3, id: "concurrent", cwd, timestamp: new Date().toISOString() };
  const entry = { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: {
    role: "user", content: [{ type: "text", text: "Use TypeScript for typed interfaces" }], timestamp: Date.now() } };
  writeFileSync(file, [header, entry].map(value => JSON.stringify(value)).join("\n") + "\n"); const original = readFileSync(file);
  const db = openStateDb(root);
  const captured = captureSettledSession({ root, agentDir, cwd, db, mode: "tui", reader: { getHeader: () => header as never,
    getBranch: () => [entry] as never, getSessionFile: () => file, getLeafId: () => "u1" } });
  assert.equal(captured.status, "captured");
  enqueueExtraction(db, { sourceId: captured.sourceId, memoryVersion: version, promptHash: version === "v1" ? v1PromptHash() : v2PromptHash(), now: Date.now() }); db.close();
  const workers = [startWorker(root, version, captured.sourceId, cwd), startWorker(root, version, captured.sourceId, cwd)];
  children.push(...workers.map(item => item.child)); await Promise.all(workers.map(item => item.ready));
  const exchange = (phase: string) => Promise.all(workers.map(item => item.exchange(phase)));
  assert.equal((await exchange("claim-extraction")).filter(item => item.claimed).length, 1);
  assert.equal((await exchange("finish-extraction")).filter(item => item.status === "succeeded").length, 1);
  assert.equal((await exchange("claim-consolidation")).filter(item => item.claimed).length, 1);
  assert.equal((await exchange("publish")).filter(item => item.published).length, 1);
  await exchange("quit");
  const reopened = openStateDb(root);
  try {
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM extractions WHERE memory_version = ?").get(version)!.n, 1);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM generations WHERE status = 'published'").get()!.n, 1);
    const published = getPublishedGeneration(reopened, version, Date.now())!;
    assert.match(readFileSync(join(published.directory, "memory_summary.md"), "utf8"), /TypeScript/);
    assert.deepEqual(readFileSync(file), original);
  } finally { reopened.close(); }
});
