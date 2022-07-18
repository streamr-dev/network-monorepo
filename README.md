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
* [utils](packages/utils/README.md) (@streamr/utils)
* [cli-tools](packages/cli-tools/README.md) (@streamr/cli-tools)
* [tracker](packages/network-tracker/README.md)(@streamr/network-tracker)

## CI Status

[![Client – Lint, Unit, Integration Tests](https://github.com/streamr-dev/monorepo/actions/workflows/client-code.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/client-code.yml)
[![Client – Test Build](https://github.com/streamr-dev/monorepo/actions/workflows/client-build.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/client-build.yml)
[![Protocol – Lint, Test and Publish](https://github.com/streamr-dev/monorepo/actions/workflows/protocol.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/protocol.yml)
[![Broker – Lint, Test and Publish](https://github.com/streamr-dev/monorepo/actions/workflows/broker.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/broker.yml)
[![Network – Lint, Test and Publish](https://github.com/streamr-dev/monorepo/actions/workflows/network.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/network.yml)
[![Tracker – Lint, Test and Publish](https://github.com/streamr-dev/monorepo/actions/workflows/tracker.yml/badge.svg)](https://github.com/streamr-dev/monorepo/actions/workflows/tracker.yml)

## NPM scripts
| NodeJS version `16.13.x` and NPM version `8.x` is required |
| --- |

Monorepo is managed using [npm workspaces](https://docs.npmjs.com/cli/v7/using-npm/workspaces).

Installation on an M1 Mac requires additional steps, see [install-on-m1.md](/install-on-m1)

**Important:** Do not use `npm ci` or `npm install` directly in the sub-package directories.

### Bootstrap all sub-packages
The go to command for most use cases.

To install all required dependencies and build all sub-packages (linking sub-packages together as needed):

```bash
# from top level
npm run bootstrap
```

###  Bootstrap a single sub-package

To install the required dependencies and build a specific sub-package:

```bash
# from top level
npm run bootstrap-pkg --package=$PACKAGE_NAME
```

### Install dependencies only

To only install required dependencies and link sub-packages together (and skip build phase):

```bash
# from top level
npm ci
```

### Build
To build all sub-packages:
```bash
# from top level
npm run build
```

### Build a sub-package
To build a specific sub-package:
```bash
# from top level
npm run build --workspace=$PACKAGE_NAME
```

### Clear caches and built files

To clear all caches and remove the `dist` directory from each sub-package:

```bash
# from top level
npm run clean-dist
```

### Clean all

To removes all caches, built files, and **`node_modules`** of each sub-package, and the
top-level **`node_modules`**:

```bash
# from top level
npm run clean
```

### Install git hooks
To install git hooks (e.g. Husky for conventional commit validation):

```bash
npm run install-git-hooks
```

### Add a dependency into a sub-package

Manually add the entry to the `package.json` of the sub-package and 
run `npm run bootstrap-pkg $PACKAGE_NAME`.

Alternatively:
```bash
npm install some-dependency --workspace=$PACKAGE_NAME
```

### List active versions & symlinks

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

