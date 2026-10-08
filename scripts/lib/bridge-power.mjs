import { spawn } from "node:child_process";

export function macPowerStatus(text) {
  if (text.includes("'AC Power'")) return { eligible: true, reason: "AC power" };
  const percent = /(\d+)%/.exec(text)?.[1];
  if (!text.includes("'Battery Power'") || percent === undefined) throw new Error(`unrecognized pmset power state: ${text.trim()}`);
  const battery = Number(percent);
  return { eligible: battery >= 50, reason: `battery ${battery}% (requires 50% or AC)` };
}

export class MacPowerSkip extends Error {}

export const awakeProgram = `
  const { execFileSync, spawn } = require('node:child_process');
  const status = (${macPowerStatus.toString()})(execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' }));
  if (!status.eligible) {
    console.log(JSON.stringify(status)); process.exit(75);
  } else {
    const inhibitor = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'inherit' });
    inhibitor.once('error', error => { console.error(error.stack); process.exit(1); });
    inhibitor.once('spawn', () => console.log(JSON.stringify(status)));
    inhibitor.once('exit', (code, signal) => { console.error('caffeinate exited: code=' + code + ', signal=' + signal); process.exit(1); });
    process.stdin.resume();
    process.stdin.once('end', () => process.exit(0));
  }
`;

export async function withHostAwake(target, platform, operation, launch = spawn) {
  if (!platform.startsWith("darwin-")) return operation();
  // This SSH worker lives across upload, install, cutover and verification.
  const encoded = Buffer.from(awakeProgram).toString("base64");
  const child = launch("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target.sshAlias,
    target.nodePath, "-e", `'eval(Buffer.from("${encoded}","base64").toString())'`,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", skipped = false, failure;
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Mac power handshake timed out for ${target.bridgeId}: ${stderr}`)), 20_000);
    child.once("error", reject);
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (!stdout.includes("\n")) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout.split("\n")[0])); } catch (error) { reject(error); }
    });
    closed.then(({ code, signal }) => reject(new Error(`Mac power worker exited: code=${code}, signal=${signal}: ${stderr}`)));
    closed.finally(() => clearTimeout(timer));
  });
  try {
    const power = await ready;
    console.log(`host_power=${target.bridgeId}: ${power.reason}`);
    if (!power.eligible) { skipped = true; throw new MacPowerSkip(`${target.bridgeId}: ${power.reason}`); }
    return await operation();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    child.stdin.end();
    const result = await closed;
    if (!skipped && (result.code !== 0 || result.signal)) {
      const error = new Error(`Mac awake worker exited: code=${result.code}, signal=${result.signal}: ${stderr}`);
      if (failure) throw new AggregateError([failure, error], failure.message, { cause: failure });
      throw error;
    }
  }
}
