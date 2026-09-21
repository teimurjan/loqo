#!/usr/bin/env bun

/**
 * Makes every workspace package publishable by OIDC, so the release workflow's
 * first publish of a new package name doesn't fail. Run it once, locally.
 *
 * One rule per package:
 *   not on npm  → publish a placeholder to claim the name, then register trust
 *   on npm      → register trust, unless it already has some
 *
 * The placeholder is deliberate: version `0.0.0-oidc-seed` under dist-tag
 * `oidc-seed`. A prerelease matches no `^x.y.z` range and a non-`latest` tag is
 * not what a bare `bun add` resolves, so it can't be reached by accident and it
 * burns no real version number.
 *
 * The placeholder is built with `bun pm pack`, not `npm publish` from the source
 * dir: `bun pm pack` resolves `workspace:*` from bun.lock, and npm — which never
 * installed this bun workspace — would otherwise publish the literal
 * `workspace:*` specifier. That is also why the manifest's `version` is the only
 * thing rewritten, and it is written back byte-for-byte afterwards, including on
 * Ctrl-C.
 *
 * Everything is idempotent: seeded names are skipped on the next run, and so are
 * packages that already carry a trusted publisher.
 *
 * A note on 2FA. `npm trust` (and, for a brand-new name, `npm publish`) is an
 * account-security write that npm gates behind its browser-based one-time-password
 * flow — and that flow only starts on a TTY. Because every npm call here is run
 * with its output captured (to classify "already published" / "already trusted"),
 * npm sees no terminal and fails outright with EOTP. So a call that comes back
 * EOTP is retried once with the terminal attached (`npmWithAuth`): npm then prints
 * the URL to open, you authenticate in the browser, and npm caches it for the rest
 * of the run — no need to disable 2FA.
 *
 * Needs npm >= 11.5.1 for `npm trust` (`npm i -g npm@latest`).
 *
 * Usage:
 *   bun scripts/release/setup-npm-oidc.ts [--dry-run] [--filter <substr>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');

// Must match release.yml: the workflow filename and its `environment:` are both
// part of what npm verifies in the OIDC claim.
const WORKFLOW = 'release.yml';
const ENVIRONMENT = 'npm';

const SEED_VERSION = '0.0.0-oidc-seed';
const SEED_TAG = 'oidc-seed';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const filterIndex = args.indexOf('--filter');
const FILTER = filterIndex >= 0 ? args[filterIndex + 1] : undefined;

type NpmResult = { ok: boolean; output: string };

/** True when npm's failure was a missing/expired one-time password. */
const isAuthError = (output: string) => /EOTP|one-time password|two-factor/i.test(output);

const run = (file: string, argv: string[], cwd?: string) =>
  execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd });

/** `owner/repo`, from the root package.json rather than hardcoded. */
function repoSlug(): string {
  const { repository } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const url = typeof repository === 'string' ? repository : repository?.url;
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url ?? '');
  if (!match?.[1]) throw new Error(`Could not read a GitHub repo from package.json: ${url}`);
  return match[1];
}

/** npm >= 11.5.1 is the floor for the `npm trust` command. */
function ensureNpm(): void {
  const version = run('npm', ['--version']).trim();
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  const ok = major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
  if (!ok) throw new Error(`npm ${version} is too old for \`npm trust\` — run \`npm i -g npm@latest\` (need >= 11.5.1)`);
}

function ensureLoggedIn(): void {
  const whoami = () => {
    try {
      return run('npm', ['whoami']).trim();
    } catch {
      return null;
    }
  };

  let user = whoami();
  if (!user) {
    console.log('npm: not logged in — starting `npm login`');
    if (spawnSync('npm', ['login'], { stdio: 'inherit' }).status !== 0) throw new Error('npm login failed');
    user = whoami();
    if (!user) throw new Error('still not logged in after `npm login`');
  }
  console.log(`npm: logged in as ${user}`);
}

type Pkg = { dir: string; manifest: { name: string; private?: boolean; version: string } };

/** Every workspace package under packages/ that npm would accept, name-sorted. */
function publishablePackages(): Pkg[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => join(PACKAGES_DIR, entry.name))
    .flatMap((dir) => {
      try {
        return [{ dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }];
      } catch {
        return [];
      }
    })
    .filter(({ manifest }) => manifest.name && manifest.private !== true)
    .filter(({ manifest }) => !FILTER || manifest.name.includes(FILTER))
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * Every published version, newest last; empty when npm has never seen the name.
 *
 * Deliberately not `npm view <name> version`, which reports the `latest` tag — a
 * package carrying only a seed publish has no `latest`, and would read back as
 * unpublished on the next run.
 */
function publishedVersions(name: string): string[] {
  let stdout: string;
  try {
    stdout = run('npm', ['view', name, 'versions', '--json']);
  } catch (error) {
    // npm exits non-zero for a package it can't find, but `--json` still puts a
    // structured error body on stdout. The human text goes to stderr.
    stdout = (error as { stdout?: string }).stdout ?? '';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`could not read published versions for ${name} — npm said: ${stdout.trim().split('\n')[0] || '(nothing)'}`);
  }

  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === 'string') return [parsed];
  const error = (parsed as { error?: { code?: string; summary?: string } })?.error;
  if (error?.code === 'E404') return [];

  // Anything else — a network blip, a rate limit, an expired session — means
  // *unknown*, which is not the same as unpublished. Treating it as unpublished
  // is how an already-published package gets published over.
  throw new Error(`could not determine whether ${name} is published: ${error?.summary ?? error?.code ?? stdout.trim()}`);
}

/** Runs npm with its output captured, so a failure can be classified. */
function npmQuiet(argv: string[]): NpmResult {
  try {
    return { ok: true, output: execFileSync('npm', argv, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * Same as npmQuiet, but a captured EOTP is retried once with the terminal
 * attached so npm's browser-based OTP flow can run. The retry's output went to
 * the terminal, so only its exit code is reported back.
 */
function npmWithAuth(argv: string[]): NpmResult {
  const captured = npmQuiet(argv);
  if (captured.ok || !isAuthError(captured.output)) return captured;
  console.log('  npm wants a one-time password — reopening the prompt…');
  return { ok: spawnSync('npm', argv, { stdio: 'inherit' }).status === 0, output: '' };
}

/** The `npm error ...` lines, which is the part worth showing on a failure. */
function npmErrorSummary(output: string): string {
  const lines = output
    .split('\n')
    .filter((line) => line.includes('npm error'))
    .slice(0, 3)
    .join('; ');
  return lines || output.trim().split('\n').slice(-1)[0] || 'npm failed';
}

// Manifests currently rewritten, against their original contents. A Ctrl-C
// during the inherited-stdio publish kills this process outright — hence the
// signal handlers restore before exiting.
const rewritten = new Map<string, string>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const [file, contents] of rewritten) writeFileSync(file, contents);
    process.exit(130);
  });
}

/**
 * Claim the name with a placeholder, leaving the manifest as it was found.
 * `bun pm pack` builds the tarball so `workspace:*` is resolved to a concrete
 * version; npm just uploads it. Returns "created", or "exists" when the seed was
 * already published.
 */
function seed({ dir, manifest }: Pkg): 'created' | 'exists' {
  if (DRY_RUN) {
    console.log(`  would seed ${SEED_VERSION} (dist-tag ${SEED_TAG})`);
    return 'created';
  }

  const manifestPath = join(dir, 'package.json');
  const original = readFileSync(manifestPath, 'utf8');
  rewritten.set(manifestPath, original);
  try {
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: SEED_VERSION }, null, 2)}\n`);
    const outDir = mkdtempSync(join(tmpdir(), 'loqo-oidc-seed-'));
    const tarball = run('bun', ['pm', 'pack', '--quiet', '--destination', outDir], dir).trim().split('\n').pop()!;

    const { ok, output } = npmWithAuth(['publish', tarball, '--access', 'public', '--tag', SEED_TAG]);
    if (ok) return 'created';
    // The registry is eventually consistent: a name published minutes ago can
    // still read as missing, sending a re-run back through here. Refusing the
    // duplicate is npm doing its job, not a failure of this script.
    if (/cannot publish over|previously published|EPUBLISHCONFLICT/i.test(output)) return 'exists';
    throw new Error(npmErrorSummary(output));
  } finally {
    writeFileSync(manifestPath, original);
    rewritten.delete(manifestPath);
  }
}

/**
 * Registers the trusted publisher. Returns "created", or "exists" when npm
 * already had one.
 *
 * There is deliberately no check-before-write: `npm trust list` is OTP-gated
 * even on a read, so asking is less reliable than trying. npm answers a
 * duplicate with 409 Conflict, the authoritative "already trusted".
 */
function trust(name: string, slug: string): 'created' | 'exists' {
  const argv = ['trust', 'github', name, '--file', WORKFLOW, '--repo', slug, '--env', ENVIRONMENT, '--allow-publish', '--yes'];
  if (DRY_RUN) {
    console.log(`  would run: npm ${argv.join(' ')}`);
    return 'created';
  }

  const { ok, output } = npmWithAuth(argv);
  if (ok) return 'created';
  if (/\bE?409\b|Conflict/.test(output)) return 'exists';
  throw new Error(npmErrorSummary(output));
}

function main(): void {
  const slug = repoSlug();
  console.log(`Trusted publisher target: ${slug} · ${WORKFLOW} · environment "${ENVIRONMENT}"`);
  if (DRY_RUN) console.log('(dry run — nothing will be published or changed)');

  if (!DRY_RUN) {
    ensureNpm();
    ensureLoggedIn();
  }

  const packages = publishablePackages();
  console.log(`\nChecking ${packages.length} publishable packages…\n`);

  const seeded: string[] = [];
  const trusted: string[] = [];
  const skipped: string[] = [];
  // One package failing shouldn't cost the run: this is idempotent, but a mid-run
  // abort still means re-checking everything to find where it stopped.
  const failed: string[] = [];

  for (const pkg of packages) {
    const { name } = pkg.manifest;
    try {
      const versions = publishedVersions(name);

      let state: string;
      if (versions.length === 0) {
        state = seed(pkg) === 'created' ? `seeded ${SEED_VERSION}` : `already seeded ${SEED_VERSION}`;
        if (state.startsWith('seeded')) seeded.push(name);
      } else {
        state = `on npm (${versions[versions.length - 1]})`;
      }

      if (trust(name, slug) === 'exists') {
        skipped.push(name);
        console.log(`▸ ${name} — ${state}, already trusted`);
      } else {
        trusted.push(name);
        console.log(`▸ ${name} — ${state}, trust registered`);
      }
    } catch (error) {
      console.error(`▸ ${name} — failed: ${(error as Error).message.split('\n')[0]}`);
      failed.push(name);
    }
  }

  console.log(`\n${seeded.length} seeded · ${trusted.length} trusted · ${skipped.length} already trusted · ${failed.length} failed`);
  if (failed.length > 0) {
    console.error(`\nfailed: ${failed.join(', ')}\n  Re-run to retry these.`);
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(`\nerror: ${(error as Error).message}`);
  process.exit(1);
}
