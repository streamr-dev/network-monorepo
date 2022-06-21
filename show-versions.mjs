#!/usr/bin/env npx zx

import { join } from 'path'
import semver from 'semver'
import Table from 'cli-table'
$.verbose = false

const packages = JSON.parse(await $`lerna list --all --json --loglevel=silent --toposort`)
const pkgNames = new Set(packages.map(({ name }) => name))
const pkgVersions = packages.map(({ version }) => version)
const pkgJSONs = packages.reduce((obj, info) => {
    const pkgJSONPath = join(info.location, 'package.json')
    obj[info.name] = require(pkgJSONPath)
    return obj
}, {})

const legend = `${chalk.green('✓')}${chalk.white(' = Symlink')}`
const headerNames = [...pkgNames].map((name, index) => `${chalk.white(name)}\n${chalk.grey(pkgVersions[index])}`)
// package names are column names
const table = new Table({ head: [legend, ...headerNames] })

const publishedPackageNames = [...pkgNames].filter((pkgName) => (pkgName === 'streamr-client' || !pkgJSONs[pkgName].private))

//const publishedDistTags = (await Promise.all(publishedPackageNames.map(async (pkgName) => {
    //const d = await (await $`npm info ${pkgName} dist-tags --json`).stdout
    //console.log({ pkgName: d })
    //return JSON.parse(d)
//}))).reduce((obj, distTags, index) => {
    //obj[publishedPackageNames[index]] = distTags
    //return obj
//}, {})

//console.log(publishedDistTags)
const npmTable = new Table({ head: [legend, ...headerNames] })

const warnings = []
packages.forEach((pkg, index) => {
    const pkgJSON = pkgJSONs[pkg.name]
    // all dependencies of pkg
    const deps = Object.entries({ ...pkgJSON.dependencies, ...pkgJSON.devDependencies })
        .filter(([name]) => pkgNames.has(name))

    // create output for each column
    const depsOutput = [...pkgNames].map((colName) => {
        // find deps for this column
        const dep = deps.find(([name]) => name === colName)
        if (!dep) {
            // pkg.name does not use pkg matching this column
            return ''
        }

        const [ name, semverRange ] = dep
        const { version } = pkgJSONs[name]
        const shouldLink = semver.satisfies(version, semverRange)
        const exact = semver.eq(version, semver.minVersion(semverRange))

        if (!exact) {
            warnings.push(`${chalk.white(pkg.name)} dependency on ${chalk.white(name)} ${chalk.grey(version)} not exact match for range: ${chalk.yellow(semverRange)}`)
        }
        if (!shouldLink) {
            warnings.push(`${chalk.white(pkg.name)} depends on non-linked ${chalk.white(name)}: ${chalk.red(semverRange)}`)
        }
        return `${(shouldLink && exact) ? `${chalk.green('✓')} ${semverRange}` : (shouldLink ? chalk.yellow(semverRange) : chalk.red(semverRange))}`
    })

    table.push({
        [headerNames[index]]: depsOutput
    })
})

console.log(table.toString())
if (warnings.length) {
    console.log(`\n${chalk.yellow('Warnings: ')}\n`)
    console.log(warnings.join('\n'))
}
