/* eslint-disable no-console */
import { basename } from 'path'
import semver, {ReleaseType} from 'semver'
import chalk from 'chalk'
import Table from 'cli-table'
import inquirer from 'inquirer'
import { formatWithOptions } from 'util'

import { loadWorkspaces, getTopoSort, Workspace, Workspaces, getAllWorkspaceDependents } from './workspaces'

const RELEASE_TYPES: Set<ReleaseType> = new Set(['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'])

type VersionChangeAction = ReleaseType | 'bump' | 'same' | 'manual' | 'reset'
type VersionChangeType = ReleaseType | 'bump'

class ProgramError extends Error {
    fatal = false
    constructor(msg: string, ...args: unknown[]) {
        super(formatWithOptions({ colors: process.stdout.hasColors() }, msg, ...args))
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor)
        }
    }
}

function parseSemver(version: string): semver.SemVer {
    const parsed = semver.parse(version)
    if (parsed == null) {
        throw new ProgramError(
            'Invalid Version: "%s"', version
        )
    }
    return parsed
}

function logError(error: Error) {
    if (!(error instanceof ProgramError) || error.fatal) {
        console.error(error)
    } else {
        console.error(error.message)
    }
}

function handleError(error: Error) {
    if (!(error instanceof ProgramError) || error.fatal) {
        throw error
    }

    logError(error)
}

function fail(error: Error) {
    logError(error)
    process.exit(1)
}

function isReleaseType(v: string): v is ReleaseType {
    return RELEASE_TYPES.has(v as ReleaseType)
}

function isVersionChangeAction(v: string): v is VersionChangeAction {
    return isReleaseType(v) || ['bump', 'manual', 'same'].includes(v)
}

function getNextVersion(pkg: Workspace, versionChangeType: VersionChangeType, prereleaseIdentifier = '') {
    if (!versionChangeType.startsWith('pre') && prereleaseIdentifier) {
        throw new ProgramError(
            'Can not use prereleaseIdentifier "%s" with a %s version bump. Must be a prerelease.', prereleaseIdentifier, versionChangeType
        )
    }

    if (versionChangeType === 'bump') {
        return bump(pkg.version)
    }

    if (!isReleaseType(versionChangeType)) {
        const err = new ProgramError('getNextVersion invalid release type %s', versionChangeType)
        err.fatal = true
        throw err
    }

    return parseSemver(pkg.version).inc(versionChangeType, prereleaseIdentifier).version
}

function checkVersions(oldPkg: Workspace, newPkg: Workspace): void {
    if (semver.lt(newPkg.version, oldPkg.version)) {
        const msg = 'Invalid Package Version %s: New version %s must be > old version %s.'
        throw new ProgramError(
            msg, newPkg.name, newPkg.version, oldPkg.version
        )
    }
}

function bump(version: string): string {
    const targetVersion = parseSemver(version)

    if (targetVersion.prerelease.length) {
        targetVersion.inc('prerelease')
    } else {
        targetVersion.inc('patch')
    }

    return targetVersion.version
}

const prompt = inquirer.createPromptModule()

type Choice = {
    name: string,
    value: any,
    suffix?: string,
    short?: string
}

function choices(items: Choice[]) {
    const maxLen = items.reduce((max, { name }) => Math.max(max, name.length), 0)
    return items.map(({ short, name, value, suffix, ...opts }) => ({
        name: `${name}${' '.repeat(maxLen - name.length)} ${suffix ?? ''}`.trim(),
        short: short ?? `${name} ${suffix ?? ''}`.trim(),
        value,
        ...opts
    }))
    return items
}

async function promptTargetPackages(originalWorkspaces: Workspaces, workspaces: Workspaces): Promise<Workspace[]> {
    const pkgNames = getTopoSort(workspaces)

    let pkgTargets = []
    while (!pkgTargets.length) {
        const answer = await prompt([{
            type: 'checkbox',
            name: 'value',
            message: 'Update which package(s)?',
            choices: choices([
                ...pkgNames.map((name) => {
                    const originalVersion = originalWorkspaces[name].version
                    const newVersion = workspaces[name].version
                    const isChanged = originalVersion !== newVersion
                    const suffix = isChanged
                        ? `${chalk.grey(originalVersion)} -> ${colorDiff(originalVersion, newVersion)}`
                        : `${chalk.grey(originalVersion)}`
                    return {
                        name,
                        suffix,
                        value: name,
                        checked: isChanged
                    }
                }),
                { value: 'quit', name: 'Quit' },
            ]),
            pageSize: 1000,
            default: 0,
        }])

        if (answer.value === 'quit') {
            process.exit(0)
        }

        pkgTargets = answer.value
    }

    return pkgTargets.map((name: string) => workspaces[name])
}

function colorDiff(a: string, b: string) {
    return [...b].map((v, index) => {
        if (a[index] === v) {
            return v
        }
        return `${chalk.bold(v)}`
    }).join('')
}

async function promptChangeAction(originalPkg: Workspace, targetPackage: Workspace): Promise<VersionChangeAction> {
    let answer = { value: '' }
    const isChanged = originalPkg.version !== targetPackage.version

    answer = await prompt([{
        type: 'rawlist',
        name: 'value',
        message: 'What type of version change?',
        prefix: `${originalPkg.name} ${targetPackage.version}`,
        choices: choices([
            ...(!isChanged ? [] : [{ value: 'same', name: 'As-is', suffix: `${targetPackage.name} ${targetPackage.version}` }]),
            ...(!isChanged ? [] : [{ value: 'reset', name: 'Reset', suffix: `${originalPkg.name} ${originalPkg.version}` }]),
            { value: 'manual', name: isChanged ? 'Edit' : 'Manual' },
            { value: 'bump', name: 'Bump' },
            ...[...RELEASE_TYPES].reverse().map((releaseType) => {
                if (releaseType.startsWith('pre')) { return }
                const nextVersion = getNextVersion(originalPkg, releaseType)
                const version = `${colorDiff(originalPkg.version, nextVersion)}`
                return {
                    name: `${releaseType}:`,
                    suffix: `${originalPkg.name} ${originalPkg.version} -> ${version}`,
                    value: releaseType
                }
            }).filter(Boolean) as Choice[],
            { value: 'prerelease', name: 'Prerelease' },
            { value: 'quit', name: 'Quit.' },
        ]),
        pageSize: 1000,
        default: 0,
    }])

    if (answer.value === 'quit') {
        process.exit(0)
    }

    const { value } = answer

    if (!isVersionChangeAction(value)) {
        const err = new ProgramError('Invalid version change action: %s', answer.value)
        err.fatal = true
        throw err
    }
    return value
}

async function promptVersionPrerelease(originalPkg: Workspace, targetPackage: Workspace): Promise<string> {
    const v = parseSemver(originalPkg.version)
    let prereleaseAnswer: any
    if (!v.prerelease.length) {
        prereleaseAnswer = await prompt([{
            type: 'input',
            name: 'value',
            message: 'Prerelease specifier:',
            prefix: `${originalPkg.name} ${originalPkg.version}`,
            default: v.prerelease[0] || 'alpha'
        }])
    }

    const answer = await prompt([{
        type: 'rawlist',
        name: 'value',
        message: 'What type of version change?',
        prefix: `${originalPkg.name} ${originalPkg.version}`,
        choices: choices([
            { value: 'manual', name: 'Manual' },
            ...[...RELEASE_TYPES].map((releaseType) => {
                if (!releaseType.startsWith('pre')) { return }

                const nextVersion = getNextVersion(originalPkg, releaseType, prereleaseAnswer ? prereleaseAnswer.value : undefined)
                const version = `${colorDiff(originalPkg.version, nextVersion)}`
                return {
                    name: `${releaseType}:`,
                    suffix: `${originalPkg.name} ${originalPkg.version} -> ${version}`,
                    value: nextVersion
                }
            }).filter(Boolean) as Choice[],
            { value: 'back', name: 'Back' },
            { value: 'quit', name: 'Quit.' },
        ]),
        pageSize: 1000,
        default: 0,
    }])

    if (answer.value === 'back') {
        return promptChangeAction(originalPkg, targetPackage)
    }

    if (answer.value === 'quit') {
        process.exit(0)
    }

    return answer.value
}

async function promptVersionManual(oldPkg: Workspace, newPkg: Workspace) {
    let isValid = false
    let input = newPkg.version
    while (!isValid) {
        const { value } = await prompt([{
            type: 'input',
            name: 'value',
            message: 'Version:',
            prefix: `${newPkg.name} ${newPkg.version}`,
            suffix: ` ${oldPkg.version} -> `,
            default: input
        }])
        try {
            input = value
            checkVersions(oldPkg, {
                ...newPkg,
                version: input
            })
            isValid = true
        } catch (err) {
            isValid = false
            handleError(err)
        }
    }

    return input
}

function showCurrentVersions(packages: Workspaces, names: string[]) {
    const table = new Table({ head: ['Package', 'Version'].map((s) => chalk.white.dim(s)) })
    for (const name of names) {
        const pkg = packages[name]
        if (!pkg) { continue }
        const row = [chalk.white(pkg.name), chalk.grey(pkg.version)]
        table.push(row)
    }
    console.info(table.toString())
}

async function promptNewVersion(oldPkg: Workspace, newPkg: Workspace): Promise<string> {
    let actionType = ''
    while (!actionType || isVersionChangeAction(actionType) || semver.parse(actionType) == null) {
        actionType = await promptChangeAction(oldPkg, newPkg)
        if (actionType === 'same') {
            actionType = newPkg.version
        } else if (actionType === 'reset') {
            actionType = oldPkg.version
        } else if (actionType === 'manual') {
            actionType = await promptVersionManual(oldPkg, newPkg)
        } else if (actionType === 'prerelease') {
            actionType = await promptVersionPrerelease(oldPkg, newPkg)
        } else if (isReleaseType(actionType)) {
            actionType = getNextVersion(oldPkg, actionType)
        } else {
            // should not get here
            actionType = 'manual'
        }
    }
    return actionType
}

async function run() {
    const originalPackages = await loadWorkspaces()
    let packages = originalPackages
    while (true) {
        const scratchPackages = JSON.parse(JSON.stringify(packages))
        showCurrentVersions(packages, getTopoSort(packages))
        const targetPackages = await promptTargetPackages(originalPackages, packages)
        const involvedPackagesSet: Set<string> = new Set()
        for (const targetPackage of targetPackages) {
            for (const depName of getAllWorkspaceDependents(packages, targetPackage.name)) {
                involvedPackagesSet.add(depName)
            }
        }
        const involvedPackages = getTopoSort(packages).filter((name) => involvedPackagesSet.has(name))
        showCurrentVersions(packages, involvedPackages)

        for (const targetPackage of targetPackages) {
            const originalPkg = originalPackages[targetPackage.name]
            scratchPackages[targetPackage.name].version = await promptNewVersion(originalPkg, targetPackage)
        }
        const targetPackageNames = new Set(targetPackages.map((p) => p.name))

        for (const targetPackage of targetPackages) {
            for (const depName of getAllWorkspaceDependents(originalPackages, targetPackage.name)) {
                if (targetPackageNames.has(depName)) {
                    continue
                }
                const pkg = originalPackages[depName]
                scratchPackages[pkg.name].version = getNextVersion(pkg, 'bump')
            }
        }

        console.info('\nPreview')

        const table = new Table({ head: ['Package', 'From', 'To', 'Type', 'Status'].map((s) => chalk.white.dim(s)) })
        for (const name of involvedPackages) {
            const oldPkg = originalPackages[name]
            const pkg = scratchPackages[name]
            let error: Error | undefined
            try {
                checkVersions(oldPkg, pkg)
            } catch (err) {
                error = err
            }

            const row = [
                chalk.white(pkg.name),
                chalk.grey(oldPkg.version),
                colorDiff(oldPkg.version, pkg.version),
                semver.diff(oldPkg.version, pkg.version) ?? '',
                error?.message ?? ''
            ]
            table.push(row)
        }

        console.log(table.toString())
        console.log()

        const answer = await prompt([{
            type: 'confirm',
            name: 'confirmVersions',
            message: 'Versions ok?',
        }])
        if (!answer.confirmVersions) {
            packages = scratchPackages
        } else {
            printInstructions(originalPackages, scratchPackages)
            break
        }
    }
}

function printInstructions(oldPkgs: Workspaces, newPkgs: Workspaces) {
    const packageNames = getTopoSort(newPkgs).reverse()
    const changed = packageNames.filter((name) => {
        const oldPkg = oldPkgs[name]
        const newPkg = newPkgs[name]
        return oldPkg.version !== newPkg.version
    })

    for (const name of changed) {
        const newPkg = newPkgs[name]
        const oldPkg = oldPkgs[name]
        const { version } = newPkg
        const localName = basename(newPkg.dirPath)
        const v = parseSemver(version)
        const publishTag = v.prerelease.length ? v.prerelease[0] : ''
        console.info(`\n# ${name} ${oldPkg.version} -> ${newPkg.version}`)
        console.info(`npm pkg set version=${version}${publishTag ? ` publishConfig.tag=${publishTag}` : ''} -w ${name}`)
        console.info(`git tag ${localName}/v${version}`)
        console.info(`npm run release -w ${name}`)
    }
}

run().catch(fail)
