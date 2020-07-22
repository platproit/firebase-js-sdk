/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  FirebaseAnalytics,
  Gtag,
  SettingsOptions,
  DynamicConfig,
  MinimalDynamicConfig
} from '@firebase/analytics-types';
import {
  logEvent,
  setCurrentScreen,
  setUserId,
  setUserProperties,
  setAnalyticsCollectionEnabled
} from './functions';
import {
  insertScriptTag,
  getOrCreateDataLayer,
  wrapOrCreateGtag,
  findGtagScriptOnPage
} from './helpers';
import { AnalyticsError, ERROR_FACTORY } from './errors';
import { FirebaseApp } from '@firebase/app-types';
import { FirebaseInstallations } from '@firebase/installations-types';
import {
  isIndexedDBAvailable,
  validateIndexedDBOpenable,
  areCookiesEnabled,
  isBrowserExtension
} from '@firebase/util';
import { initializeIds } from './initialize-ids';
import { logger } from './logger';
import {
  isIndexedDBAvailable,
  validateIndexedDBOpenable,
  areCookiesEnabled
} from '@firebase/util';

/**
 * Maps appId to full initialization promise.
 */
let initializationPromisesMap: {
  [appId: string]: Promise<string>; // Promise contains measurement ID string.
} = {};

/**
 * List of dynamic config fetch promises.
 */
let dynamicConfigPromisesList: Array<Promise<
  DynamicConfig | MinimalDynamicConfig
>> = [];

/**
 * Maps fetched measurementIds to appId.
 */
const measurementIdToAppId: { [measurementId: string]: string } = {};

/**
 * Name for window global data layer array used by GA: defaults to 'dataLayer'.
 */
let dataLayerName: string = 'dataLayer';

/**
 * Name for window global gtag function used by GA: defaults to 'gtag'.
 */
let gtagName: string = 'gtag';

/**
 * Reproduction of standard gtag function or reference to existing
 * gtag function on window object.
 */
let gtagCoreFunction: Gtag;

/**
 * Wrapper around gtag function that ensures FID is sent with all
 * relevant event and config calls.
 */
let wrappedGtagFunction: Gtag;

/**
 * Flag to ensure page initialization steps (creation or wrapping of
 * dataLayer and gtag script) are only run once per page load.
 */
let globalInitDone: boolean = false;

/**
 * For testing
 */
export function resetGlobalVars(
  newGlobalInitDone = false,
  newInitializationPromisesMap = {},
  newDynamicPromises = []
): void {
  globalInitDone = newGlobalInitDone;
  initializationPromisesMap = newInitializationPromisesMap;
  dynamicConfigPromisesList = newDynamicPromises;
  dataLayerName = 'dataLayer';
  gtagName = 'gtag';
}

/**
 * For testing
 */
export function getGlobalVars(): {
  initializationPromisesMap: { [gaId: string]: Promise<string> };
  dynamicConfigPromisesList: Array<
    Promise<DynamicConfig | MinimalDynamicConfig>
  >;
} {
  return {
    initializationPromisesMap,
    dynamicConfigPromisesList
  };
}

/**
 * This must be run before calling firebase.analytics() or it won't
 * have any effect.
 * @param options Custom gtag and dataLayer names.
 */
export function settings(options: SettingsOptions): void {
  if (globalInitDone) {
    throw ERROR_FACTORY.create(AnalyticsError.ALREADY_INITIALIZED);
  }
  if (options.dataLayerName) {
    dataLayerName = options.dataLayerName;
  }
  if (options.gtagName) {
    gtagName = options.gtagName;
  }
}

export function factory(
  app: FirebaseApp,
  installations: FirebaseInstallations
): FirebaseAnalytics {
  if (isBrowserExtension()) {
    throw ERROR_FACTORY.create(AnalyticsError.INVALID_ANALYTICS_CONTEXT);
  }
  if (!areCookiesEnabled()) {
    throw ERROR_FACTORY.create(AnalyticsError.COOKIES_NOT_ENABLED);
  }
  const appId = app.options.appId;
  if (!appId) {
    throw ERROR_FACTORY.create(AnalyticsError.NO_APP_ID);
  }
  if (!app.options.apiKey) {
    if (app.options.measurementId) {
      logger.warn(
        `"apiKey" field is empty in Firebase config. This is needed to fetch the latest` +
          ` measurement id for this Firebase project. Falling back to measurement id ${app.options.measurementId}` +
          ` provided in "measurementId" field.`
      );
    } else {
      throw ERROR_FACTORY.create(AnalyticsError.NO_API_KEY);
    }
  }
  if (initializationPromisesMap[appId] != null) {
    throw ERROR_FACTORY.create(AnalyticsError.ALREADY_EXISTS, {
      id: appId
    });
  }
  if (!areCookiesEnabled()) {
    throw ERROR_FACTORY.create(AnalyticsError.COOKIES_NOT_ENABLED);
  }
  if (!isIndexedDBAvailable()) {
    throw ERROR_FACTORY.create(AnalyticsError.INDEXED_DB_UNSUPPORTED);
  }
  // Async but non-blocking.
  validateIndexedDBOpenable().catch(error => {
    throw ERROR_FACTORY.create(AnalyticsError.INVALID_INDEXED_DB_CONTEXT, {
      errorInfo: error
    });
  });

  if (!globalInitDone) {
    // Steps here should only be done once per page: creation or wrapping
    // of dataLayer and global gtag function.

    // Detect if user has already put the gtag <script> tag on this page.
    if (!findGtagScriptOnPage()) {
      insertScriptTag(dataLayerName);
    }
    getOrCreateDataLayer(dataLayerName);

    const { wrappedGtag, gtagCore } = wrapOrCreateGtag(
      initializationPromisesMap,
      dynamicConfigPromisesList,
      measurementIdToAppId,
      dataLayerName,
      gtagName
    );
    wrappedGtagFunction = wrappedGtag;
    gtagCoreFunction = gtagCore;

    globalInitDone = true;
  }
  // Async but non-blocking.
  // This map reflects the completion state of all promises for each appId.
  initializationPromisesMap[appId] = initializeIds(
    app,
    dynamicConfigPromisesList,
    measurementIdToAppId,
    installations,
    gtagCoreFunction
  );

  const analyticsInstance: FirebaseAnalytics = {
    app,
    // Public methods return void for API simplicity and to better match gtag,
    // while internal implementations return promises.
    logEvent: (eventName, eventParams, options) => {
      logEvent(
        wrappedGtagFunction,
        initializationPromisesMap[appId],
        eventName,
        eventParams,
        options
      ).catch(e => logger.error(e));
    },
    setCurrentScreen: (screenName, options) => {
      setCurrentScreen(
        wrappedGtagFunction,
        initializationPromisesMap[appId],
        screenName,
        options
      ).catch(e => logger.error(e));
    },
    setUserId: (id, options) => {
      setUserId(
        wrappedGtagFunction,
        initializationPromisesMap[appId],
        id,
        options
      ).catch(e => logger.error(e));
    },
    setUserProperties: (properties, options) => {
      setUserProperties(
        wrappedGtagFunction,
        initializationPromisesMap[appId],
        properties,
        options
      ).catch(e => logger.error(e));
    },
    setAnalyticsCollectionEnabled: enabled => {
      setAnalyticsCollectionEnabled(
        initializationPromisesMap[appId],
        enabled
      ).catch(e => logger.error(e));
    }
  };

  return analyticsInstance;
}
