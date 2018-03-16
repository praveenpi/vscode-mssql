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
import ServiceDownloadProvider from './serviceDownloadProvider';
import DecompressProvider from './decompressProvider';
import HttpClient from './httpClient';
import ExtConfig from  '../configurations/extConfig';
import {PlatformInformation} from '../models/platform';
import {ServerInitializationResult, ServerStatusView} from './serverStatus';
import StatusView from '../views/statusView';
import * as LanguageServiceContracts from '../models/contracts/languageService';
const opener = require('opener');

const channel = window.createOutputChannel(Constants.serviceInitializingOutputChannelName);
const statusView = new StatusView();
let didInstall = false;

/**
 * @interface IMessage
 */
interface IMessage {
    jsonrpc: string;
}


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
    error(error: Error, message: IMessage, count: number): ErrorAction {
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

// The Service Client class handles communication with the VS Code LanguageClient
export default class SqlToolsServiceClient {
    // singleton instance
    private static _instance: LanguageClient;

    public static get client(): LanguageClient {
        return SqlToolsServiceClient._instance;
    }

    public static initialize(config: IConfig, vscodeWrapper: VscodeWrapper): Promise<ServerInitializationResult> {
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

                let serverProvider = new ServerProvider(config);

                serverProvider.eventEmitter.onAny(generateHandleServerProviderEvent());

                // For macOS we need to ensure the tools service version is set appropriately
                // this.updateServiceVersion(platformInfo);

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

                    SqlToolsServiceClient._instance = new LanguageClient(Constants.sqlToolsServiceName, serverOptions, clientOptions);
                    SqlToolsServiceClient.client.onReady().then(() => {
                        checkServiceCompatibility();
                    });

                    SqlToolsServiceClient.client.onNotification(LanguageServiceContracts.TelemetryNotification.type, handleLanguageServiceTelemetryNotification());
                    SqlToolsServiceClient.client.onNotification(LanguageServiceContracts.StatusChangedNotification.type, handleLanguageServiceStatusNotification());

                    return new ServerInitializationResult(true);
                });
            }
        });
    }
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
        SqlToolsServiceClient.client.sendRequest(VersionRequest.type, undefined).then((result) => {
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
    let config = workspace.getConfiguration(Constants.extensionConfigSectionName);
    if (config) {
        // Enable diagnostic logging in the service if it is configured
        let logDebugInfo = config[Constants.configLogDebugInfo];
        if (logDebugInfo) {
            serverArgs.push('--enable-logging');
        }

        // Send Locale for sqltoolsservice localization
        let applyLocalization = config[Constants.configApplyLocalization];
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

function generateHandleServerProviderEvent() {
	let dots = 0;
	return (e: string, ...args: any[]) => {
		channel.show();
		// statusView.show();
		switch (e) {
            case Events.INSTALL_START:
                didInstall = true;
				channel.appendLine(`${Constants.serviceInstallingTo} ${args[0]}`);
				// statusView.text = 'Installing Service';
				break;
			case Events.INSTALL_END:
				channel.appendLine(`${Constants.serviceInstalled}`);
				break;
			case Events.DOWNLOAD_START:
				channel.appendLine(`${Constants.serviceDownloading} ${args[0]}`);
				channel.append(`(${Math.ceil(args[1] / 1024)} KB)`);
				// statusView.text = 'Downloading Service';
				break;
			case Events.DOWNLOAD_PROGRESS:
				let newDots = Math.ceil(args[0] / 5);
				if (newDots > dots) {
					channel.append('.'.repeat(newDots - dots));
					dots = newDots;
				}
				break;
			case Events.DOWNLOAD_END:
				break;
		}
	};
}
