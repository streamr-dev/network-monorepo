"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWorkspaceDependencyNames = exports.loadPackages = void 0;
const path_1 = require("path");
const promises_1 = require("fs/promises");
const util_1 = require("util");
const child_process_1 = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert'); // esm/ts bs
const exec = (0, util_1.promisify)(child_process_1.exec);
async function getWorkspacePaths() {
    const { stdout } = await exec(`npx --workspaces -c 'pwd'`);
    return stdout.trim().split('\n');
}
async function getWorkspace(workspacePath) {
    const pkgJSONPath = (0, path_1.join)(workspacePath, 'package.json');
    const pkgJSON = JSON.parse(await (0, promises_1.readFile)(pkgJSONPath, 'utf8'));
    assert.ok(pkgJSON.name, 'name required');
    assert.ok(pkgJSON.version, 'version required');
    return ({
        ...pkgJSON,
        path: pkgJSONPath,
        dirPath: workspacePath
    });
}
async function getWorkspaces() {
    const paths = await getWorkspacePaths();
    const workspacesList = await Promise.all(paths.map(async (p) => getWorkspace(p)));
    return workspacesList.reduce((o, w) => Object.assign(o, {
        [w.name]: w
    }), {});
}
async function loadPackages() {
    const workspaces = await getWorkspaces();
    console.info(workspaces);
    const graph = createWorkspaceGraph(workspaces);
    console.info(graph.toObject());
    return workspaces;
}
exports.loadPackages = loadPackages;
function getWorkspaceDependencyNames(workspaces, name) {
    const pkgJSON = workspaces[name];
    if (!pkgJSON) {
        throw new Error(`Unknown package: ${name}`);
    }
    const pkgNames = new Set(Object.keys(workspaces));
    // all dependencies of pkg
    return Object.keys({ ...pkgJSON.dependencies, ...pkgJSON.devDependencies })
        .filter((name) => pkgNames.has(name));
}
exports.getWorkspaceDependencyNames = getWorkspaceDependencyNames;
class Graph {
    constructor() {
        this.nodes = new Map();
    }
    addNode(id) {
        if (this.nodes.has(id)) {
            return;
        }
        this.nodes.set(id, new Set());
    }
    addEdge(from, to) {
        this.addNode(from);
        this.addNode(to);
        this.nodes.get(from).add(to);
    }
    getConnections(from) {
        this.addNode(from);
        return this.nodes.get(from);
    }
    toObject() {
        return [...this.nodes.entries()].reduce((o, [key, value]) => {
            return Object.assign(o, {
                [key]: [...value],
            });
        }, {});
    }
}
function createWorkspaceGraph(workspaces) {
    const graph = new Graph();
    const pkgNames = new Set(Object.keys(workspaces));
    for (const name of pkgNames) {
        graph.addNode(name);
        const depWorkspaces = getWorkspaceDependencyNames(workspaces, name);
        for (const depName of depWorkspaces) {
            graph.addEdge(name, depName);
        }
    }
    return graph;
}
//# sourceMappingURL=packages.js.map