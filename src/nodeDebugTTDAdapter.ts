/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChromeDebugAdapter, TimeTravelRuntime, chromeUtils, ISourceMapPathOverrides, utils as CoreUtils, logger, telemetry as CoreTelemetry, ISetBreakpointResult, ISetBreakpointsArgs, Crdp, InternalSourceBreakpoint } from 'vscode-chrome-debug-core';
const telemetry = CoreTelemetry.telemetry;

import { DebugProtocol } from 'vscode-debugprotocol';
import { OutputEvent, CapabilitiesEvent, Event } from 'vscode-debugadapter';

import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

import { ILaunchRequestArguments, IAttachRequestArguments, ICommonRequestArgs } from './nodeDebugTTDInterfaces';
import * as pathUtils from './pathUtils';
import * as utils from './utils';
import * as errors from './errors';

import * as nls from 'vscode-nls';
let localize = nls.loadMessageBundle();

const DefaultSourceMapPathOverrides: ISourceMapPathOverrides = {
    'webpack:///./~/*': '${cwd}/node_modules/*',
    'webpack:///./*': '${cwd}/*',
    'webpack:///*': '*',
    'meteor://💻app/*': '${cwd}/*',
};

export class NodeDebugTTDAdapter extends ChromeDebugAdapter {
    private static NODE = 'node';
    private static NODE_TERMINATION_POLL_INTERVAL = 3000;
    private static DEBUG_BRK_DEP_MSG = /\(node:\d+\) \[DEP0062\] DeprecationWarning: `node --inspect --debug-brk` is deprecated\. Please use `node --inspect-brk` instead\.\s*/;

    public static NODE_INTERNALS = '<node_internals>';

    protected _launchAttachArgs: ICommonRequestArgs;

    private _loggedTargetVersion: boolean;
    private _nodeProcessId: number;
    private _pollForNodeProcess: boolean;

    // Flags relevant during init
    private _continueAfterConfigDone = true;
    private _entryPauseEvent: Crdp.Debugger.PausedEvent;
    private _waitingForEntryPauseEvent = true;
    private _finishedConfig = false;
    private _handlingEarlyNodeMsgs = true;
    private _captureFromStd: boolean = false;

    private _restartMode: boolean;
    private _isTerminated: boolean;
    private _adapterID: string;


    ////////////////
    //Overrides for Time-travel node adapter -- can refactor into extension that extends node2?

    private _pendingTTDLaunch: boolean = false;
    private _runtimeArgsForTTD: string[];
    private _runtimeExecutableForTTD: string;
    private _programPathForTTD: string;

    private _idGenerator = 0;

    private isTTDLiveMode(): boolean {
        const liveFlag = this._runtimeArgsForTTD.some((param) => param.startsWith("--tt-debug"));
        const replayFlag = this._runtimeArgsForTTD.every((param) => param.startsWith("--replay-debug"))
        return this._runtimeExecutableForTTD && liveFlag && !replayFlag;
    }

    private getLogDirectory(): string {
        return path.join(path.dirname(this._programPathForTTD), "_ttd_log_");
    }

    private makeReplayConfig(tracingDir: string): object {
        return {
            "launch": true,
            "config": {
                "type": "node",
                "request": "launch",
                "name": "Time-Travel Replay",
                "protocol": "inspector",
                "stopOnEntry": true,
                "runtimeExecutable": this._runtimeExecutableForTTD,
                "runtimeArgs": [
                    `--replay-debug=${tracingDir}`
                ],
                "console": "internalConsole",
                "timeout": 30000
            }
        };
    }

    private launchStatusNotify(state: string, id: number, data?: object | string) {
        this._session.sendEvent(new Event("ttdLaunch", { state: state, id: id, payload: data }));
    }

    private launchSetupForReverseExecution(): Promise<void | string> {
        if (this._pendingTTDLaunch) {
            return Promise.resolve(JSON.stringify({ "launch": false }));
        }

        const launchID = this._idGenerator++;

        this.launchStatusNotify("start", launchID);
        this._pendingTTDLaunch = true;
        const logDir = this.getLogDirectory();

        return new Promise((resolve, reject) => {
            setImmediate(() => {
                const ensureLocation = pathUtils.ensureTraceTarget(logDir);
                if (ensureLocation[0]) {
                    resolve();
                } else {
                    reject();
                }
            });
        })
            .then(() => {
                this.launchStatusNotify("write", launchID);
                return (<TimeTravelRuntime>this.chrome).TimeTravel.writeTTDLog({ uri: logDir });
            })
            .then(() => {
                if (!fs.existsSync(path.join(logDir, "ttdlog.log"))) {
                    this.launchStatusNotify("fail", launchID, "Could not write TTD trace -- has synchronous module loading completed?");
                    return JSON.stringify({ "launch": false });
                } else {
                    this.launchStatusNotify("complete", launchID, this.makeReplayConfig(logDir));
                    this._pendingTTDLaunch = false;
                    return JSON.stringify({ "launch": true });
                }
            })
            .catch((ex) => {
                this.launchStatusNotify("fail", launchID, JSON.stringify(ex));
                return JSON.stringify({ "launch": false });
            });
    }

    public stepBack(): Promise<void> {
        if (this.isTTDLiveMode()) {
            return this.launchSetupForReverseExecution() as undefined; //force types to be compatible with a hack
        } else {
            return (<TimeTravelRuntime>this.chrome).TimeTravel.stepBack()
                .then(() => { /* make void */ },
                    e => { /* ignore failures - client can send the request when the target is no longer paused */ });
        }
    }

    public reverseContinue(): Promise<void> {
        if (this.isTTDLiveMode()) {
            return this.launchSetupForReverseExecution() as undefined; //force types to be compatible with a hack
        } else {
            return (<TimeTravelRuntime>this.chrome).TimeTravel.reverse()
                .then(() => { /* make void */ },
                    e => { /* ignore failures - client can send the request when the target is no longer paused */ });
        }
    }

    ////////////////

    /**
     * Returns whether this is a non-EH attach scenario
     */
    private get normalAttachMode(): boolean {
        return this._attachMode && !this.isExtensionHost();
    }

    public initialize(args: DebugProtocol.InitializeRequestArguments): DebugProtocol.Capabilities {
        this._adapterID = args.adapterID;
        this._promiseRejectExceptionFilterEnabled = this.isExtensionHost();

        if (args.locale) {
            localize = nls.config({ locale: args.locale })();
        }

        const capabilities = super.initialize(args);
        capabilities.supportsLogPoints = true;
        return capabilities;
    }

    public async launch(args: ILaunchRequestArguments): Promise<void> {
        await super.launch(args);
        if (args.__restart && typeof args.__restart.port === 'number') {
            return this.doAttach(args.__restart.port, undefined, args.address, args.timeout);
        }

        const port = args.port || utils.random(3000, 50000);

        let runtimeExecutable = args.runtimeExecutable;
        if (runtimeExecutable) {
            if (!path.isAbsolute(runtimeExecutable)) {
                const re = pathUtils.findOnPath(runtimeExecutable, args.env);
                if (!re) {
                    return this.getRuntimeNotOnPathErrorResponse(runtimeExecutable);
                }

                runtimeExecutable = re;
            } else {
                const re = pathUtils.findExecutable(runtimeExecutable, args.env);
                if (!re) {
                    return this.getNotExistErrorResponse('runtimeExecutable', runtimeExecutable);
                }

                runtimeExecutable = re;
            }
        } else {
            const re = pathUtils.findOnPath(NodeDebugTTDAdapter.NODE, args.env);
            if (!re) {
                return Promise.reject(errors.runtimeNotFound(NodeDebugTTDAdapter.NODE));
            }

            // use node from PATH
            runtimeExecutable = re;
        }

        this._continueAfterConfigDone = !args.stopOnEntry;

        if (this.isExtensionHost()) {
            // we always launch in 'debug-brk' mode, but we only show the break event if 'stopOnEntry' attribute is true.
            let launchArgs = [];
            if (!args.noDebug) {
                launchArgs.push(`--debugBrkPluginHost=${port}`);

                // pass the debug session ID to the EH so that broadcast events know where they come from
                if (args.__sessionId) {
                    launchArgs.push(`--debugId=${args.__sessionId}`);
                }
            }

            const runtimeArgs = args.runtimeArgs || [];
            const programArgs = args.args || [];
            launchArgs = launchArgs.concat(runtimeArgs, programArgs);

            const envArgs = this.collectEnvFileArgs(args) || args.env;
            return this.launchInInternalConsole(runtimeExecutable, launchArgs, envArgs);
        }

        let programPath = args.program;
        if (programPath) {
            if (!path.isAbsolute(programPath)) {
                return this.getRelativePathErrorResponse('program', programPath);
            }

            if (!fs.existsSync(programPath)) {
                if (fs.existsSync(programPath + '.js')) {
                    programPath += '.js';
                } else {
                    return this.getNotExistErrorResponse('program', programPath);
                }
            }

            programPath = path.normalize(programPath);
            if (pathUtils.normalizeDriveLetter(programPath) !== pathUtils.realPath(programPath)) {
                logger.warn(localize('program.path.case.mismatch.warning', "Program path uses differently cased character as file on disk; this might result in breakpoints not being hit."));
            }
        }

        this._captureFromStd = args.outputCapture === 'std';

        ////
        //TTD support
        this._runtimeArgsForTTD = args.runtimeArgs || [];
        this._runtimeExecutableForTTD = args.runtimeExecutable;
        this._programPathForTTD = programPath;
        ////

        return this.resolveProgramPath(programPath, args.sourceMaps).then(resolvedProgramPath => {
            let program: string;
            let cwd = args.cwd;
            if (cwd) {
                if (!path.isAbsolute(cwd)) {
                    return this.getRelativePathErrorResponse('cwd', cwd);
                }

                if (!fs.existsSync(cwd)) {
                    return this.getNotExistErrorResponse('cwd', cwd);
                }

                // if working dir is given and if the executable is within that folder, we make the executable path relative to the working dir
                if (resolvedProgramPath) {
                    program = path.relative(cwd, resolvedProgramPath);
                }
            } else if (resolvedProgramPath) {
                // if no working dir given, we use the direct folder of the executable
                cwd = path.dirname(resolvedProgramPath);
                program = path.basename(resolvedProgramPath);
            }

            const runtimeArgs = args.runtimeArgs || [];
            const programArgs = args.args || [];

            const debugArgs = detectSupportedDebugArgsForLaunch(args);
            let launchArgs = [];
            if (!args.noDebug) {
                // Always stop on entry to set breakpoints
                if (debugArgs === DebugArgs.Inspect_DebugBrk) {
                    launchArgs.push(`--inspect=${port}`);
                    launchArgs.push('--debug-brk');
                } else {
                    launchArgs.push(`--inspect-brk=${port}`);
                }
            }

            launchArgs = runtimeArgs.concat(launchArgs, program ? [program] : [], programArgs);

            const envArgs = this.collectEnvFileArgs(args) || args.env;
            let launchP: Promise<void>;
            if (!args.console || args.console === 'internalConsole') {
                launchP = this.launchInInternalConsole(runtimeExecutable, launchArgs, envArgs, cwd);
            } else {
                return Promise.reject(errors.unknownConsoleType(args.console));
            }

            return launchP
                .then(() => {
                    return args.noDebug ?
                        Promise.resolve() :
                        this.doAttach(port, undefined, args.address, args.timeout, undefined, args.extraCRDPChannelPort);
                });
        });
    }

    public async attach(args: IAttachRequestArguments): Promise<void> {
        try {
            return super.attach(args);
        } catch (err) {
            if (err.format && err.format.indexOf('Cannot connect to runtime process') >= 0) {
                // hack -core error msg
                err.format = 'Ensure Node was launched with --inspect. ' + err.format;
            }

            throw err;
        }
    }

    protected commonArgs(args: ICommonRequestArgs): void {
        args.sourceMapPathOverrides = getSourceMapPathOverrides(args.cwd, args.sourceMapPathOverrides);
        fixNodeInternalsSkipFiles(args);
        args.showAsyncStacks = typeof args.showAsyncStacks === 'undefined' || args.showAsyncStacks;

        this._restartMode = args.restart;
        super.commonArgs(args);
    }

    protected hookConnectionEvents(): void {
        super.hookConnectionEvents();

        this.chrome.Runtime.onExecutionContextDestroyed(params => {
            if (params.executionContextId === 1) {
                this.terminateSession('Program ended');
            }
        });
    }

    protected async doAttach(port: number, targetUrl?: string, address?: string, timeout?: number, websocketUrl?: string, extraCRDPChannelPort?: number): Promise<void> {
        await super.doAttach(port, targetUrl, address, timeout, websocketUrl, extraCRDPChannelPort);
        this.beginWaitingForDebuggerPaused();
        this.getNodeProcessDetailsIfNeeded();

        this._session.sendEvent(new CapabilitiesEvent({ supportsStepBack: this.supportsStepBack() }));
    }

    private supportsStepBack(): boolean {
        return this._domains.has(<keyof Crdp.CrdpClient>'TimeTravel');
    }

    private launchInInternalConsole(runtimeExecutable: string, launchArgs: string[], envArgs?: any, cwd?: string): Promise<void> {
        // merge environment variables into a copy of the process.env
        const env = Object.assign({}, process.env, envArgs);
        Object.keys(env).filter(k => env[k] === null).forEach(key => delete env[key]);

        const spawnOpts: cp.SpawnOptions = { cwd, env };

        // Workaround for bug Microsoft/vscode#45832
        if (process.platform === 'win32' && runtimeExecutable.indexOf(' ') > 0) {
            let foundArgWithSpace = false;

            // check whether there is one arg with a space
            const args: string[] = [];
            for (const a of args) {
                if (a.indexOf(' ') > 0) {
                    args.push(`"${a}"`);
                    foundArgWithSpace = true;
                } else {
                    args.push(a);
                }
            }

            if (foundArgWithSpace) {
                launchArgs = args;
                runtimeExecutable = `"${runtimeExecutable}"`;
                spawnOpts.shell = true;
            }
        }

        this.logLaunchCommand(runtimeExecutable, launchArgs);
        const nodeProcess = cp.spawn(runtimeExecutable, launchArgs, spawnOpts);
        return new Promise<void>((resolve, reject) => {
            this._nodeProcessId = nodeProcess.pid;
            nodeProcess.on('error', (error) => {
                reject(errors.cannotLaunchDebugTarget(errors.toString()));
                const msg = `Node process error: ${error}`;
                logger.error(msg);
                this.terminateSession(msg);
            });
            nodeProcess.on('exit', () => {
                const msg = 'Target exited';
                logger.log(msg);
                this.terminateSession(msg);
            });
            nodeProcess.on('close', (code) => {
                const msg = 'Target closed';
                logger.log(msg);
                this.terminateSession(msg);
            });

            const noDebugMode = (<ILaunchRequestArguments>this._launchAttachArgs).noDebug;

            this.captureStderr(nodeProcess, noDebugMode);

            // Must attach a listener to stdout or process will hang on Windows
            nodeProcess.stdout.on('data', (data: string) => {
                if (noDebugMode || this._captureFromStd) {
                    let msg = data.toString();
                    this._session.sendEvent(new OutputEvent(msg, 'stdout'));
                }
            });

            resolve();
        });
    }

    private captureStderr(nodeProcess: cp.ChildProcess, noDebugMode: boolean): void {
        nodeProcess.stderr.on('data', (data: string) => {
            let msg = data.toString();
            let isLastEarlyNodeMsg = false;

            // We want to send initial stderr output back to the console because they can contain useful errors.
            // But there are some messages printed to stderr at the start of debugging that can be misleading.
            // Node is "handlingEarlyNodeMsgs" from launch to when one of these messages is printed:
            //   "To start debugging, open the following URL in Chrome: ..." - Node <8
            //   --debug-brk deprecation message - Node 8+
            // In this mode, we strip those messages from stderr output. After one of them is printed, we don't
            // watch stderr anymore and pass it along (unless in noDebugMode).
            if (this._handlingEarlyNodeMsgs && !noDebugMode) {
                const chromeMsgIndex = msg.indexOf('To start debugging, open the following URL in Chrome:');
                if (chromeMsgIndex >= 0) {
                    msg = msg.substr(0, chromeMsgIndex);
                    isLastEarlyNodeMsg = true;
                }

                const msgMatch = msg.match(NodeDebugTTDAdapter.DEBUG_BRK_DEP_MSG);
                if (msgMatch) {
                    isLastEarlyNodeMsg = true;
                    msg = msg.replace(NodeDebugTTDAdapter.DEBUG_BRK_DEP_MSG, '');
                }

                const helpMsg = /For help see https:\/\/nodejs.org\/en\/docs\/inspector\s*/;
                msg = msg.replace(helpMsg, '');
            }

            if (this._handlingEarlyNodeMsgs || noDebugMode || this._captureFromStd) {
                this._session.sendEvent(new OutputEvent(msg, 'stderr'));
            }

            if (isLastEarlyNodeMsg) {
                this._handlingEarlyNodeMsgs = false;
            }
        });
    }

    protected onConsoleAPICalled(params: Crdp.Runtime.ConsoleAPICalledEvent): void {
        // Once any console API message is received, we are done listening to initial stderr output
        this._handlingEarlyNodeMsgs = false;

        if (this._captureFromStd) {
            return;
        }

        // Strip the --debug-brk deprecation message which is printed at startup
        if (!params.args || params.args.length !== 1 || typeof params.args[0].value !== 'string' || !params.args[0].value.match(NodeDebugTTDAdapter.DEBUG_BRK_DEP_MSG)) {
            super.onConsoleAPICalled(params);
        }
    }

    private collectEnvFileArgs(args: ILaunchRequestArguments): any {
        // read env from disk and merge into envVars
        if (args.envFile) {
            try {
                const env = {};
                const buffer = utils.stripBOM(fs.readFileSync(args.envFile, 'utf8'));
                buffer.split('\n').forEach(line => {
                    const r = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
                    if (r !== null) {
                        const key = r[1];
                        if (!process.env[key]) {	// .env variables never overwrite existing variables (see #21169)
                            let value = r[2] || '';
                            if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
                                value = value.replace(/\\n/gm, '\n');
                            }
                            env[key] = value.replace(/(^['"]|['"]$)/g, '');
                        }
                    }
                });

                return utils.extendObject(env, args.env); // launch config env vars overwrite .env vars
            } catch (e) {
                throw errors.cannotLoadEnvVarsFromFile(e.message);
            }
        }
    }

    /**
     * Override so that -core's call on attach will be ignored, and we can wait until the first break when ready to set BPs.
     */
    protected async sendInitializedEvent(): Promise<void> {
        if (!this._waitingForEntryPauseEvent) {
            return super.sendInitializedEvent();
        }
    }

    public configurationDone(): Promise<void> {
        if (!this.chrome) {
            // It's possible to get this request after we've detached, see #21973
            return super.configurationDone();
        }

        // This message means that all breakpoints have been set by the client. We should be paused at this point.
        // So tell the target to continue, or tell the client that we paused, as needed
        this._finishedConfig = true;
        if (this._continueAfterConfigDone) {
            this._expectingStopReason = undefined;
            this.continue(/*internal=*/true);
        } else if (this._entryPauseEvent) {
            this.onPaused(this._entryPauseEvent);
        }

        return super.configurationDone();
    }

    private killNodeProcess(): void {
        if (this._nodeProcessId && !this.normalAttachMode) {
            if (this._nodeProcessId === 1) {
                logger.log('Not killing launched process. It has PID=1');
            } else {
                logger.log('Killing process with id: ' + this._nodeProcessId);
                utils.killTree(this._nodeProcessId);
            }

            this._nodeProcessId = 0;
        }
    }

    public async terminateSession(reason: string, args?: DebugProtocol.DisconnectArguments): Promise<void> {
        if (this.isExtensionHost() && args && typeof (<any>args).restart === 'boolean' && (<any>args).restart) {
            this._nodeProcessId = 0;
        } else if (this._restartMode && !args) {
            // If restart: true, only kill the process when the client has disconnected. 'args' present implies that a Disconnect request was received
            this._nodeProcessId = 0;
        }

        this.killNodeProcess();
        const restartArgs = this._restartMode && !this._inShutdown ? { port: this._port } : undefined;
        return super.terminateSession(reason, undefined, restartArgs);
    }

    protected async onPaused(notification: Crdp.Debugger.PausedEvent, expectingStopReason = this._expectingStopReason): Promise<void> {
        // If we don't have the entry location, this must be the entry pause
        if (this._waitingForEntryPauseEvent) {
            logger.log(Date.now() / 1000 + ': Paused on entry');
            this._expectingStopReason = 'entry';
            this._entryPauseEvent = notification;
            this._waitingForEntryPauseEvent = false;

            if ((this.normalAttachMode && this._launchAttachArgs.stopOnEntry !== false) ||
                (this.isExtensionHost() && this._launchAttachArgs.stopOnEntry)) {
                // In attach mode, and we did pause right away, so assume --debug-brk was set and we should show paused.
                // In normal attach mode, assume stopOnEntry unless explicitly disabled.
                // In extensionhost mode, only when stopOnEntry is explicitly enabled
                this._continueAfterConfigDone = false;
            }

            return this.getNodeProcessDetailsIfNeeded()
                .then(() => this.sendInitializedEvent());
        } else {
            return super.onPaused(notification, expectingStopReason);
        }
    }

    private resolveProgramPath(programPath: string, sourceMaps: boolean): Promise<string> {
        return Promise.resolve().then(() => {
            if (!programPath) {
                return programPath;
            }

            if (utils.isJavaScript(programPath)) {
                if (!sourceMaps) {
                    return programPath;
                }

                // if programPath is a JavaScript file and sourceMaps are enabled, we don't know whether
                // programPath is the generated file or whether it is the source (and we need source mapping).
                // Typically this happens if a tool like 'babel' or 'uglify' is used (because they both transpile js to js).
                // We use the source maps to find a 'source' file for the given js file.
                return this._sourceMapTransformer.getGeneratedPathFromAuthoredPath(programPath).then(generatedPath => {
                    if (generatedPath && generatedPath !== programPath) {
                        // programPath must be source because there seems to be a generated file for it
                        logger.log(`Launch: program '${programPath}' seems to be the source; launch the generated file '${generatedPath}' instead`);
                        programPath = generatedPath;
                    } else {
                        logger.log(`Launch: program '${programPath}' seems to be the generated file`);
                    }

                    return programPath;
                });
            } else {
                // node cannot execute the program directly
                if (!sourceMaps) {
                    return Promise.reject<string>(errors.cannotLaunchBecauseSourceMaps(programPath));
                }

                return this._sourceMapTransformer.getGeneratedPathFromAuthoredPath(programPath).then(generatedPath => {
                    if (!generatedPath) { // cannot find generated file
                        if (this._launchAttachArgs.outFiles || this._launchAttachArgs.outDir) {
                            return Promise.reject<string>(errors.cannotLaunchBecauseJsNotFound(programPath));
                        } else {
                            return Promise.reject<string>(errors.cannotLaunchBecauseOutFiles(programPath));
                        }
                    }

                    logger.log(`Launch: program '${programPath}' seems to be the source; launch the generated file '${generatedPath}' instead`);
                    return generatedPath;
                });
            }
        });
    }

    /**
     * Wait 500-5000ms for the entry pause event, and if it doesn't come, move on with life.
     * During attach, we don't know whether it's paused when attaching.
     */
    private beginWaitingForDebuggerPaused(): void {
        const checkPausedInterval = 50;
        const timeout = this._launchAttachArgs.timeout;

        // Wait longer in launch mode - it definitely should be paused.
        let count = this._attachMode ?
            10 :
            (typeof timeout === 'number' ?
                Math.floor(timeout / checkPausedInterval) :
                100);
        logger.log(Date.now() / 1000 + ': Waiting for initial debugger pause');
        const id = setInterval(() => {
            if (this._entryPauseEvent || this._isTerminated) {
                // Got the entry pause, stop waiting
                clearInterval(id);
            } else if (--count <= 0) {
                // No entry event, so fake it and continue
                logger.log(Date.now() / 1000 + ': Did not get a pause event after starting, so continuing');
                clearInterval(id);
                this._continueAfterConfigDone = false;
                this._waitingForEntryPauseEvent = false;

                this.getNodeProcessDetailsIfNeeded()
                    .then(() => this.sendInitializedEvent());
            }
        }, checkPausedInterval);
    }

    protected threadName(): string {
        return `Node (${this._nodeProcessId})`;
    }

    /**
     * Override addBreakpoints, which is called by setBreakpoints to make the actual call to Chrome.
     */
    protected addBreakpoints(url: string, breakpoints: InternalSourceBreakpoint[]): Promise<ISetBreakpointResult[]> {
        return super.addBreakpoints(url, breakpoints).then(responses => {
            if (this._entryPauseEvent && !this._finishedConfig) {
                const entryLocation = this._entryPauseEvent.callFrames[0].location;
                const bpAtEntryLocation = responses.some(response => {
                    // Don't compare column location, because you can have a bp at col 0, then break at some other column
                    return response && response.actualLocation && response.actualLocation.lineNumber === entryLocation.lineNumber &&
                        response.actualLocation.scriptId === entryLocation.scriptId;
                });

                if (bpAtEntryLocation) {
                    // There is some initial breakpoint being set to the location where we stopped on entry, so need to pause even if
                    // the stopOnEntry flag is not set
                    logger.log('Got a breakpoint set in the entry location, so will stop even though stopOnEntry is not set');
                    this._continueAfterConfigDone = false;
                    this._expectingStopReason = 'breakpoint';
                }
            }

            return responses;
        });
    }

    protected validateBreakpointsPath(args: ISetBreakpointsArgs): Promise<void> {
        return super.validateBreakpointsPath(args).catch(e => {
            if (args.source.path && utils.isJavaScript(args.source.path)) {
                return undefined;
            } else {
                return Promise.reject(e);
            }
        });
    }

    private getNodeProcessDetailsIfNeeded(): Promise<void> {
        if (this._loggedTargetVersion || !this.chrome) {
            return Promise.resolve();
        }

        return this.chrome.Runtime.evaluate({ expression: '[process.pid, process.version, process.arch]', returnByValue: true, contextId: 1 }).then(response => {
            if (this._loggedTargetVersion) {
                // Possible to get two of these requests going simultaneously
                return;
            }

            if (response.exceptionDetails) {
                const description = chromeUtils.errorMessageFromExceptionDetails(response.exceptionDetails);
                if (description.startsWith('ReferenceError: process is not defined')) {
                    logger.verbose('Got expected exception: `process is not defined`. Will try again later.');
                } else {
                    logger.log('Exception evaluating `process.pid`: ' + description + '. Will try again later.');
                }
            } else {
                const [pid, version, arch] = response.result.value;
                if (!this._nodeProcessId) {
                    this._nodeProcessId = pid;
                }

                if (this._pollForNodeProcess) {
                    this.startPollingForNodeTermination();
                }

                this._loggedTargetVersion = true;
                logger.log(`Target node version: ${version} ${arch}`);
                /* __GDPR__
                   "nodeVersion" : {
                      "version" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
                   }
                 */
                telemetry.reportEvent('nodeVersion', { version });
            }
        },
            error => logger.error('Error evaluating `process.pid`: ' + error.message));
    }

    private startPollingForNodeTermination(): void {
        const intervalId = setInterval(() => {
            try {
                if (this._nodeProcessId) {
                    // kill with signal=0 just test for whether the proc is alive. It throws if not.
                    process.kill(this._nodeProcessId, 0);
                } else {
                    clearInterval(intervalId);
                }
            } catch (e) {
                clearInterval(intervalId);
                logger.log('Target process died');
                this.terminateSession('Target process died');
            }
        }, NodeDebugTTDAdapter.NODE_TERMINATION_POLL_INTERVAL);
    }

    private logLaunchCommand(executable: string, args: string[]) {
        // print the command to launch the target to the debug console
        let cli = executable + ' ';
        for (let a of args) {
            if (a.indexOf(' ') >= 0) {
                cli += '\'' + a + '\'';
            } else {
                cli += a;
            }
            cli += ' ';
        }

        logger.warn(cli);
    }

    protected globalEvaluate(args: Crdp.Runtime.EvaluateRequest): Promise<Crdp.Runtime.EvaluateResponse> {
        // contextId: 1 - see https://github.com/nodejs/node/issues/8426
        if (!args.contextId) args.contextId = 1;

        return super.globalEvaluate(args);
    }

    /**
     * 'Path does not exist' error
     */
    private getNotExistErrorResponse(attribute: string, path: string): Promise<void> {
        return Promise.reject(<DebugProtocol.Message>{
            id: 2007,
            format: localize('attribute.path.not.exist', "Attribute '{0}' does not exist ('{1}').", attribute, '{path}'),
            variables: { path }
        });
    }

    /**
     * 'Path not absolute' error with 'More Information' link.
     */
    private getRelativePathErrorResponse(attribute: string, path: string): Promise<void> {
        const format = localize('attribute.path.not.absolute', "Attribute '{0}' is not absolute ('{1}'); consider adding '{2}' as a prefix to make it absolute.", attribute, '{path}', '${workspaceFolder}/');
        return this.getErrorResponseWithInfoLink(2008, format, { path }, 20003);
    }

    private getRuntimeNotOnPathErrorResponse(runtime: string): Promise<void> {
        return Promise.reject(<DebugProtocol.Message>{
            id: 2001,
            format: localize('VSND2001', "Cannot find runtime '{0}' on PATH. Make sure to have '{0}' installed.", '{_runtime}'),
            variables: { _runtime: runtime }
        });
    }

    /**
     * Send error response with 'More Information' link.
     */
    private getErrorResponseWithInfoLink(code: number, format: string, variables: any, infoId: number): Promise<void> {
        return Promise.reject(<DebugProtocol.Message>{
            id: code,
            format,
            variables,
            showUser: true,
            url: 'http://go.microsoft.com/fwlink/?linkID=534832#_' + infoId.toString(),
            urlLabel: localize('more.information', "More Information")
        });
    }

    protected getReadonlyOrigin(aPath: string): string {
        return path.isAbsolute(aPath) || aPath.startsWith(ChromeDebugAdapter.EVAL_NAME_PREFIX) ?
            localize('origin.from.node', "read-only content from Node.js") :
            localize('origin.core.module', "read-only core module");
    }

    /**
     * If realPath is an absolute path or a URL, return realPath. Otherwise, prepend the node_internals marker
     */
    protected realPathToDisplayPath(realPath: string): string {
        if (!realPath.match(/VM\d+/) && !path.isAbsolute(realPath)) {
            return `${NodeDebugTTDAdapter.NODE_INTERNALS}/${realPath}`;
        }

        return super.realPathToDisplayPath(realPath);
    }

    /**
     * If displayPath starts with the NODE_INTERNALS indicator, strip it.
     */
    protected displayPathToRealPath(displayPath: string): string {
        const match = displayPath.match(new RegExp(`^${NodeDebugTTDAdapter.NODE_INTERNALS}[\\\\/](.*)`));
        return match ? match[1] : super.displayPathToRealPath(displayPath);
    }

    private isExtensionHost(): boolean {
        return this._adapterID === 'extensionHost2' || this._adapterID === 'extensionHost';
    }
}

function getSourceMapPathOverrides(cwd: string, sourceMapPathOverrides?: ISourceMapPathOverrides): ISourceMapPathOverrides {
    return sourceMapPathOverrides ? resolveCwdPattern(cwd, sourceMapPathOverrides, /*warnOnMissing=*/true) :
        resolveCwdPattern(cwd, DefaultSourceMapPathOverrides, /*warnOnMissing=*/false);
}

function fixNodeInternalsSkipFiles(args: ICommonRequestArgs): void {
    if (args.skipFiles) {
        args.skipFileRegExps = args.skipFileRegExps || [];
        args.skipFiles = args.skipFiles.filter(pattern => {
            const fixed = fixNodeInternalsSkipFilePattern(pattern);
            if (fixed) {
                args.skipFileRegExps.push(fixed);
                return false;
            } else {
                return true;
            }
        });
    }
}

const internalsRegex = new RegExp(`^${NodeDebugTTDAdapter.NODE_INTERNALS}/(.*)`);
function fixNodeInternalsSkipFilePattern(pattern: string): string {
    const internalsMatch = pattern.match(internalsRegex);
    if (internalsMatch) {
        return `^(?!\/)(?![a-zA-Z]:)${CoreUtils.pathGlobToBlackboxedRegex(internalsMatch[1])}`;
    } else {
        return null;
    }
}

/**
 * Returns a copy of sourceMapPathOverrides with the ${cwd} pattern resolved in all entries.
 */
function resolveCwdPattern(cwd: string, sourceMapPathOverrides: ISourceMapPathOverrides, warnOnMissing: boolean): ISourceMapPathOverrides {
    const resolvedOverrides: ISourceMapPathOverrides = {};
    for (let pattern in sourceMapPathOverrides) {
        const replacePattern = sourceMapPathOverrides[pattern];
        resolvedOverrides[pattern] = replacePattern;

        const cwdIndex = replacePattern.indexOf('${cwd}');
        if (cwdIndex === 0) {
            if (cwd) {
                resolvedOverrides[pattern] = replacePattern.replace('${cwd}', cwd);
            } else if (warnOnMissing) {
                logger.log('Warning: sourceMapPathOverrides entry contains ${cwd}, but cwd is not set');
            }
        } else if (cwdIndex > 0) {
            logger.log('Warning: in a sourceMapPathOverrides entry, ${cwd} is only valid at the beginning of the path');
        }
    }

    return resolvedOverrides;
}

export enum DebugArgs {
    InspectBrk,
    Inspect_DebugBrk
}

const defaultDebugArgs = DebugArgs.Inspect_DebugBrk;
function detectSupportedDebugArgsForLaunch(config: any): DebugArgs {
    if (config.__nodeVersion) {
        return getSupportedDebugArgsForVersion(config.__nodeVersion);
    } else if (config.runtimeExecutable) {
        logger.log('Using --inspect --debug-brk because a runtimeExecutable is set');
        return defaultDebugArgs;
    } else {
        // only determine version if no runtimeExecutable is set (and 'node' on PATH is used)
        logger.log('Spawning `node --version` to determine supported debug args');
        let result: cp.SpawnSyncReturns<string>;
        try {
            result = cp.spawnSync('node', ['--version']);
        } catch (e) {
            logger.error('Node version detection failed: ' + (e && e.message));
        }

        const semVerString = result.stdout ? result.stdout.toString().trim() : undefined;
        if (semVerString) {
            return getSupportedDebugArgsForVersion(semVerString);
        } else {
            logger.log('Using --inspect --debug-brk because we couldn\'t get a version from node');
            return defaultDebugArgs;
        }
    }
}

function getSupportedDebugArgsForVersion(semVerString): DebugArgs {
    if (utils.compareSemver(semVerString, 'v7.6.0') >= 0) {
        logger.log(`Using --inspect-brk, Node version ${semVerString} detected`);
        return DebugArgs.InspectBrk;
    } else {
        logger.log(`Using --inspect --debug-brk, Node version ${semVerString} detected`);
        return DebugArgs.Inspect_DebugBrk;
    }
}