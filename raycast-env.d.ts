/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** HTTP Port - Local port the bridge server listens on (default 3099) */
  "port": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `manage` command */
  export type Manage = ExtensionPreferences & {}
  /** Preferences accessible in the `process` command */
  export type Process = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `manage` command */
  export type Manage = {}
  /** Arguments passed to the `process` command */
  export type Process = {}
}

