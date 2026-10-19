"use strict";

var app = require("electron").app;
var BrowserWindow = require("electron").BrowserWindow;
var ipcMain = require("electron").ipcMain;
var path = require("path");
var detect = require("./detect");
var install = require("./install");

function panelSourceDir() {
    // Empacotado (build final via electron-builder): os arquivos do painel
    // ficam em resources/com.autophysics.panel (ver "extraResources" no
    // package.json). Em desenvolvimento (rodando este projeto direto do
    // repositório): usa a pasta real com.autophysics.panel um nível acima.
    if (app.isPackaged) {
        return path.join(process.resourcesPath, "com.autophysics.panel");
    }
    return path.join(__dirname, "..", "..", "com.autophysics.panel");
}

function createWindow() {
    var win = new BrowserWindow({
        width: 480,
        height: 600,
        resizable: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", function () {
    app.quit();
});

function installedPanelDir() {
    return path.join(detect.cepExtensionsDir(process.platform, process.env), path.basename(panelSourceDir()));
}

// Tudo que a tela de verificação precisa para escolher o cenário: instalar,
// atualizar, reinstalar, voltar versão ou trocar o atalho para o código-fonte
// (ver detect.planInstall), além de avisar se o Illustrator está aberto.
ipcMain.handle("detect-illustrator", function () {
    var result = { ok: true, installs: [], running: null, installed: null, bundledVersion: null, mode: "install" };
    try {
        result.installs = detect.findIllustratorInstalls(process.platform);
        result.running = detect.isIllustratorRunning(process.platform);
        result.bundledVersion = detect.readPanelVersion(panelSourceDir());
        result.installed = detect.inspectInstalled(installedPanelDir());
        result.mode = detect.planInstall(result.installed, result.bundledVersion);
    } catch (err) {
        result.ok = false;
        result.error = err.message;
    }
    return result;
});

ipcMain.handle("run-install", function () {
    var log = [];
    var pushLog = function (line) { log.push(line); };
    try {
        var placed = install.installPanel(panelSourceDir(), process.platform, process.env, pushLog);
        install.clearQuarantine(placed.dest, process.platform, pushLog);
        var debugResults = install.enableDebugMode(process.platform, pushLog);
        var anyDebugFailed = debugResults.some(function (r) { return !r.ok; });
        return {
            ok: true,
            dest: placed.dest,
            replacedLink: placed.replacedLink,
            previousVersion: placed.previousVersion,
            version: detect.readPanelVersion(panelSourceDir()),
            // Conferido de novo no fim: o aviso final muda se o Illustrator
            // ainda estiver aberto (ele só carrega a versão nova ao reabrir).
            running: detect.isIllustratorRunning(process.platform),
            debugPartial: anyDebugFailed,
            log: log
        };
    } catch (err) {
        return { ok: false, error: err.message, log: log };
    }
});
