import { spawn } from "node:child_process";
import { discoverAgyLs, subscribeToAgyStream } from "./agents/agy-stream.js";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const convDir = path.join(process.env.HOME ?? "/root", ".gemini/antigravity-cli/conversations");
async function listConvs() {
    try {
        const files = await fs.readdir(convDir);
        return new Set(files.map((f) => path.basename(f, ".pb")));
    }
    catch {
        return new Set();
    }
}
async function main() {
    const before = await listConvs();
    const agyStart = Date.now();
    const cwd = "/home/ubuntu/Projects/seam-acp";
    const prompt = "Look at package.json in this directory and tell me how many dependencies are listed under devDependencies.";
    console.log("Spawning agy with tool-using prompt...");
    const proc = spawn("/home/ubuntu/.local/bin/agy", [
        "-p",
        prompt,
        "--print-timeout",
        "600s",
        "--dangerously-skip-permissions",
        "--add-dir",
        cwd,
    ], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (c) => console.log("[stdout]", c.toString()));
    proc.stderr?.on("data", (c) => console.error("[stderr]", c.toString()));
    proc.on("exit", (code, signal) => {
        console.log(`[exit] agy process exited with code ${code} signal ${signal}`);
    });
    try {
        console.log("Discovering agy language server...");
        const ls = await discoverAgyLs({
            timeoutMs: 15_000,
            newerThanMs: agyStart - 1_000,
        });
        console.log(`Discovered LS: port=${ls.port} instanceId=${ls.instanceId}`);
        // Poll for the new conversation ID
        let cid;
        for (let attempt = 0; attempt < 50; attempt++) {
            const current = await listConvs();
            for (const c of current) {
                if (!before.has(c)) {
                    cid = c;
                    break;
                }
            }
            if (cid)
                break;
            await delay(100);
        }
        if (!cid) {
            throw new Error("Timeout waiting for new conversation ID");
        }
        console.log(`Subscribing to stream for conversation ${cid}...`);
        for await (const update of subscribeToAgyStream({
            port: ls.port,
            conversationId: cid,
        })) {
            console.log(`[stream update] status=${update.status} execStatus=${update.executableStatus} loopStatus=${update.executorLoopStatus} keys=${Object.keys(update).join(",")}`);
            if (update.mainTrajectoryUpdate?.stepsUpdate?.steps) {
                for (const step of update.mainTrajectoryUpdate.stepsUpdate.steps) {
                    console.log(`  - Step: type=${step.type} status=${step.status}`);
                    if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" && step.plannerResponse) {
                        console.log(`    plannerResponse stopReason=${step.plannerResponse.stopReason}`);
                    }
                }
            }
        }
        console.log("Stream finished naturally.");
    }
    catch (err) {
        console.error("Error in test script:", err);
    }
}
main().catch(console.error);
//# sourceMappingURL=test_agy_stream.js.map