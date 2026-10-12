type PromiseWithTry = PromiseConstructor & {
  try?: <T>(callback: (...args: never[]) => T | PromiseLike<T>) => Promise<Awaited<T>>;
};

export function ensurePromiseTry(): boolean {
  const promiseConstructor = Promise as PromiseWithTry;
  if (promiseConstructor.try) return false;

  promiseConstructor.try = (callback) => {
    try {
      return Promise.resolve(callback());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return true;
}

export function createPdfWorkerBootstrap(workerUrl: string): string {
  return [
    "if (!Promise.try) {",
    "  Promise.try = (callback) => {",
    "    try { return Promise.resolve(callback()); }",
    "    catch (error) { return Promise.reject(error); }",
    "  };",
    "}",
    `await import(${JSON.stringify(workerUrl)});`,
  ].join("\n");
}
