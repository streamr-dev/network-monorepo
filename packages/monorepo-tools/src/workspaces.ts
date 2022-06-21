import { join } from 'path'
import { readFile } from 'fs/promises'
import { promisify } from 'util'
import { exec as originalExec } from 'child_process'
import type { PackageJson, SetRequired } from 'type-fest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert') // esm/ts bs

const exec = promisify(originalExec)

export type Workspace = SetRequired<PackageJson, 'name' | 'version'> & Required<{ path: string, dirPath: string }>
export type Workspaces = Record<string, Workspace>

async function getWorkspacePaths(): Promise<string[]> {
    const { stdout } = await exec(`npx --workspaces -c 'pwd'`)
    return stdout.trim().split('\n')
}

async function getWorkspace(workspacePath: string): Promise<Workspace> {
    const pkgJSONPath = join(workspacePath, 'package.json')
    const pkgJSON = JSON.parse(await readFile(pkgJSONPath, 'utf8'))
    assert.ok(pkgJSON.name, 'name required')
    assert.ok(pkgJSON.version, 'version required')
    return ({
        ...pkgJSON,
        path: pkgJSONPath,
        dirPath: workspacePath
    })
}

export async function loadWorkspaces(): Promise<Workspaces> {
    const paths = await getWorkspacePaths()
    const workspacesList = await Promise.all(paths.map(async (p) => getWorkspace(p)))
    return workspacesList.reduce((o, w) => Object.assign(o, {
        [w.name]: w
    }), {})
}

function getWorkspaceDependencyNames(workspaces: Workspaces, name: string): string[] {
    const pkgJSON = workspaces[name]
    if (!pkgJSON) {
        throw new Error(`Unknown package: ${name}`)
    }

    const pkgNames = new Set(Object.keys(workspaces))
    // all dependencies of pkg
    return Object.keys({ ...pkgJSON.dependencies, ...pkgJSON.devDependencies })
        .filter((name) => pkgNames.has(name))
}

export function getAllWorkspaceDependents(workspaces: Workspaces, name: string): string[] {
    const graph = createWorkspaceGraph(workspaces)
    const inverseGraph = graph.invert()
    const nodes = graph.getTopoSort()
    const dependents: Set<string> = new Set(name)

    function visit(n: string) {
        if (dependents.has(n)) {
            return
        }
        dependents.add(n)

        for (const dependent of inverseGraph.getConnections(n)) {
            visit(dependent)
        }
    }
    visit(name)
    return nodes.filter((n) => dependents.has(n))
}

export function getTopoSort(workspaces: Workspaces): string[] {
    const graph = createWorkspaceGraph(workspaces)
    return graph.getTopoSort()
}

class Graph {
    nodes: Map<string, Set<string>> = new Map()
    addNode(id: string) {
        if (this.nodes.has(id)) {
            return
        }

        this.nodes.set(id, new Set())
    }

    addEdge(from: string, to: string) {
        this.addNode(from)
        this.addNode(to)
        this.nodes.get(from)!.add(to)
    }

    getConnections(from: string): Set<string> {
        this.addNode(from)
        return this.nodes.get(from)!
    }

    toObject(): Record<string, string[]> {
        return [...this.nodes.entries()].reduce((o, [key, value]) => {
            return Object.assign(o, {
                [key]: [...value],
            })
        }, {})
    }

    invert(): Graph {
        const invertedGraph = new Graph()
        this.nodes.forEach((connections, from) => {
            invertedGraph.addNode(from)
            connections.forEach((to) => {
                invertedGraph.addEdge(to, from)
            })
        })
        return invertedGraph
    }

    getTopoSort(): string[] {
        // adapted from: https://en.wikipedia.org/wiki/Topological_sorting#Depth-first_search
        const pMarked: Set<string> = new Set() // permanently marked nodes
        const tMarked: Set<string> = new Set() // temporarily marked nodes
        const unmarked = new Set([...this.nodes.keys()].sort().reverse()) // unmarked nodes
        // L ← Empty list that will contain the sorted nodes
        const sortedNodes: string[] = []
        const visit = (n: string) => {
            // has a permanent mark
            if (pMarked.has(n)) {
                return
            }

            if (tMarked.has(n)) {
                // if n has a temporary mark then
                // stop   (not a DAG)
                throw new Error(`Circular dependency! ${n}`)
            }

            //mark n with a temporary mark
            tMarked.add(n)

            //for each node m with an edge from n to m do
            for (const m of this.getConnections(n)) {
                visit(m)
            }
            //remove temporary mark from n
            tMarked.delete(n)
            //mark n with a permanent mark
            pMarked.add(n)
            unmarked.delete(n) // remove from unmarked
            //add n to head of L
            sortedNodes.unshift(n)
        }

        //while exists nodes without a permanent mark do
        while (unmarked.size) {
            //select an unmarked node n
            const n = [...unmarked][0]
            visit(n)
        }

        return sortedNodes
    }
}

function createWorkspaceGraph(workspaces: Workspaces) {
    const graph = new Graph()
    const pkgNames = new Set(Object.keys(workspaces))
    for (const name of pkgNames) {
        graph.addNode(name)
        const depWorkspaces = getWorkspaceDependencyNames(workspaces, name)
        for (const depName of depWorkspaces) {
            graph.addEdge(name, depName)
        }
    }
    return graph
}
