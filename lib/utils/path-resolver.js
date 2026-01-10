import path from 'path';
import fs from 'fs/promises';
// Cache for tsconfig.json and package.json
const tsconfigCache = new Map();
const packageJsonCache = new Map();
/**
 * Load and parse tsconfig.json
 */
async function loadTsConfig(projectRoot) {
    if (tsconfigCache.has(projectRoot)) {
        return tsconfigCache.get(projectRoot);
    }
    try {
        const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
        const content = await fs.readFile(tsconfigPath, 'utf8');
        // Remove comments from JSON (basic implementation)
        const jsonContent = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
        const config = JSON.parse(jsonContent);
        tsconfigCache.set(projectRoot, config);
        return config;
    }
    catch {
        tsconfigCache.set(projectRoot, null);
        return null;
    }
}
/**
 * Load and parse package.json
 */
async function loadPackageJson(projectRoot) {
    if (packageJsonCache.has(projectRoot)) {
        return packageJsonCache.get(projectRoot);
    }
    try {
        const packageJsonPath = path.join(projectRoot, 'package.json');
        const content = await fs.readFile(packageJsonPath, 'utf8');
        const config = JSON.parse(content);
        packageJsonCache.set(projectRoot, config);
        return config;
    }
    catch {
        packageJsonCache.set(projectRoot, null);
        return null;
    }
}
/**
 * Check if a file exists with any of the given extensions
 */
async function findFileWithExtensions(basePath, extensions) {
    // Try exact path first
    try {
        const stat = await fs.stat(basePath);
        if (stat.isFile()) {
            return basePath;
        }
        // If directory, try index files
        if (stat.isDirectory()) {
            for (const ext of extensions) {
                const indexPath = path.join(basePath, `index${ext}`);
                try {
                    const indexStat = await fs.stat(indexPath);
                    if (indexStat.isFile()) {
                        return indexPath;
                    }
                }
                catch {
                    // Continue to next extension
                }
            }
        }
    }
    catch {
        // File doesn't exist, try with extensions
    }
    // Try with each extension
    for (const ext of extensions) {
        const pathWithExt = basePath + ext;
        try {
            const stat = await fs.stat(pathWithExt);
            if (stat.isFile()) {
                return pathWithExt;
            }
        }
        catch {
            // Continue to next extension
        }
    }
    return null;
}
/**
 * Extract package name from import specifier
 * Examples:
 *   'lodash' → 'lodash'
 *   '@types/node' → '@types/node'
 *   'lodash/debounce' → 'lodash'
 *   '@types/node/fs' → '@types/node'
 */
function extractPackageName(specifier) {
    if (specifier.startsWith('@')) {
        // Scoped package: @scope/package/subpath → @scope/package
        const parts = specifier.split('/');
        if (parts.length >= 2) {
            return `${parts[0]}/${parts[1]}`;
        }
        return specifier;
    }
    // Regular package: package/subpath → package
    const firstSlash = specifier.indexOf('/');
    if (firstSlash === -1) {
        return specifier;
    }
    return specifier.substring(0, firstSlash);
}
/**
 * Resolve tsconfig paths alias
 */
async function resolveTsConfigAlias(specifier, projectRoot) {
    const tsconfig = await loadTsConfig(projectRoot);
    if (!tsconfig || !tsconfig.compilerOptions || !tsconfig.compilerOptions.paths) {
        return null;
    }
    const paths = tsconfig.compilerOptions.paths;
    const baseUrl = tsconfig.compilerOptions.baseUrl || '.';
    // Find matching path alias
    for (const [alias, targets] of Object.entries(paths)) {
        // Convert alias pattern to regex
        // Example: "@lib/*" → "^@lib/(.*)$"
        const aliasPattern = alias.replace(/\*/g, '(.*)');
        const regex = new RegExp(`^${aliasPattern}$`);
        const match = specifier.match(regex);
        if (match && Array.isArray(targets) && targets.length > 0) {
            // Replace * with captured group
            const target = targets[0].replace(/\*/g, match[1] || '');
            return path.join(projectRoot, baseUrl, target);
        }
    }
    return null;
}
/**
 * Resolve package.json imports field
 */
async function resolvePackageJsonImports(specifier, projectRoot) {
    if (!specifier.startsWith('#')) {
        return null;
    }
    const packageJson = await loadPackageJson(projectRoot);
    if (!packageJson || !packageJson.imports) {
        return null;
    }
    const imports = packageJson.imports;
    // Find matching import
    for (const [pattern, target] of Object.entries(imports)) {
        if (pattern.endsWith('/*') && specifier.startsWith(pattern.slice(0, -1))) {
            // Pattern: "#lib/*" matches "#lib/utils"
            const rest = specifier.slice(pattern.length - 1);
            const targetPattern = typeof target === 'string' ? target : target.default || '';
            if (targetPattern.endsWith('/*')) {
                const resolvedPath = targetPattern.slice(0, -1) + rest;
                return path.join(projectRoot, resolvedPath);
            }
        }
        else if (pattern === specifier) {
            // Exact match
            const targetPath = typeof target === 'string' ? target : target.default || '';
            return path.join(projectRoot, targetPath);
        }
    }
    return null;
}
/**
 * Strip .js/.jsx extension from path
 */
function stripJSExtension(pathStr) {
    if (pathStr.endsWith('.js'))
        return pathStr.slice(0, -3);
    if (pathStr.endsWith('.jsx'))
        return pathStr.slice(0, -4);
    return pathStr;
}
/**
 * Resolve JavaScript/TypeScript import
 */
async function resolveJSImport(specifier, sourceFilePath, projectRoot) {
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.d.ts'];
    const sourceDir = path.dirname(path.join(projectRoot, sourceFilePath));
    // 1. Check if it's a relative import
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const absolutePath = path.resolve(sourceDir, specifier);
        const relativePath = path.relative(projectRoot, absolutePath);
        let resolvedPath = await findFileWithExtensions(absolutePath, extensions);
        // If not found and ends with .js/.jsx, try stripping extension (to find .ts/.tsx)
        if (!resolvedPath && (absolutePath.endsWith('.js') || absolutePath.endsWith('.jsx'))) {
            const pathWithoutExt = stripJSExtension(absolutePath);
            resolvedPath = await findFileWithExtensions(pathWithoutExt, extensions);
        }
        if (resolvedPath) {
            const finalRelativePath = path.relative(projectRoot, resolvedPath);
            return {
                resolved: true,
                targetPath: finalRelativePath,
                isExternal: false,
                packageName: null
            };
        }
        return {
            resolved: false,
            targetPath: null,
            isExternal: false,
            packageName: null
        };
    }
    // 2. Check tsconfig paths alias
    const tsAliasPath = await resolveTsConfigAlias(specifier, projectRoot);
    if (tsAliasPath) {
        let resolvedPath = await findFileWithExtensions(tsAliasPath, extensions);
        // Also try stripping extension for aliases
        if (!resolvedPath && (tsAliasPath.endsWith('.js') || tsAliasPath.endsWith('.jsx'))) {
            const pathWithoutExt = stripJSExtension(tsAliasPath);
            resolvedPath = await findFileWithExtensions(pathWithoutExt, extensions);
        }
        if (resolvedPath) {
            const relativePath = path.relative(projectRoot, resolvedPath);
            return {
                resolved: true,
                targetPath: relativePath,
                isExternal: false,
                packageName: null
            };
        }
    }
    // 3. Check package.json imports
    const pkgImportPath = await resolvePackageJsonImports(specifier, projectRoot);
    if (pkgImportPath) {
        let resolvedPath = await findFileWithExtensions(pkgImportPath, extensions);
        // Also try stripping extension for package imports
        if (!resolvedPath && (pkgImportPath.endsWith('.js') || pkgImportPath.endsWith('.jsx'))) {
            const pathWithoutExt = stripJSExtension(pkgImportPath);
            resolvedPath = await findFileWithExtensions(pathWithoutExt, extensions);
        }
        if (resolvedPath) {
            const relativePath = path.relative(projectRoot, resolvedPath);
            return {
                resolved: true,
                targetPath: relativePath,
                isExternal: false,
                packageName: null
            };
        }
    }
    // 4. Otherwise, it's an external package
    const packageName = extractPackageName(specifier);
    return {
        resolved: true,
        targetPath: null,
        isExternal: true,
        packageName
    };
}
/**
 * Resolve Python import
 */
async function resolvePythonImport(specifier, sourceFilePath, projectRoot) {
    const sourceDir = path.dirname(path.join(projectRoot, sourceFilePath));
    // Handle relative imports
    if (specifier.startsWith('.')) {
        // Count dots for relative level
        let level = 0;
        let i = 0;
        while (i < specifier.length && specifier[i] === '.') {
            level++;
            i++;
        }
        const moduleName = specifier.slice(i);
        let currentDir = sourceDir;
        // Go up 'level' directories
        for (let j = 0; j < level - 1; j++) {
            currentDir = path.dirname(currentDir);
        }
        // Convert module path to file path
        const modulePath = moduleName.replace(/\./g, path.sep);
        const absolutePath = path.join(currentDir, modulePath);
        // Try .py file or __init__.py in directory
        const pyFile = absolutePath + '.py';
        const initFile = path.join(absolutePath, '__init__.py');
        try {
            await fs.stat(pyFile);
            const relativePath = path.relative(projectRoot, pyFile);
            return {
                resolved: true,
                targetPath: relativePath,
                isExternal: false,
                packageName: null
            };
        }
        catch {
            // Try __init__.py
        }
        try {
            await fs.stat(initFile);
            const relativePath = path.relative(projectRoot, initFile);
            return {
                resolved: true,
                targetPath: relativePath,
                isExternal: false,
                packageName: null
            };
        }
        catch {
            // Not found
        }
        return {
            resolved: false,
            targetPath: null,
            isExternal: false,
            packageName: null
        };
    }
    // Absolute import: try to resolve from project root
    const modulePath = specifier.replace(/\./g, path.sep);
    const absolutePath = path.join(projectRoot, modulePath);
    const pyFile = absolutePath + '.py';
    const initFile = path.join(absolutePath, '__init__.py');
    try {
        await fs.stat(pyFile);
        const relativePath = path.relative(projectRoot, pyFile);
        return {
            resolved: true,
            targetPath: relativePath,
            isExternal: false,
            packageName: null
        };
    }
    catch {
        // Try __init__.py
    }
    try {
        await fs.stat(initFile);
        const relativePath = path.relative(projectRoot, initFile);
        return {
            resolved: true,
            targetPath: relativePath,
            isExternal: false,
            packageName: null
        };
    }
    catch {
        // Not found in project, assume external
    }
    // External package
    const packageName = specifier.split('.')[0];
    return {
        resolved: true,
        targetPath: null,
        isExternal: true,
        packageName
    };
}
/**
 * Resolve C# using directive
 */
async function resolveCSharpImport(specifier, sourceFilePath, projectRoot) {
    // For C#, most using directives are external (System.*, Unity.*, etc.)
    // We'll only try to resolve project-internal namespaces
    // Convert namespace to path: MyApp.Utils → MyApp/Utils.cs
    const namespacePath = specifier.replace(/\./g, path.sep);
    const possiblePath = path.join(projectRoot, namespacePath + '.cs');
    try {
        await fs.stat(possiblePath);
        const relativePath = path.relative(projectRoot, possiblePath);
        return {
            resolved: true,
            targetPath: relativePath,
            isExternal: false,
            packageName: null
        };
    }
    catch {
        // Not found, assume external
    }
    // External package (NuGet, System, Unity, etc.)
    return {
        resolved: true,
        targetPath: null,
        isExternal: true,
        packageName: specifier.split('.')[0]
    };
}
/**
 * Main function to resolve import path
 */
export async function resolveImportPath(importSpecifier, sourceFilePath, projectRoot, lang) {
    try {
        if (lang === 'javascript' || lang === 'typescript') {
            return await resolveJSImport(importSpecifier, sourceFilePath, projectRoot);
        }
        if (lang === 'python') {
            return await resolvePythonImport(importSpecifier, sourceFilePath, projectRoot);
        }
        if (lang === 'csharp') {
            return await resolveCSharpImport(importSpecifier, sourceFilePath, projectRoot);
        }
        // Unsupported language
        return {
            resolved: false,
            targetPath: null,
            isExternal: false,
            packageName: null
        };
    }
    catch (error) {
        // On error, return unresolved
        return {
            resolved: false,
            targetPath: null,
            isExternal: false,
            packageName: null
        };
    }
}
/**
 * Clear caches (useful for testing)
 */
export function clearCaches() {
    tsconfigCache.clear();
    packageJsonCache.clear();
}
