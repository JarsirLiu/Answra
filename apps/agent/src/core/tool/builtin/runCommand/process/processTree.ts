/** 终止 shell 子进程树；Windows 会话用 Job Object containment，其余路径回退 taskkill。 */

import { type ChildProcess, execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

const KILL_SETTLE_MS = 200;
const KILL_CAP_MS = 5_000;
const CONTAINMENT_PROBE_MS = 2_000;
const CONTAINMENT_PROBE_INTERVAL_MS = 50;

export const JOB_MARKER_ENV = "ANSWRA_SHELL_JOB_MARKER";

export type JobContainment = "ok" | "failed" | "unknown";

/**
 * 终止子进程的整棵进程树并等待根进程退出。
 *
 * Windows 主路径依赖 Job Object 内核约束（见 buildWindowsJobBootstrap）：
 * 根 PowerShell 进程死亡后 job 句柄关闭，KILL_ON_JOB_CLOSE 由内核收割全部后代，
 * 因此不存在 taskkill 快照枚举与后代 spawn 之间的 TOCTOU 竞态。
 */
export function terminateProcessTree(child: ChildProcess, jobMarkerPath?: string): Promise<void> {
  if (process.platform === "win32") return terminateWindowsProcessTree(child, jobMarkerPath);
  terminatePosixProcessTree(child);
  return Promise.resolve();
}

function terminatePosixProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error: unknown) {
    if (!isMissingProcessError(error)) child.kill("SIGTERM");
  }
}

async function terminateWindowsProcessTree(
  child: ChildProcess,
  jobMarkerPath?: string,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    await delay(KILL_SETTLE_MS);
    await removeJobMarker(jobMarkerPath);
    return;
  }

  const containment = jobMarkerPath ? await readJobContainment(jobMarkerPath) : "unknown";
  if (containment === "ok") {
    child.kill();
  } else {
    await forceKillProcessTree(pid, child);
  }

  await waitForRootExit(child);
  await removeJobMarker(jobMarkerPath);
}

async function readJobContainment(markerPath: string): Promise<JobContainment> {
  const deadline = Date.now() + CONTAINMENT_PROBE_MS;
  for (;;) {
    try {
      return parseJobContainmentMarker(await readFile(markerPath, "utf8"));
    } catch (error: unknown) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "ENOENT" || Date.now() >= deadline) return "unknown";
      await delay(CONTAINMENT_PROBE_INTERVAL_MS);
    }
  }
}

export function parseJobContainmentMarker(value: string): JobContainment {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return "ok";
  if (normalized === "false") return "failed";
  return "unknown";
}

function forceKillProcessTree(pid: number, child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, (error) => {
      if (error && child.exitCode === null && child.signalCode === null) child.kill();
      resolve();
    });
  });
}

function waitForRootExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return delay(KILL_SETTLE_MS);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      resolve();
    };
    const cap = setTimeout(finish, KILL_CAP_MS);
    cap.unref();
    child.once("exit", () => {
      const settle = setTimeout(finish, KILL_SETTLE_MS);
      settle.unref();
    });
  });
}

async function removeJobMarker(markerPath?: string): Promise<void> {
  if (!markerPath) return;
  try {
    await rm(markerPath, { force: true });
  } catch {
    // 标记文件只是临时反馈介质，清理失败不影响终止结果。
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

const JOB_TREE_CSHARP_SOURCE = `
using System;
using System.Runtime.InteropServices;
public static class AnswraJobTree
{
    private const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicLimitInformation = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_BASIC_LIMIT_INFORMATION limits, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    public static IntPtr CreateJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Exception("CreateJobObject failed");
        }
        JOBOBJECT_BASIC_LIMIT_INFORMATION limits = new JOBOBJECT_BASIC_LIMIT_INFORMATION();
        limits.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        if (!SetInformationJobObject(job, JobObjectBasicLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION))))
        {
            throw new Exception("SetInformationJobObject failed");
        }
        return job;
    }

    public static bool AssignCurrentProcess(IntPtr job)
    {
        return AssignProcessToJobObject(job, GetCurrentProcess());
    }
}
`;

/**
 * 生成 Windows 会话引导脚本：创建 Job Object（KILL_ON_JOB_CLOSE | BREAKAWAY_OK）
 * 并把根 PowerShell 进程 assign 进去，之后才执行用户命令。
 *
 * - 成员资格由内核在后代进程创建时强制继承，kill 根进程即可收割整棵树；
 * - assign 失败（如宿主已处于受限 job）时降级为无 containment，击杀侧回退 taskkill；
 * - containment 结果写入 marker 文件（路径经环境变量传入），不污染会话输出。
 * C# 源码经 base64 内联，避免多层引号转义。
 */
export function buildWindowsJobBootstrap(): string {
  const encoded = Buffer.from(JOB_TREE_CSHARP_SOURCE, "utf8").toString("base64");
  return [
    "$__answraJobContained = $false",
    "try {",
    `  Add-Type -TypeDefinition ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}')))`,
    "  $__answraJob = [AnswraJobTree]::CreateJob()",
    '  if (-not [AnswraJobTree]::AssignCurrentProcess($__answraJob)) { throw "job assignment rejected" }',
    "  $__answraJobContained = $true",
    "} catch {",
    "  $__answraJobContained = $false",
    "}",
    `if ($env:${JOB_MARKER_ENV}) { Set-Content -LiteralPath $env:${JOB_MARKER_ENV} -Value $__answraJobContained -NoNewline -ErrorAction SilentlyContinue }`,
  ].join("\n");
}
