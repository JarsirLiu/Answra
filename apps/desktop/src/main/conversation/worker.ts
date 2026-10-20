import { startAgentWorker } from "./workerTransport";

/** Electron utility process entry point for the Agent runtime. */
const parentPort = process.parentPort;
if (!parentPort) throw new Error("Agent worker must run as an Electron utility process");
startAgentWorker(parentPort);
