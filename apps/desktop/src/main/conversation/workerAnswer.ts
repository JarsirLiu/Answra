import { startAnswerAgentWorker } from "./workerAnswerTransport";

/** Electron utility process entry point for the answer-only Agent runtime. */
const parentPort = process.parentPort;
if (!parentPort) throw new Error("Answer Agent worker must run as an Electron utility process");
startAnswerAgentWorker(parentPort);
