/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
const fs = require('fs');
import * as path from 'path';
import * as Constants from '../constants/constants';
import {IConfig} from 'service-downloader';

const baseConfig = require('../config.json');

/*
* Config class handles getting values from config.json.
*/
export default class Config {
     private static _configJsonContent = undefined;
     private _sqlToolsServiceConfigKey: string;
     private version: number;

    constructor() {
        this._sqlToolsServiceConfigKey = Constants.sqlToolsServiceConfigKey;
        this.version = 2;
    }

    public useServiceVersion(version: number): void {
        switch (version) {
            case 1:
                this._sqlToolsServiceConfigKey = Constants.v1SqlToolsServiceConfigKey;
                break;
            default:
                this._sqlToolsServiceConfigKey = Constants.sqlToolsServiceConfigKey;
        }
        this.version = version;
    }

    public getServiceVersion(): number {
        return this.version;
    }

    public getSqlToolsConfig(): IConfig {
        return baseConfig[this._sqlToolsServiceConfigKey];
    }
}
