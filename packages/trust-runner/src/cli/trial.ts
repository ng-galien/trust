import { parseTrialJob, runTrial } from "../trial/run.js";

/** stdin: one trust.trial-job@1 JSON document; stdout: one trust.trial-outcome@1 JSON document. */
export async function runTrialCli(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  let job;
  try {
    job = parseTrialJob(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    process.stderr.write(`trial: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const outcome = await runTrial(job);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  return outcome.ok ? 0 : 1;
}
