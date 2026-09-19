/**
 * What googleapis/release-please-action does, with the `node-scoped` release type registered first
 * (the action cannot load one). Tags and publishes GitHub releases for merged release pull requests,
 * then opens or refreshes the next ones; the released paths land in $GITHUB_OUTPUT for the publish
 * job. `--dry-run` only prints the pull requests the next run would open.
 */
import { appendFileSync } from 'node:fs';
import { GitHub, Manifest, registerReleaseType, VERSION } from 'release-please';
import { RELEASE_TYPE, ScopedNode } from './strategy.ts';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

registerReleaseType(RELEASE_TYPE, (options) => new ScopedNode(options));

const [owner, repo] = env('GITHUB_REPOSITORY').split('/');
if (!owner || !repo) throw new Error('GITHUB_REPOSITORY must be owner/repo');
const github = await GitHub.create({ owner, repo, token: env('GITHUB_TOKEN') });
const manifest = () => Manifest.fromManifest(github, github.repository.defaultBranch);
console.log(`release-please ${VERSION} on ${owner}/${repo}@${github.repository.defaultBranch}`);

if (process.argv.includes('--dry-run')) {
  const candidates = await (await manifest()).buildPullRequests();
  if (candidates.length === 0) console.log('nothing to release');
  for (const candidate of candidates) console.log(`${candidate.title.toString()}\n\n${candidate.body.toString()}\n`);
  process.exit(0);
}

const releases = (await (await manifest()).createReleases()).filter((release) => release !== undefined);
for (const release of releases) console.log(`released ${release.tagName}: ${release.url}`);

const pullRequests = (await (await manifest()).createPullRequests()).filter((pullRequest) => pullRequest !== undefined);
for (const pullRequest of pullRequests) console.log(`release pull request #${pullRequest.number}: ${pullRequest.title}`);

const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `paths_released=${JSON.stringify(releases.map((release) => release.path))}\n`);
