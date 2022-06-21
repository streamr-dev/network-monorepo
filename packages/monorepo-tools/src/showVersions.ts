//import { $ } from 'zx'
//import { join } from 'path'
import semver from 'semver'
import Table from 'cli-table'
import { loadWorkspaces, getTopoSort } from './workspaces'
import chalk from 'chalk'

;(async () => {
    const packages = await loadWorkspaces()
    const pkgNames = new Set(getTopoSort(packages).reverse())
    const pkgVersions = [...pkgNames].map((name) => packages[name].version)

    const legend = `${chalk.green('✓')}${chalk.white(' = Symlink')}`
    const headerNames = [...pkgNames].map((name, index) => `${chalk.white(name)}\n${chalk.grey(pkgVersions[index])}`)
    // package names are column names
    const table = new Table({ head: [legend, ...headerNames] })

    const warnings: string[] = []
    let index = -1
    pkgNames.forEach((pkgName) => {
        index += 1
        const pkgJSON = packages[pkgName]
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
            const { version } = packages[name]
            const shouldLink = semver.satisfies(version, semverRange)
            const minVersion = semver.minVersion(semverRange)
            const exact = minVersion != null && semver.eq(version, minVersion)

            if (!exact) {
                warnings.push([
                    `${chalk.white(pkgJSON.name)} dependency on ${chalk.white(name)} ${chalk.grey(version)}`,
                    `not exact match for range: ${chalk.yellow(semverRange)}`,
                ].join(' '))
            }
            if (!shouldLink) {
                warnings.push(
                    `${chalk.white(pkgJSON.name)} depends on non-linked ${chalk.white(name)}: ${chalk.red(semverRange)}`
                )
            }

            return (
                `${(shouldLink && exact) ? `${chalk.green('✓')} ${semverRange}` : (shouldLink ? chalk.yellow(semverRange) : chalk.red(semverRange))}`
            )
        })

        table.push({
            [headerNames[index]]: depsOutput
        })
    })

    console.info(table.toString())
    if (warnings.length) {
        console.info(`\n${chalk.yellow('Warnings: ')}\n`)
        console.info(warnings.join('\n'))
    }
})()
