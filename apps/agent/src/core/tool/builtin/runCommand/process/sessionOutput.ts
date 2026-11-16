/** shell 会话输出缓冲：流式解码、累计上限与增量快照。 */

import {
  SHELL_OUTPUT_BUFFER_BYTES,
  stripPowerShellErrorWrapper,
  truncateShellOutput,
} from "../shell/runtime";
import {
  DEFAULT_MAX_OUTPUT,
  normalizePositiveInteger,
  type OutputStream,
  type Session,
  type ShellSessionSnapshot,
  type ShellSessionStatus,
} from "./sessionContract";

export function appendSessionOutput(session: Session, stream: OutputStream, data: Buffer): void {
  const availableBytes = Math.max(
    SHELL_OUTPUT_BUFFER_BYTES - session.stdoutBytes - session.stderrBytes,
    0,
  );
  if (availableBytes === 0) {
    session.outputTruncated = true;
    session.outputOmittedBytes += data.length;
    return;
  }

  const chunk = data.subarray(0, availableBytes);
  const decoder = stream === "stdout" ? session.stdoutDecoder : session.stderrDecoder;
  const text = decoder.write(chunk);
  if (text) appendSessionText(session, stream, text);
  if (stream === "stdout") session.stdoutBytes += chunk.length;
  else session.stderrBytes += chunk.length;
  if (chunk.length < data.length) {
    session.outputTruncated = true;
    session.outputOmittedBytes += data.length - chunk.length;
  }
}

export function flushSessionDecoders(session: Session): void {
  const stdout = session.stdoutDecoder.end();
  const stderr = session.stderrDecoder.end();
  if (stdout) appendSessionText(session, "stdout", stdout);
  if (stderr) appendSessionText(session, "stderr", stderr);
}

export function snapshotSession(
  id: string,
  session: Session,
  maxOutputLength?: number,
): ShellSessionSnapshot {
  const limit = normalizePositiveInteger(maxOutputLength, DEFAULT_MAX_OUTPUT);
  const stdoutText = session.stdoutText.join("");
  const stderrRaw = session.stderrText.join("");
  const stderrText =
    session.shellSyntax === "powershell" ? stripPowerShellErrorWrapper(stderrRaw) : stderrRaw;
  const stdoutResult = truncateShellOutput(stdoutText.slice(session.stdoutEmittedChars), limit);
  const stderrResult = truncateShellOutput(stderrText.slice(session.stderrEmittedChars), limit);
  session.stdoutEmittedChars = stdoutText.length;
  session.stderrEmittedChars = stderrText.length;

  const status = sessionStatus(session);
  const outputTruncated =
    session.outputTruncated || stdoutResult.truncated || stderrResult.truncated;
  return {
    status,
    sessionId: id,
    stdout: stdoutResult.value,
    stderr: stderrResult.value,
    ...(status !== "running" && { exitCode: session.exitCode ?? null }),
    ...(session.signal !== undefined && { signal: session.signal }),
    ...(outputTruncated && { outputTruncated: true }),
    ...(session.outputOmittedBytes > 0 && { outputOmittedBytes: session.outputOmittedBytes }),
  };
}

export function sessionStatus(session: Session): ShellSessionStatus {
  if (session.terminalReason === "timed_out") return "timed_out";
  if (session.terminalReason === "cleanup") return "killed";
  if (session.exitCode !== undefined) return "completed";
  return "running";
}

export function isSessionFinished(session: Session): boolean {
  return session.terminalReason !== undefined || session.exitCode !== undefined;
}

function appendSessionText(session: Session, stream: OutputStream, text: string): void {
  if (stream === "stdout") session.stdoutText.push(text);
  else session.stderrText.push(text);
}
