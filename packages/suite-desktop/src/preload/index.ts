// SPDX-FileCopyrightText: Copyright (C) 2023-2025 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { contextBridge, ipcRenderer } from "electron";
import os from "os";
import { join as pathJoin } from "path";

import { PreloaderSockets } from "@lichtblick/electron-socket/preloader";
import Logger from "@lichtblick/log";
import { NetworkInterface, OsContext } from "@lichtblick/suite-base/src/OsContext";

import { ExtensionsHandler } from "./ExtensionHandler";
import LocalFileStorage from "./LocalFileStorage";
import { fetchLayouts } from "./layouts";
import { decodeRendererArg } from "../common/rendererArgs";
import {
  CLIFlags,
  Desktop,
  ForwardedMenuEvent,
  ForwardedWindowEvent,
  NativeMenuBridge,
  Storage,
} from "../common/types";
import { LICHTBLICK_PRODUCT_NAME, LICHTBLICK_PRODUCT_VERSION } from "../common/webpackDefines";

// Since we have no way of modifying `window.process.argv` we use a sentinel cookie and reload
// hack to reset the page without deep links. By setting a session cookie and reloading
// we allow this preload script to read the cookie and ignore deep links in `getDeepLinks`
const ignoreDeepLinks = document.cookie.includes("fox.ignoreDeepLinks=true");
document.cookie = "fox.ignoreDeepLinks=;max-age=0;";

const deepLinks = ignoreDeepLinks ? [] : decodeRendererArg("deepLinks", window.process.argv) ?? [];

export function main(): void {
  const log = Logger.getLogger(__filename);

  log.debug(`Start Preload`);
  log.info(`${LICHTBLICK_PRODUCT_NAME} ${LICHTBLICK_PRODUCT_VERSION}`);
  log.info(`initializing preloader, argv="${window.process.argv.join(" ")}"`);

  window.onerror = (ev) => {
    console.error(ev);
  };

  // Initialize the RPC channel for electron-socket asynchronously
  PreloaderSockets.Create().catch((err: unknown) => {
    log.error("Failed to initialize preloader sockets", err);
  });

  window.addEventListener(
    "DOMContentLoaded",
    () => {
      // This input element receives generated dom events from main thread to inject File objects
      // See the comments in desktop/index.ts regarding this feature
      const input = document.createElement("input");
      input.setAttribute("hidden", "true");
      input.setAttribute("type", "file");
      input.setAttribute("id", "electron-open-file-input");
      input.setAttribute("multiple", "true");
      document.body.appendChild(input);

      // let main know we are ready to accept open-file requests
      void ipcRenderer.invoke("load-pending-files");
    },
    { once: true },
  );

  const localFileStorage = new LocalFileStorage();

  const ctx: OsContext = {
    platform: process.platform,
    pid: process.pid,

    // Environment queries
    getEnvVar: (envVar: string) => process.env[envVar],
    getHostname: os.hostname,
    getNetworkInterfaces: (): NetworkInterface[] => {
      const output: NetworkInterface[] = [];
      const ifaces = os.networkInterfaces();
      for (const name in ifaces) {
        const iface = ifaces[name];
        if (iface == undefined) {
          continue;
        }
        for (const info of iface) {
          output.push({ name, ...info, cidr: info.cidr ?? undefined });
        }
      }
      return output;
    },
    getAppVersion: (): string => {
      return LICHTBLICK_PRODUCT_VERSION;
    },
  };

  // Keep track of maximized state in the preload script because the initial ipc event sent from main
  // may occur before the app is fully rendered.
  let isMaximized = false;
  ipcRenderer.on("maximize", () => (isMaximized = true));
  ipcRenderer.on("unmaximize", () => (isMaximized = false));

  let extensionHandler: ExtensionsHandler | undefined;

  const getExtensionHandler = async (): Promise<ExtensionsHandler> => {
    if (!extensionHandler) {
      const homePath = (await ipcRenderer.invoke("getHomePath")) as string;
      const userExtensionsDir = pathJoin(homePath, ".lichtblick-suite", "extensions");
      extensionHandler = new ExtensionsHandler(userExtensionsDir);
    }
    return extensionHandler;
  };

  const desktopBridge: Desktop = {
    addIpcEventListener(eventName: ForwardedWindowEvent, handler: () => void) {
      ipcRenderer.on(eventName, handler);
      return () => {
        ipcRenderer.off(eventName, handler);
      };
    },
    async setRepresentedFilename(path: string | undefined) {
      await ipcRenderer.invoke("setRepresentedFilename", path);
    },
    async updateNativeColorScheme() {
      await ipcRenderer.invoke("updateNativeColorScheme");
    },
    async updateLanguage() {
      await ipcRenderer.invoke("updateLanguage");
    },
    async getCLIFlags(): Promise<CLIFlags> {
      return await (ipcRenderer.invoke("getCLIFlags") as Promise<CLIFlags>);
    },
    getDeepLinks(): string[] {
      return deepLinks;
    },
    resetDeepLinks(): void {
      // See `ignoreDeepLinks` comment above for why we do this hack to reset deep links

      // set a session cookie called "fox.ignoreDeepLinks"
      document.cookie = "fox.ignoreDeepLinks=true;";

      // Reload the window so the new preloader script can read the cookie
      window.location.reload();
    },
    // Layout management
    async fetchLayouts() {
      const userLayoutsDir = pathJoin(
        (await ipcRenderer.invoke("getHomePath")) as string,
        ".lichtblick-suite",
        "layouts",
      );
      return await fetchLayouts(userLayoutsDir);
    },
    // Extension management
    async getExtensions() {
      const handler = await getExtensionHandler();
      return await handler.list();
    },
    async loadExtension(id: string) {
      const handler = await getExtensionHandler();
      return await handler.load(id);
    },
    async installExtension(foxeFileData: Uint8Array) {
      const handler = await getExtensionHandler();
      return await handler.install(foxeFileData);
    },
    async uninstallExtension(id: string): Promise<boolean> {
      const handler = await getExtensionHandler();
      return await handler.uninstall(id);
    },
    handleTitleBarDoubleClick() {
      ipcRenderer.send("titleBarDoubleClicked");
    },
    isMaximized() {
      return isMaximized;
    },
    minimizeWindow() {
      ipcRenderer.send("minimizeWindow");
    },
    maximizeWindow() {
      ipcRenderer.send("maximizeWindow");
    },
    unmaximizeWindow() {
      ipcRenderer.send("unmaximizeWindow");
    },
    closeWindow() {
      ipcRenderer.send("closeWindow");
    },
    reloadWindow() {
      ipcRenderer.send("reloadMainWindow");
    },
  };

  const storageBridge: Storage = {
    // Context bridge cannot expose "classes" only exposes functions
    // We use .bind to attach the localFileStorage instance as _this_ to the function
    list: localFileStorage.list.bind(localFileStorage),
    all: localFileStorage.all.bind(localFileStorage),
    get: localFileStorage.get.bind(localFileStorage),
    put: localFileStorage.put.bind(localFileStorage),
    delete: localFileStorage.delete.bind(localFileStorage),
  };

  const menuBridge: NativeMenuBridge = {
    addIpcEventListener(eventName: ForwardedMenuEvent, handler: () => void) {
      ipcRenderer.on(eventName, handler);

      // We use an unregister handler return value approach because the bridge interface wraps
      // the handler function that render provides making it impossible for renderer to provide the
      // same function reference to `.off`.
      //
      // https://www.electronjs.org/docs/latest/api/context-bridge#parameter--error--return-type-support
      return () => {
        ipcRenderer.off(eventName, handler);
      };
    },
  };

  // NOTE: Context Bridge imposes a number of limitations around how objects move between the context
  // and the renderer. These restrictions impact what the api surface can expose and how.
  //
  // exposeInMainWorld is poorly named - it exposes the object to the renderer
  //
  // i.e.: returning a class instance doesn't work because prototypes do not survive the boundary
  contextBridge.exposeInMainWorld("ctxbridge", ctx);
  contextBridge.exposeInMainWorld("menuBridge", menuBridge);
  contextBridge.exposeInMainWorld("storageBridge", storageBridge);
  contextBridge.exposeInMainWorld("desktopBridge", desktopBridge);

  log.debug(`End Preload`);
}
