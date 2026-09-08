// The client's entry point: the one script index.html loads.
//
// Everything below it is an ES module with real imports, so the browser
// resolves the graph and this file only has to name the three things that are
// not reached by an import from somewhere else:
//
//   * the Hungarian catalogue, which registers itself into I18n;
//   * the HLS adapter, which registers itself into the stream engine;
//   * App.init(), which used to sit at the bottom of app.js and ran on load.
//
// The last of those is the reason this file exists rather than a bare
// `<script type="module" src="app.js">`. A module that boots the application
// as a side effect of being imported cannot be imported by a test, and
// app.js is imported by nine page modules.

import { App } from './app.js'

// Side-effect imports. Each of these registers itself with something it
// imports; nothing holds a reference back, so they have to be named here or
// they are never loaded at all.
import '../i18n/hu.js'
import './hls-handler.js'

App.init()
