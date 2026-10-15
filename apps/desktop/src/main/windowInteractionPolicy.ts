/** Windows supports a non-activating interaction style for native surfaces. */
export function isNonActivatingPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}
