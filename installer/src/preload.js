"use strict";

var contextBridge = require("electron").contextBridge;
var ipcRenderer = require("electron").ipcRenderer;

contextBridge.exposeInMainWorld("autophysicsInstaller", {
    detectIllustrator: function () {
        return ipcRenderer.invoke("detect-illustrator");
    },
    runInstall: function () {
        return ipcRenderer.invoke("run-install");
    }
});
