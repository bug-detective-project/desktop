/**
 * electron-builder's afterPack: flips the Electron security fuses in the packaged binary, so it
 * cannot run as plain Node, take NODE_OPTIONS or inspector flags, or load code outside its archive.
 * The test build (dist:win:test, dist:linux:test) keeps them as they are: installed-ticket1.spec.ts
 * drives the app with Playwright, which needs them.
 */
import { join } from 'node:path';
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (packager.config.extraMetadata?.bugDetective?.testBuild) {
    console.log('  • test build: the Electron fuses stay as they are');
    return;
  }
  const executable = electronPlatformName === 'win32' ? `${packager.appInfo.productFilename}.exe` : packager.executableName;
  await flipFuses(join(appOutDir, executable), {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
}
