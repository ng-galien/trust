import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { publicMcp } from './lib/public-mcp.mjs';

const endpoint = process.env.TRUST_URL ?? 'http://127.0.0.1:4318';
const runner = fileURLToPath(new URL('../../../packages/trust-runner/dist/skill/trust/scripts/run.js', import.meta.url));
const execute = promisify(execFile);

function invocation(text, name, nextIntent) {
  const block = text.split(`- ${name} (`)[1]?.split('\n- ')[0];
  assert.ok(block, `Missing actionable Check: ${name}`);
  const template = block.match(/(?:Continuing|Final) invocation URI: (.+)/)?.[1];
  assert.ok(template, `Missing MCP invocation template: ${name}`);
  const intent = text.match(/^Current intent: (.+)$/m)?.[1];
  assert.ok(intent, 'Missing current intent');
  assert.equal(template.includes('{nextIntent}'), nextIntent !== undefined);
  return template.replace('{intent}', encodeURIComponent(intent)).replace('{nextIntent}', encodeURIComponent(nextIntent));
}

async function invoke(text, name, nextIntent) {
  const { stdout } = await execute(process.execPath, [runner, invocation(text, name, nextIntent), '--json'], {
    env: { ...process.env, TRUST_RPC_ENDPOINT: `${endpoint}/rpc`, TRUST_OTLP_ENDPOINT: `${endpoint}/v1/traces` },
    maxBuffer: 2 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.result.qualification?.verdict, 'VALIDATED', stdout);
  return result;
}

test('A fresh MCP client recovers the claimed mission and completes it without replaying claim', {
  skip: !process.env.TRUST_COORDINATION_DATABASE_URL,
}, async () => {
  const plan = `delegation-recovery-${randomUUID()}`;
  const inputs = {
    mission: plan, assignee: 'recovery-acceptance-agent', project: 'trust',
    instructions: 'Recover this exact request.\nKeep "quoted" details and Unicode: café.',
    expected: 'A response from a fresh client holding only the Check URI',
    authorized: 'Read the persisted engagement context and submit this acceptance response.',
    forbidden: 'Do not replay the satisfied claim or change the mission request.',
  };
  let text = await publicMcp(endpoint, 'trust_plan_engage', {
    procedure: 'agent-delegation', procedureVersion: '1.0.0', plan, environment: 'coordination', rootInputs: inputs,
  });
  const creationUri = text.match(/Check URI: (trust:\/\/\S+)/)?.[1];
  assert.ok(creationUri);
  text = await publicMcp(endpoint, 'trust_plan_read', { checkUri: creationUri });
  await invoke(text, 'create mission', 'Claim the recovery acceptance mission');
  text = await publicMcp(endpoint, 'trust_plan_read', { checkUri: creationUri });
  const claimUri = new URL(invocation(text, 'claim mission', 'Recover the mission and submit its response'));
  claimUri.search = '';
  // Deliberately discard all claim output after checking its authoritative verdict.
  await invoke(text, 'claim mission', 'Recover the mission and submit its response');
  text = '';
  // A new process has no engagement or runner output, only transport configuration and the Check identity.
  const fresh = await execute(process.execPath, ['--input-type=module', '-e',
    `import { publicMcp } from ${JSON.stringify(new URL('./lib/public-mcp.mjs', import.meta.url).href)}; process.stdout.write(await publicMcp(process.argv[1], 'trust_plan_read', { checkUri: process.argv[2] }));`,
    endpoint, claimUri.href,
  ]);
  text = fresh.stdout;
  assert.match(text, /ENGAGEMENT CONTEXT\nImmutable root business inputs recorded at Plan engagement; these are not re-observed Facts\./);
  const context = text.split('ENGAGEMENT CONTEXT\n')[1].split('\n\n')[0];
  const recovered = Object.fromEntries(context.split('\n').filter(line => line.startsWith('- ')).map(line => {
    const [, role, value] = line.match(/^- (\S+) = (.+)$/);
    return [role, JSON.parse(value)];
  }));
  assert.deepEqual(recovered, inputs, 'Recover every exact immutable business input');
  assert.match(text, /Current intent: Recover the mission and submit its response/);
  assert.match(text, /\[SATISFIED\] claim mission/);
  const declarations = { response: `Recovered: ${recovered.instructions}`, outcome: 'completed' };
  await publicMcp(endpoint, 'trust_plan_declarations_replace', {
    plan: text.match(/^Plan: (.+)$/m)[1], expectedRevision: Number(text.match(/^Revision: (\d+)$/m)[1]), declarations,
  });
  text = await publicMcp(endpoint, 'trust_plan_read', { checkUri: claimUri.href });
  await invoke(text, 'submit response', 'Observe the recovered mission completion');
  text = await publicMcp(endpoint, 'trust_plan_read', { checkUri: claimUri.href });
  const completion = await invoke(text, 'observe completion');
  assert.equal(completion.next.action, 'COMPLETE');
  assert.match(await publicMcp(endpoint, 'trust_plan_read', { checkUri: claimUri.href }), /^State: COMPLETE$/m);
  const db = new pg.Client({ connectionString: process.env.TRUST_COORDINATION_DATABASE_URL });
  await db.connect();
  try {
    const stored = (await db.query('SELECT * FROM trust_coordination.missions WHERE mission=$1', [plan])).rows[0];
    assert.deepEqual(stored.request, { ...inputs, plan });
    assert.equal(stored.owner, inputs.assignee);
    assert.equal(stored.response, declarations.response);
    assert.deepEqual((await db.query('SELECT event FROM trust_coordination.mission_events WHERE mission=$1 ORDER BY sequence', [plan])).rows.map(row => row.event), ['created', 'claimed', 'completed']);
    console.log(`Retained recovery acceptance mission: ${plan}`);
  } finally {
    await db.end();
  }
});
