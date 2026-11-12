/** CLI 文本输出端口；业务层只写字符串，不直接接触 process。 */
export interface OutputPort {
  write(chunk: string): void;
  writeError(chunk: string): void;
}

export interface TextSink {
  write(chunk: string): unknown;
}

export function createStreamOutput(stdout: TextSink, stderr: TextSink): OutputPort {
  return {
    write(chunk) {
      stdout.write(chunk);
    },
    writeError(chunk) {
      stderr.write(chunk);
    },
  };
}
