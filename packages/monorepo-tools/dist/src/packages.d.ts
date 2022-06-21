import type { PackageJson, SetRequired } from 'type-fest';
declare type Workspace = SetRequired<PackageJson, 'name' | 'version'>;
declare type Workspaces = Record<string, Workspace>;
export declare function loadPackages(): Promise<Workspaces>;
export declare function getWorkspaceDependencyNames(workspaces: Workspaces, name: string): string[];
export {};
