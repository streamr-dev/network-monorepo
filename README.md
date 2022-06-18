<p align="center">
  <a href="https://streamr.network">
    <img alt="Streamr" src="https://raw.githubusercontent.com/streamr-dev/network-monorepo/main/packages/client/readme-header-img.png" width="1320" />
  </a>
</p>

# Network Monorepo

Monorepo for Streamr Network packages.

## Packages

* [broker](packages/broker/README.md) (streamr-broker)
* [client](packages/client/README.md) (streamr-client)
* [network](packages/network/README.md) (streamr-network)
* [protocol](packages/protocol/README.md) (streamr-client-protocol)
* [test-utils](packages/test-utils/README.md) (streamr-test-utils)
* [cli-tools](packages/cli-tools/README.md) (@streamr/cli-tools)
* [tracker](packages/network-tracker/README.md)(@streamr/network-tracker)

## CI Status

[![Client – Lint, Unit, Integration Tests](https://github.com/streamr-dev/monorepo/actions/workflows/client-code.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/client-code.yml)
[![Client – Test Build](https://github.com/streamr-dev/monorepo/actions/workflows/client-build.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/client-build.yml)
[![Protocol – Lint, Test and Publish](https://github.com/streamr-dev/monorepo/actions/workflows/protocol.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/protocol.yml)
[![Broker – Lint, Test and Publish](https://github.com/streamr-dev/monorepo/actions/workflows/broker.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/broker.yml)
[![Network – Lint, Test and Publish](https://github.com/streamr-dev/monorepo/actions/workflows/network.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/network.yml)
[![Tracker – Lint, Test and Publish](https://github.com/streamr-dev/monorepo/actions/workflows/tracker.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/tracker.yml)

## Install
| NodeJS version `16.13.x` and NPM version `8.x` is required |
| --- |

Installation on an M1 Mac requires additional steps, see [install-on-m1.md](/install-on-m1)

Uses [npm workspaces](https://docs.npmjs.com/cli/v7/using-npm/workspaces) to manage monorepo.

**Important:** Do not use `npm ci` or `npm install` directly in the sub-package directories.

### Install all sub-packages

Install the dependencies and build all sub-packages, linking sub-packages together as needed.

```bash
# from top level
npm ci
```

###  Install a sub-package

Install and build a single sub-package.

The script `bootstrap-pkg` installs the dependencies of a given sub-package, building and linking any required internal
sub-packages (by running their `prepare` scripts), and finally the target dependency by using its `prepare` script.

```bash
# from top level
npm run bootstrap-pkg $PACKAGE_NAME
```

Examples:
```bash
# from top level
npm run bootstrap-pkg streamr-client
npm run bootstrap-pkg streamr-network
```

## Build all sub-packages
To build all sub-packages (with dependencies pre-installed beforehand)
```bash
# from top level
npm run build
```

## Regenerate lockfile

```bash
# from top level
npm run clean-lockfiles
```

## Clear caches and built files

The below clears all caches and removes `dist` directories from each sub-package.

```bash
# from top level
npm run clean-dist
```

Alternatively, to just clear caches.

```bash
# from top level
npm run clean-cache
```


## Clean all

This removes all caches, built files, and `node_modules` of each sub-package, and the
top-level `node_modules`.

You will need to run `npm ci`, `npm install`, or `npm run bootstrap`  before proceeding.

```bash
# from top level
npm run clean
```

## Add a dependency into a sub-package

Manually add the entry to the `package.json` of the sub-package and 
run `npm run bootstrap-pkg $PACKAGE_NAME`.

Alternatively:
```bash
npm install some-dependency --workspace=$PACKAGE_NAME
```

## List active versions & symlinks

Check which sub-packages are currently being symlinked.

```bash
# from top level
npm run versions
```

This lists sub-packages & their versions on the left, linked
sub-packages are columns.  If the package on the left links to the package
in the column, it shows a checkmark & the semver range, otherwise it
shows the mismatched semver range and prints a warning at the end.  It
prints the version ranges so you can double-check that they're formatted
as you expect e.g. `^X.Y.Z` vs `X.Y.Z`

![image](https://user-images.githubusercontent.com/43438/135347920-97d6e0e7-b86c-40ff-bfc9-91f160ae975c.png)

## Commands Reference

| Command                                                            | After (using `npm` workspaces)                                                                                                                                                                |
|--------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `npm ci`                                                           | Installs all top-level dependencies AND sub-packages according to top-level `package-lock.json`                                                                                               |
| `npm install`                                                      | Installs all top-level dependencies AND sub-packages and updates `package-lock.json`. Will install new sub-package dependencies.                                                              |
| `npm run bootstrap`                                                | Runs `npm ci`.                                                                                                                                                                                |
| `npm run bootstrap-pkg streamr-network`                            | Installs top-level dependencies AND the dependencies for a sub-package using package-lock. Does not update `package-lock.json`. Will not install new sub-package dependencies.                |
| `npm install --include-workspace-root --workspace streamr-network` | Installs top-level dependencies (`--include-workspace-root`) AND the dependencies for a sub-package. Will update `package-lock.json`. Will install new sub-package dependencies.              | 
| `npm run clean-dist`                                               | Removes cache and `dist` from sub-packages. Removes cache from top-level.                                                                                                                     |
| `npm run clean`                                                    | Removes all cache, dist & packages from root & sub-package `node_modules/`, except those packages needed by the top-level `package.json` e.g. `zx`.                                           | 
| `npm run prune-pkg streamr-broker`                                 | Removes all packages except the production deps needed by the specified package's `package.json`. Note they will be installed in the top-level `node_modules/` not `packages/*/node_modules/` | 
| `npm run bootstrap-root`                                           | Removes all packages except those needed by top-level `package.json`.                                                                                                                         |
| `npm run fix`                                                      | Runs `eslint --fix` in all packages and `manypkg fix`.                                                                                                                                        |
| `npm run clean-package-locks`                                      | Removes only top-level package-lock.  There should only be a single top-level package-lock.                                                                                                   |

## Releasing

### Network
```
git checkout main
cd packages/network
npm version <SEMVER_OPTION>
# Go thru other packages' package.json and update streamr-network entry (if present) to newly generated version
git add package.json
git commit -m "release(network): vX.Y.Z"
git tag network/vX.Y.Z
git push origin
git push origin network/vX.Y.Z

npm publish
```

### Client
- Update & Editorialize CHANGELOG.md as necessary 

```
git checkout main
cd packages/client
npm version <SEMVER_OPTION>
# Go thru broker's and cli-tools' package.json and update streamr-client entry to newly generated version
git add package.json
git commit -m "release(client): vX.Y.Z"
git tag client/vX.Y.Z
git push origin
git push origin client/vX.Y.Z

# If everything above went thru
npm run build-production
cd dist
npm publish

# Generate & upload API docs (if a major/minor version update)
cd ..
npm run docs
aws s3 cp ./docs s3://api-docs.streamr.network/client/vX.Y --recursive --profile streamr-api-docs-upload
# and update the API reference link in s3://api-docs.streamr.network/index.html
```

### cli-tools
- Update & Editorialize CHANGELOG.md as necessary 

```
git checkout main
cd packages/cli-tools
npm version <SEMVER_OPTION>
git add package.json
git commit -m "release(cli-tools): vX.Y.Z"
git tag cli-tools/vX.Y.Z
git push origin
git push origin cli-tools/vX.Y.Z

npm run build
npm publish
```


### broker
```
git checkout main
cd packages/broker
npm version <SEMVER_OPTION>
git add package.json
git commit -m "release(broker): vX.Y.Z"
git tag broker/vX.Y.Z
git push origin
git push origin broker/vX.Y.Z

npm run build
npm publish
```

## Important changes to the bootstrap/install scripts as of 48e165f:

### Key Changes

* The monorepo is now using `npm workspaces` instead of `lerna`.
* Use `npm@8`, workspaces on `npm@7` are buggy.
* Learn about npm workspaces: https://docs.npmjs.com/cli/v8/using-npm/workspaces
* Ensure you know about and understand these npm flags:
  [`--workspaces`](https://docs.npmjs.com/cli/v8/using-npm/config#workspaces),
  [`--include-workspace-root`](https://docs.npmjs.com/cli/v8/using-npm/config#include-workspace-root)
  and
  [`--workspace`](https://docs.npmjs.com/cli/v8/using-npm/config#workspace),
  as well as how they work with [`npm
  install`](https://docs.npmjs.com/cli/v8/commands/npm-install#workspace)
  and [`npx`/`npm
  exec`](https://docs.npmjs.com/cli/v8/commands/npm-exec#workspaces-support).
* `npm ci` will install everything. `npm run bootstrap` is `npm ci`.
* You can now bootstrap individual workspaces like `npm run
  bootstrap-pkg streamr-network`, without running anything else
  beforehand. No `npm ci`, `npm install` or `npm run bootstrap` needed.
  `bootstrap-pkg` installs both top-level and sub-dependencies. This is
  equivalent to what `npm ci && npm run bootstrap-pkg streamr-network`
  used to do.
* To install dependencies into a sub-package you should use `npm install
  --workspace` from the top-level, with the name of the sub-package you
  want to update. e.g. `npm install --workspace=streamr-network`, or
  just regular `npm install` at the top-level to install everything.
  It's possible these two commands will generate different package-lock
  results 🤷 .
* `npm run bootstrap-root` Removes dist/cache & any sub-package
  dependencies from `node_modules`, leaving `package-lock.json` and
  `package.json` alone.  Use when you (only) want to be able to run
  top-level scripts e.g. `npm run versions` without installing anything
  else.
* `npm run eslint` runs `eslint` for all packages. This runs as a
  git push hook.
* `npm run versions` also run `manypkg check`. This lints package.json
  to do things like ensure all packages are using the same versions of
  dependencies. e.g. same version of TS in every package.
