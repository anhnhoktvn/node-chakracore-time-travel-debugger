/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Path from 'path';
import * as FS from 'fs';
import * as CP from 'child_process';

/**
 * The input paths must use the path syntax of the underlying operating system.
 */
export function makePathAbsolute(absPath: string, relPath: string): string {
    return Path.resolve(Path.dirname(absPath), relPath);
}

/**
 * Remove the first segment of the given path and return the result.
 * The input path must use the path syntax of the underlying operating system.
 */
export function removeFirstSegment(path: string): string {
    const segments = path.split(Path.sep);
    segments.shift();
    if (segments.length > 0) {
        return segments.join(Path.sep);
    }
    return null;
}

/**
 * Return the relative path between 'path' and 'target'.
 * The input paths must use the path syntax of the underlying operating system.
 */
export function makeRelative(target: string, path: string): string {
    const t = target.split(Path.sep);
    const p = path.split(Path.sep);

    let i = 0;
    for (; i < Math.min(t.length, p.length) && t[i] === p[i]; i++) {
    }

    let result = '';
    for (; i < p.length; i++) {
        result = Path.join(result, p[i]);
    }
    return result;
}

/**
 * Returns a path with a lower case drive letter.
 */
export function normalizeDriveLetter(path: string): string {
    const regex = /^([A-Z])(\:[\\\/].*)$/;
    if (regex.test(path)) {
        path = path.replace(regex, (s, s1, s2) => s1.toLowerCase() + s2);
    }
    return path;
}

export function pathCompare(path1: string, path2: string): boolean {
    return normalizeDriveLetter(path1) === normalizeDriveLetter(path2);
}

/**
 * Given an absolute, normalized, and existing file path 'realPath' returns the exact path that the file has on disk.
 * On a case insensitive file system, the returned path might differ from the original path by character casing.
 * On a case sensitive file system, the returned path will always be identical to the original path.
 * In case of errors, null is returned. But you cannot use this function to verify that a path exists.
 * realPath does not handle '..' or '.' path segments and it does not take the locale into account.
 * Since a drive letter of a Windows path cannot be looked up, realPath normalizes the drive letter to lower case.
 */
export function realPath(path: string): string {

    let dir = Path.dirname(path);
    if (path === dir) {    // end recursion
        // is this an upper case drive letter?
        if (/^[A-Z]\:\\$/.test(path)) {
            path = path.toLowerCase();
        }
        return path;
    }
    let name = Path.basename(path).toLowerCase();
    try {
        let entries = FS.readdirSync(dir);
        let found = entries.filter(e => e.toLowerCase() === name);    // use a case insensitive search
        if (found.length === 1) {
            // on a case sensitive filesystem we cannot determine here, whether the file exists or not, hence we need the 'file exists' precondition
            let prefix = realPath(dir);   // recurse
            if (prefix) {
                return Path.join(prefix, found[0]);
            }
        } else if (found.length > 1) {
            // must be a case sensitive $filesystem
            const ix = found.indexOf(name);
            if (ix >= 0) {    // case sensitive
                let prefix = realPath(dir);   // recurse
                if (prefix) {
                    return Path.join(prefix, found[ix]);
                }
            }
        }
    } catch (error) {
        // silently ignore error
    }
    return null;
}

/**
 * Make sure that all directories of the given path exist (like mkdir -p).
 */
export function mkdirs(path: string) {
    if (!FS.existsSync(path)) {
        mkdirs(Path.dirname(path));
        FS.mkdirSync(path);
    }
}

// ---- the following functions work with Windows and Unix-style paths independent from the underlying OS.

/**
 * Returns true if the Windows or Unix-style path is absolute.
 */
export function isAbsolutePath(path: string) {
    if (path) {
        if (path.charAt(0) === '/') {
            return true;
        }
        if (/^[a-zA-Z]\:[\\\/]/.test(path)) {
            return true;
        }
    }
    return false;
}

/**
 * Convert the given Windows or Unix-style path into a normalized path that only uses forward slashes and has all superflous '..' sequences removed.
 * If the path starts with a Windows-style drive letter, a '/' is prepended.
 */
export function normalize(path: string): string {
    path = path.replace(/\\/g, '/');
    if (/^[a-zA-Z]\:\//.test(path)) {
        path = '/' + path;
    }
    path = Path.normalize(path);    // use node's normalize to remove '<dir>/..' etc.
    path = path.replace(/\\/g, '/');
    return path;
}

/**
 * Convert the given normalized path into a Windows-style path.
 */
export function toWindows(path: string): string {
    if (/^\/[a-zA-Z]\:\//.test(path)) {
        path = path.substr(1);
    }
    path = path.replace(/\//g, '\\');
    return path;
}

/**
 * Append the given relative path to the absolute path and normalize the result.
 */
export function join(absPath: string, relPath: string): string {
    absPath = normalize(absPath);
    relPath = normalize(relPath);
    if (absPath.charAt(absPath.length - 1) === '/') {
        absPath = absPath + relPath;
    } else {
        absPath = absPath + '/' + relPath;
    }
    absPath = Path.normalize(absPath);
    absPath = absPath.replace(/\\/g, '/');
    return absPath;
}

/**
 * Return the relative path between 'from' and 'to'.
 */
export function makeRelative2(from: string, to: string): string {

    from = normalize(from);
    to = normalize(to);

    const froms = from.substr(1).split('/');
    const tos = to.substr(1).split('/');

    while (froms.length > 0 && tos.length > 0 && froms[0] === tos[0]) {
        froms.shift();
        tos.shift();
    }

    let l = froms.length - tos.length;
    if (l === 0) {
        l = tos.length - 1;
    }

    while (l > 0) {
        tos.unshift('..');
        l--;
    }
    return tos.join('/');
}

/*
 * Lookup the given program on the PATH and return its absolute path on success and undefined otherwise.
 */
export function findOnPath(program: string, args_env: any): string | undefined {
    const env = extendObject(extendObject({}, process.env), args_env);

    let locator: string;
    if (process.platform === 'win32') {
        const windir = env['WINDIR'] || 'C:\\Windows';
        locator = Path.join(windir, 'System32', 'where.exe');
    } else {
        locator = '/usr/bin/which';
    }

    try {
        if (FS.existsSync(locator)) {
            const lines = CP.execSync(`${locator} ${program}`, { env }).toString().split(/\r?\n/);
            if (process.platform === 'win32') {
                // return the first path that has a executable extension
                const executableExtensions = env['PATHEXT'].toUpperCase();
                for (const path of lines) {
                    const ext = Path.extname(path).toUpperCase();
                    if (ext && executableExtensions.indexOf(ext + ';') > 0) {
                        return path;
                    }
                }
            } else {
                // return the first path
                if (lines.length > 0) {
                    return lines[0];
                }
            }

            return undefined;
        } else {
            // do not report failure if 'locator' app doesn't exist
        }
        return program;
    } catch (err) {
        // fall through
    }

    // fail
    return undefined;
}

export function findExecutable(program: string, args_env: any): string | undefined {
    const env = extendObject(extendObject({}, process.env), args_env);

    if (process.platform === 'win32' && !Path.extname(program)) {
        const PATHEXT = env['PATHEXT'];
        if (PATHEXT) {
            const executableExtensions = PATHEXT.split(';');
            for (const extension of executableExtensions) {
                const path = program + extension;
                if (FS.existsSync(path)) {
                    return path;
                }
            }
        }
    }

    if (FS.existsSync(program)) {
        return program;
    }

    return undefined;
}

export function extendObject<T>(toObject: T, fromObject: T): T {

    for (let key in fromObject) {
        if (fromObject.hasOwnProperty(key)) {
            toObject[key] = fromObject[key];
        }
    }
    return toObject;
}

////
//ensure directory exists and is empty...
export function ensureTraceTarget(pth: string): [boolean, string | undefined] {
    const okDir = createTargetDirectory(pth);
    if (!okDir) {
        return [false, `Failed to create directory for Time-Travel info: ${pth}`];
    }

    const okClean = deleteTargetDirectoryContents(pth);
    if (!okClean) {
        return [false, `Failed to clean directory for Time-Travel info: ${pth}`];
    }

    return [true, undefined];
}

function createTargetDirectory(pth: string): boolean {
    // see if it just exists and, if so, just return true
    const accessOk = FS.constants.W_OK;
    try {
        FS.accessSync(pth, accessOk);
        if (FS.statSync(pth).isDirectory()) {
            return true;
        }
    } catch (ei) { }

    // walk up the directory to see where the first valid part of the path is
    let prefixPath = pth;
    let suffixPaths = [];
    let baseFound = false;
    do {
        // check for bad prefix
        if (prefixPath === Path.dirname(prefixPath)) {
            return false;
        }

        suffixPaths.push(Path.basename(prefixPath)); // reverse order
        prefixPath = Path.dirname(prefixPath);

        try {
            FS.accessSync(prefixPath, accessOk);
            baseFound = FS.statSync(prefixPath).isDirectory();
        } catch (ei) { }
    } while (!baseFound);

    // now extend the prefix with all the suffix parts
    while (suffixPaths.length > 0) {
        try {
            prefixPath = Path.resolve(prefixPath, suffixPaths.pop());
            FS.mkdirSync(prefixPath);
        } catch (ec) {
            return false;
        }
    }

    return true;
}

function deleteTargetDirectoryContents(pth: string): boolean {
    try {
        const items = FS.readdirSync(pth);
        for (let i = 0; i < items.length; i++) {
            let fPath = Path.resolve(pth, items[i]);
            let stats = FS.lstatSync(fPath);
            if (stats.isFile()) {
                FS.unlinkSync(fPath);
            } else if (stats.isDirectory()) {
                let recOk = deleteTargetDirectoryContents(fPath);
                if (!recOk) {
                    return false;
                }
                FS.rmdirSync(fPath);
            } else {
                return false; //something strange in here.
            }
        }
    } catch (ex) {
        return false;
    }

    return true;
}
    ////