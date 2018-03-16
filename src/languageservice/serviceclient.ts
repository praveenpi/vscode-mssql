/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import { ExtensionContext, workspace, window, OutputChannel, languages, env } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions,
    TransportKind, RequestType, NotificationType, NotificationHandler,
    ErrorAction, CloseAction } from 'vscode-languageclient';

import { ServerProvider, IConfig, Events } from 'service-downloader';

import VscodeWrapper from '../controllers/vscodeWrapper';
import Telemetry from '../models/telemetry';
import * as Utils from '../models/utils';
import {VersionRequest} from '../models/contracts';
import {Logger} from '../models/logger';
import Constants = require('../constants/constants');
import {PlatformInformation} from '../models/platform';
import StatusView from '../views/statusView';
import * as LanguageServiceContracts from '../models/contracts/languageService';
import Config from '../configurations/config';
import { ServerStatusView, ServerInitializationResult } from './serverStatus';
import { Message } from 'vscode-jsonrpc';
const opener = require('opener');

const channel = window.createOutputChannel(Constants.serviceInitializingOutputChannelName);
const statusView = new StatusView();
const serverStatusView = new ServerStatusView();
const config = new Config;
let didInstall = false;

/**
 * Handle Language Service client errors
 * @class LanguageClientErrorHandler
 */
class LanguageClientErrorHandler {

    /**
     * Creates an instance of LanguageClientErrorHandler.
     * @memberOf LanguageClientErrorHandler
     */
    constructor(private vscodeWrapper?: VscodeWrapper) {
        if (!this.vscodeWrapper) {
            this.vscodeWrapper = new VscodeWrapper();
        }
    }

    /**
     * Show an error message prompt with a link to known issues wiki page
     * @memberOf LanguageClientErrorHandler
     */
    showOnErrorPrompt(): void {
        Telemetry.sendTelemetryEvent('SqlToolsServiceCrash');

        this.vscodeWrapper.showErrorMessage(
          Constants.sqlToolsServiceCrashMessage,
          Constants.sqlToolsServiceCrashButton).then(action => {
            if (action && action === Constants.sqlToolsServiceCrashButton) {
                opener(Constants.sqlToolsServiceCrashLink);
            }
        });
    }

    /**
     * Callback for language service client error
     *
     * @param {Error} error
     * @param {Message} message
     * @param {number} count
     * @returns {ErrorAction}
     *
     * @memberOf LanguageClientErrorHandler
     */
    error(error: Error, message: Message, count: number): ErrorAction {
        this.showOnErrorPrompt();

        // we don't retry running the service since crashes leave the extension
        // in a bad, unrecovered state
        return ErrorAction.Shutdown;
    }

    /**
     * Callback for language service client closed
     *
     * @returns {CloseAction}
     *
     * @memberOf LanguageClientErrorHandler
     */
    closed(): CloseAction {
        this.showOnErrorPrompt();

        // we don't retry running the service since crashes leave the extension
        // in a bad, unrecovered state
        return CloseAction.DoNotRestart;
    }
}

let instance: LanguageClient;
export const client = instance;

export function initialize(vscodeWrapper?: VscodeWrapper): Promise<ServerInitializationResult> {
    if (instance) {
        return Promise.reject('Already initalized');
    }

    return PlatformInformation.GetCurrent().then(platformInfo => {
        channel.appendLine(Constants.commandsNotAvailableWhileInstallingTheService);
        channel.appendLine('');
        channel.append(`Platform: ${platformInfo.toString()}`);
        if (!platformInfo.isValidRuntime()) {
            Utils.showErrorMsg(Constants.unsupportedPlatformErrorMessage);
            Telemetry.sendTelemetryEvent('UnsupportedPlatform', {platform: platformInfo.toString()} );
            throw new Error('Invalid Platform');
        } else {
            if (platformInfo.runtimeId) {
                channel.appendLine(` (${platformInfo.getRuntimeDisplayName()})`);
            } else {
                channel.appendLine('');
            }

            channel.appendLine('');

            let serverProvider = new ServerProvider(config.getSqlToolsConfig());

            serverProvider.eventEmitter.onAny(generateHandleServerProviderEvent());

            // For macOS we need to ensure the tools service version is set appropriately
            updateServiceVersion(platformInfo);

            initializeLanguageConfiguration();

            return serverProvider.getOrDownloadServer().then(e => {
                let serverOptions: ServerOptions = createServerOptions(e);
                let clientOptions: LanguageClientOptions = {
                    documentSelector: ['sql'],
                    synchronize: {
                        configurationSection: 'mssql'
                    },
                    errorHandler: new LanguageClientErrorHandler(vscodeWrapper)
                };

                instance = new LanguageClient(Constants.sqlToolsServiceName, serverOptions, clientOptions);
                client.onReady().then(() => {
                    checkServiceCompatibility();
                });

                client.onNotification(LanguageServiceContracts.TelemetryNotification.type, handleLanguageServiceTelemetryNotification());
                client.onNotification(LanguageServiceContracts.StatusChangedNotification.type, handleLanguageServiceStatusNotification());

                return new ServerInitializationResult(true);
            }, e => {
                serverStatusView.serviceInstallationFailed();
                return e;
            });
        }
    });
}

function updateServiceVersion(platformInfo: PlatformInformation): void {
    if (platformInfo.isMacOS() && platformInfo.isMacVersionLessThan('10.12.0')) {
        // Version 1.0 is required as this is the last one supporting downlevel macOS versions
        this._config.useServiceVersion(1);
    }
}


/**
 * Gets the known service version of the backing tools service. This can be useful for filtering
 * commands that are not supported if the tools service is below a certain known version
 *
 * @returns {number}
 * @memberof SqlToolsServiceClient
 */
export function getServiceVersion(): number {
    return config.getServiceVersion();
}


/**
 * Initializes the SQL language configuration
 *
 * @memberOf SqlToolsServiceClient
 */
function initializeLanguageConfiguration(): void {
   languages.setLanguageConfiguration('sql', {
       comments: {
           lineComment: '--',
           blockComment: ['/*', '*/']
       },

       brackets: [
           ['{', '}'],
           ['[', ']'],
           ['(', ')']
       ],

       __characterPairSupport: {
           autoClosingPairs: [
               { open: '{', close: '}' },
               { open: '[', close: ']' },
               { open: '(', close: ')' },
               { open: '"', close: '"', notIn: ['string'] },
               { open: '\'', close: '\'', notIn: ['string', 'comment'] }
           ]
       }
   });
}

function handleLanguageServiceTelemetryNotification(): NotificationHandler<LanguageServiceContracts.TelemetryParams> {
    return (event: LanguageServiceContracts.TelemetryParams): void => {
        Telemetry.sendTelemetryEvent(event.params.eventName, event.params.properties, event.params.measures);
    };
}

/**
 * Public for testing purposes only.
 */
function handleLanguageServiceStatusNotification(): NotificationHandler<LanguageServiceContracts.StatusChangeParams> {
    return (event: LanguageServiceContracts.StatusChangeParams): void => {
        statusView.languageServiceStatusChanged(event.ownerUri, event.status);
    };
}

function checkServiceCompatibility(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        client.sendRequest(VersionRequest.type, undefined).then((result) => {
             Utils.logDebug('sqlserverclient version: ' + result);

             if (result === undefined || !result.startsWith(Constants.serviceCompatibleVersion)) {
                 Utils.showErrorMsg(Constants.serviceNotCompatibleError);
                 Utils.logDebug(Constants.serviceNotCompatibleError);
                 resolve(false);
             } else {
                 resolve(true);
             }
        });
    });
}

function createServerOptions(servicePath: string): ServerOptions {
    let serverArgs = [];
    let serverCommand: string = servicePath;
    if (servicePath.endsWith('.dll')) {
        serverArgs = [servicePath];
        serverCommand = 'dotnet';
    }

    // Get the extenion's configuration
    let mssqlconfig = workspace.getConfiguration(Constants.extensionConfigSectionName);
    if (mssqlconfig) {
        // Enable diagnostic logging in the service if it is configured
        let logDebugInfo = mssqlconfig[Constants.configLogDebugInfo];
        if (logDebugInfo) {
            serverArgs.push('--enable-logging');
        }

        // Send Locale for sqltoolsservice localization
        let applyLocalization = mssqlconfig[Constants.configApplyLocalization];
        if (applyLocalization) {
            let locale = env.language;
            serverArgs.push('--locale');
            serverArgs.push(locale);
        }
    }


    // run the service host using dotnet.exe from the path
    let serverOptions: ServerOptions = {  command: serverCommand, args: serverArgs, transport: TransportKind.stdio  };
    return serverOptions;
}

function generateHandleServerProviderEvent(): (event: string, ...args: any[]) => void {
    let dots = 0;
    return (e: string, ...args: any[]) => {
        channel.show();
        // statusView.show();
        switch (e) {
            case Events.INSTALL_START:
                didInstall = true;
                channel.appendLine(`${Constants.serviceInstallingTo} ${args[0]}`);
                break;
            case Events.INSTALL_END:
                channel.appendLine(`${Constants.serviceInstalled}`);
                serverStatusView.serviceInstalled();
                break;
            case Events.DOWNLOAD_START:
                serverStatusView.installingService();
                channel.appendLine(`${Constants.serviceDownloading} ${args[0]}`);
                channel.append(`(${Math.ceil(args[1] / 1024)} KB)`);
                break;
            case Events.DOWNLOAD_PROGRESS:
                let newDots = Math.ceil(args[0] / 5);
                if (newDots > dots) {
                    channel.append('.'.repeat(newDots - dots));
                    dots = newDots;
                }
                serverStatusView.updateServiceDownloadingProgress(args[0]);
                break;
            case Events.DOWNLOAD_END:
                break;
            default:
                break;
        }
    };
}
