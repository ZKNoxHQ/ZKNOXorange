// ZKNOX Apps Catalog - resolution of app artifacts.
//
// Two layouts:
//
//   1. `dir` (legacy): a directory served next to the sideloader, holding a
//      single-target app.hex / app.map / Makefile / manifest.json. The
//      sideloader parses them and drives loadApp().
//
//   2. `repo`: the offline load script committed by the firmware repository
//      at build/<profile>/<target>/app.apdu is fetched from
//      raw.githubusercontent.com (CORS "*") and replayed as is through
//      replayApduScript(). Nothing is rebuilt, parsed or recomputed: targetId,
//      api_level, section sizes and flags are those the SDK baked in at build
//      time. `target` is derived from the connected device's targetId so one
//      entry covers every device the repository ships. `profile` is `prod`
//      (default) or `dev` (MODE=debug FROST=1 builds, which carry the
//      key-extraction instructions: never serve them to end users). The
//      artifact-manifest.txt beside the script, when present, is read and
//      checked: a `mode=debug` manifest is refused unless profile is `dev`.
//
// `ref` is a branch, tag or commit SHA. A pinned SHA is the only value that
// makes the served binary reproducible; `main` is for development.

import { TARGET_IDS } from './loadApp.js';
import { parseApduScript, describeApduScript } from './apduScript.js';
import { getDeviceInfo } from './device.js';

// targetId -> build/<target> directory name used by the Ledger SDK.
export const TARGET_DIRS = {
  [TARGET_IDS.NANO_S_PLUS]: 'nanos2',
  [TARGET_IDS.NANO_X]: 'nanox',
  [TARGET_IDS.STAX]: 'stax',
  [TARGET_IDS.FLEX]: 'flex',
  // Apex P: ZKNOX-HW-PRIVACY ships build/apex_p/, but its targetId is not in
  // TARGET_IDS yet. Add TARGET_IDS.APEX_P from the SDK's Makefile.target and
  // map it here.
};

export const DIR_ARTIFACT_FILES = ['app.hex', 'app.map', 'Makefile', 'manifest.json'];

export function targetDir(targetId) {
  const dir = TARGET_DIRS[targetId];
  if (!dir) {
    throw new Error(`Unsupported targetId 0x${targetId.toString(16)}: no build directory known`);
  }
  return dir;
}

function rawBase(entry) {
  const ref = entry.ref || 'main';
  return `https://raw.githubusercontent.com/${entry.repo}/${ref}`;
}

// URLs of the files a layout needs.
//   repo -> { 'app.apdu': url, 'artifact-manifest.txt': url }
//   dir  -> { 'app.hex': url, 'app.map': url, 'Makefile': url, 'manifest.json': url }
export function resolveCatalogFiles(entry, targetId) {
  if (entry.repo) {
    const profile = entry.profile || 'prod';
    const bin = `${rawBase(entry)}/${entry.binDir || 'build/{profile}/{target}'}`
      .replace('{profile}', profile)
      .replace('{target}', targetDir(targetId));
    return { 'app.apdu': `${bin}/app.apdu`, 'artifact-manifest.txt': `${bin}/artifact-manifest.txt` };
  }
  if (entry.dir) {
    return Object.fromEntries(DIR_ARTIFACT_FILES.map((f) => [f, `${entry.dir}/${f}`]));
  }
  throw new Error(`Catalog entry '${entry.id}' has neither 'repo' nor 'dir'`);
}

async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) {
    throw new Error(`${url}: HTTP ${r.status}`);
  }
  return r.text();
}

// key=value lines -> object (artifact-manifest.txt: target, backend, mode, frost, commit, elf_sha256)
export function parseArtifactManifest(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Fetches what the entry's layout needs.
//   repo -> { layout: 'repo', apdu: text, info: { appName, loadBytes, loadChunks, apdus }, manifest: {...}|null, urls }
//   dir  -> { layout: 'dir', hex, map, makefile, manifest, urls }
// `targetId` may be omitted when `dongle` is given: it is then read from the
// device (GET_VERSION on the dashboard) and returned as `targetId`.
export async function fetchCatalogApp(entry, targetId = null, dongle = null) {
  if (targetId === null) {
    if (dongle === null) throw new Error('fetchCatalogApp: targetId or dongle required');
    targetId = (await getDeviceInfo(dongle)).targetId;
  }
  const urls = resolveCatalogFiles(entry, targetId);
  if (entry.repo) {
    const profile = entry.profile || 'prod';
    const apdu = await fetchText(urls['app.apdu']);
    const info = describeApduScript(parseApduScript(apdu));
    let manifest = null;
    try {
      manifest = parseArtifactManifest(await fetchText(urls['artifact-manifest.txt']));
    } catch (e) {
      manifest = null; // older layouts have none
    }
    if (manifest && manifest.mode && manifest.mode !== 'prod' && profile !== 'dev') {
      throw new Error(`${entry.id}: refusing a ${manifest.mode} build under profile '${profile}'`);
    }
    return { layout: 'repo', apdu, info, manifest, profile, urls, targetId };
  }
  const [hex, map, makefile, manifestText] = await Promise.all([
    fetchText(urls['app.hex']),
    fetchText(urls['app.map']),
    fetchText(urls['Makefile']),
    fetchText(urls['manifest.json']),
  ]);
  return { layout: 'dir', hex, map, makefile, manifest: JSON.parse(manifestText), urls, targetId };
}
