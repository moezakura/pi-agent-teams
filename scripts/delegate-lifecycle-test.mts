import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerTeamsTool } from '../extensions/teams/leader-teams-tool.js';
import { ActivityTracker } from '../extensions/teams/activity-tracker.js';
import { getTeamDir, getTeamsRootDir } from '../extensions/teams/paths.js';
import { ensureTeamConfig, upsertMember, setMemberStatus } from '../extensions/teams/team-config.js';
import { getInboxPath } from '../extensions/teams/mailbox.js';
import { listTasks, updateTask } from '../extensions/teams/task-store.js';

type Params = { action: 'delegate' | 'team_done'; tasks?: Array<{text: string; assignee?: string}>; teammates?: string[]; maxTeammates?: number; all?: boolean };
type Result = { details: { assignments?: Array<{taskId: string; assignee: string}>; warnings?: string[]; status?: string } };
type Tool = { execute(id: string, params: Params, signal: AbortSignal, update: () => void, ctx: ExtensionContext): Promise<Result> };
type Rpc = Parameters<typeof registerTeamsTool>[0]['teammates'] extends Map<string, infer T> ? T : never;
const taskRoot = getTeamsRootDir();
const base = path.join(taskRoot, 'allocation-fixtures');
await mkdir(base, {recursive: true});
const root = await mkdtemp(path.join(base, 'run-'));
process.env.TASK_TMP_ROOT = process.env.PI_TEAMS_ROOT_DIR = taskRoot;
process.env.PI_TEAMS_STYLE = 'normal';
console.log('FIXTURE_ROOT', root);
let sequence = 0;
async function fixture(existing: string[] = [], options: {fail?: string; cancel?: boolean; stopError?: boolean} = {}) {
 const id = `allocation-fixtures/${path.basename(root)}/case-${++sequence}`;
 const dir = getTeamDir(id);
 await ensureTeamConfig(dir,{teamId:id,taskListId:id,leadName:"team-lead",style:"normal"});
 const teammates = new Map<string, Rpc>();
 const spawned: string[] = [];
 const controller = new AbortController();
 let tool: Tool | undefined;
 let hidden = false;
 for (const name of existing) {
  teammates.set(name, {name, status: 'idle'} as Rpc);
  await upsertMember(dir, {name, role: 'worker', status: 'online'});
 }
 registerTeamsTool({
  pi: {registerTool(value: unknown) {tool = value as Tool;}} as unknown as ExtensionAPI,
  teammates, getTeamId: () => id, getTaskListId: () => id,
  getTracker: () => new ActivityTracker(), getTeamConfig: () => null,
  refreshTasks: async () => {}, renderWidget: () => {}, hideWidget: () => {hidden = true;}, pendingPlanApprovals: new Map(),
  spawnTeammate: async (_ctx, opts) => {
   const name = opts.name;
   assert.ok(name);
   spawned.push(name);
   if (name === options.fail) return {ok: false, error: 'fixture failure'};
   teammates.set(name, {name, status: 'idle'} as Rpc);
   await upsertMember(dir, {name, role: 'worker', status: 'online'});
   if (options.cancel) controller.abort();
   return {ok: true, name, mode: opts.mode ?? 'fresh', workspaceMode: opts.workspaceMode ?? 'shared', warnings: []};
  },
  stopAllTeammates: async () => {
   for (const name of teammates.keys()) {
    await setMemberStatus(dir, name, 'offline');
    if (options.stopError) throw new Error('fixture stop failure');
   }
   teammates.clear();
  },
 });
 assert.ok(tool);
 const registeredTool = tool;
 return {id, dir, spawned, teammates, hidden: () => hidden,
  call: (params: Params) => registeredTool.execute('test', params, controller.signal, () => {}, {} as ExtensionContext),
  inbox: async (name: string) => {
   try { return JSON.parse(await readFile(getInboxPath(dir, 'team', name), 'utf8')) as unknown[]; }
   catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
  },
 };
}
const task = (assignee?: string) => ({text: 'synthetic task', ...(assignee === undefined ? {} : {assignee})});
const owners = (r: Result) => r.details.assignments?.map(a => a.assignee);
let failures = 0;
async function test(name: string, fn: () => Promise<void>) {
 try {await fn(); console.log('PASS', name);} catch (error) {failures++; console.error('FAIL', name, error);}
}
await test('T01 named only', async () => {
 const f = await fixture(); const names = ['finder-funcstat', 'finder-metrics', 'gap-hunter'];
 const r = await f.call({action: 'delegate', tasks: names.map(task)});
 assert.deepEqual(f.spawned, names); assert.deepEqual(owners(r), names);
});
await test('T02 named duplicate exceeds auto limit', async () => {
 const f = await fixture(); const r = await f.call({action: 'delegate', maxTeammates: 1, tasks: ['alice','bob','alice','carol'].map(task)});
 assert.deepEqual(f.spawned, ['alice','bob','carol']); assert.deepEqual(owners(r), ['alice','bob','alice','carol']);
});
for (const max of [1,4,16]) await test(`T03 auto max ${max}`, async () => {
 const f = await fixture(); const r = await f.call({action: 'delegate', maxTeammates: max, tasks: Array.from({length: 18}, () => task())});
 assert.deepEqual(f.spawned, Array.from({length: max}, (_,i) => `agent${i+1}`));
 assert.deepEqual(owners(r), Array.from({length: 18}, (_,i) => `agent${i%max+1}`));
});
await test('T04 existing pool excludes new named owner', async () => {
 const f = await fixture(['alice','bob']); const r = await f.call({action: 'delegate', tasks: [task(),task('carol'),task(),task()]});
 assert.deepEqual(f.spawned,['carol']); assert.deepEqual(owners(r), ['alice','carol','bob','alice']);
});
await test('T05 mixed auto avoids named collision', async () => {
 const f = await fixture(); const r = await f.call({action: 'delegate', tasks: [task('agent1'),task(),task()]});
 assert.deepEqual([...f.spawned].sort(), ['agent1','agent2','agent3']); assert.deepEqual(owners(r), ['agent1','agent2','agent3']);
 const g = await fixture(); const s = await g.call({action: 'delegate', maxTeammates: 1, tasks: [task('alice'),task('bob'),task('carol'),task(),task()]});
 assert.equal(g.spawned.length,4); assert.deepEqual(owners(s),['alice','bob','carol','agent1','agent1']);
});
await test('T06 explicit pool retained and deduplicated', async () => {
 const f = await fixture(); const r = await f.call({action: 'delegate', teammates: ['alice','bob','alice'], tasks: [task('carol'),task(),task(),task()]});
 assert.deepEqual(f.spawned,['alice','bob','carol']); assert.deepEqual(owners(r), ['carol','alice','bob','alice']);
 const g = await fixture(); await g.call({action: 'delegate', teammates: ['alice','bob'], tasks: [task('carol')]});
 assert.deepEqual(g.spawned,['alice','bob','carol']);
});
await test('T07 invalid and empty tasks never spawn', async () => {
 const f = await fixture(); const r = await f.call({action: 'delegate', tasks: [{text:' '},{text:'',assignee:'alice'}]});
 assert.deepEqual(f.spawned,[]); assert.deepEqual(owners(r),[]); assert.equal(r.details.warnings?.length,2);
 await f.call({action:'delegate',tasks:[]}); assert.deepEqual(f.spawned,[]);
 const g = await fixture(); const s = await g.call({action:'delegate',teammates:[''],tasks:[task()]}); assert.deepEqual(owners(s),['agent1']);
});
await test('T08 failed spawn attempted once with partial success', async () => {
 const f = await fixture([], {fail:'alice'}); const r = await f.call({action:'delegate',tasks:[task('alice'),task('alice'),task('bob')]});
 assert.deepEqual(f.spawned,['alice','bob']); assert.deepEqual(owners(r),['bob']); assert.equal((await listTasks(f.dir,f.id)).length,1);
});
await test('T08 cancellation stops further spawning and creation', async () => {
 const f = await fixture([], {cancel:true}); const r = await f.call({action:'delegate',tasks:[task('alice'),task('bob')]});
 assert.deepEqual(f.spawned,['alice']); assert.deepEqual(owners(r),[]);
});
await test('T09 done excludes stopped RPC names but reaches manual', async () => {
 const names = ['alice','bob','carol','dave','eve','frank']; const f = await fixture(names);
 await upsertMember(f.dir,{name:'manual',role:'worker',status:'online'});
 await f.call({action:'team_done'});
 for (const name of names) assert.deepEqual(await f.inbox(name),[]);
 assert.equal((await f.inbox('manual')).length,1); assert.equal(f.hidden(),true);
});
await test('T11 stop error does not notify manual or hide widget', async () => {
 const f = await fixture(['alice','bob'],{stopError:true}); await upsertMember(f.dir,{name:'manual',role:'worker',status:'online'});
 await assert.rejects(f.call({action:'team_done'}), /fixture stop failure/);
 assert.deepEqual(await f.inbox('manual'),[]); assert.equal(f.hidden(),false);
});
await test('T17/T18 allocation and done forward two cycles (mock process boundary)', async () => {
 const f = await fixture(); const names = ['finder-funcstat','finder-metrics','gap-hunter'];
 for (let cycle=0;cycle<2;cycle++) {
  const r = await f.call({action:'delegate',tasks:names.map(task)});
  assert.deepEqual(owners(r),names);
  for (const a of r.details.assignments ?? []) await updateTask(f.dir,f.id,a.taskId,t => ({...t,status:'completed'}));
  await f.call({action:'team_done'});
  for (const name of names) assert.deepEqual(await f.inbox(name),[]);
 }
 assert.deepEqual(f.spawned,[...names,...names]);
});
console.log(`RESULT ${failures} failures; production tool/task/config/mailbox, mock spawn/stop/ExtensionAPI; no model API`);
process.exitCode = failures ? 1 : 0;
