/**
 * `node-scoped`: release-please's `node` release type, attributed by conventional-commit scope
 * instead of by path alone. A commit counts towards a package only when its scope names the
 * package — `feat(sdk): …` releases @loqo/sdk, `feat(sdk,payload): …` both, `feat: …` nothing —
 * on top of the path split release-please already does, so it must touch the package too.
 *
 * The release pull request also moves the package's version in `bun.lock`: `bun pm pack` resolves
 * `workspace:*` from the lockfile, not from package.json, and `bun install` leaves a stale entry
 * alone.
 */
import type { BuildUpdatesOptions, ConventionalCommit } from 'release-please';
import { Node } from 'release-please/build/src/strategies/node';
import type { Update, Updater } from 'release-please/build/src/update';

export const RELEASE_TYPE = 'node-scoped';

const scopesOf = (commit: ConventionalCommit) => commit.scope?.split(',').map((scope) => scope.trim()) ?? [];

class BunLockWorkspaceVersion implements Updater {
  constructor(
    private readonly workspacePath: string,
    private readonly version: string,
  ) {}

  updateContent(content: string | undefined) {
    const entry = new RegExp(`("${RegExp.escape(this.workspacePath)}":\\s*\\{\\s*"name":\\s*"[^"]*",\\s*"version":\\s*")[^"]*(")`);
    if (!content || !entry.test(content)) throw new Error(`bun.lock has no version for workspace ${this.workspacePath}`);
    return content.replace(entry, (_, head: string, tail: string) => `${head}${this.version}${tail}`);
  }
}

export class ScopedNode extends Node {
  protected override async postProcessCommits(commits: ConventionalCommit[]) {
    const component = await this.getComponent();
    if (!component) return [];
    return commits.filter((commit) => scopesOf(commit).includes(component));
  }

  protected override async buildUpdates(options: BuildUpdatesOptions): Promise<Update[]> {
    const updates = await super.buildUpdates(options);
    const bunLock: Update = {
      path: 'bun.lock',
      createIfMissing: false,
      updater: new BunLockWorkspaceVersion(this.path, options.newVersion.toString()),
    };
    return [...updates, bunLock];
  }
}
