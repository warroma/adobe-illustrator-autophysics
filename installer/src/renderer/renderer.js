"use strict";

var foundEl = document.getElementById("found");
var introEl = document.getElementById("intro");
var planEl = document.getElementById("plan");
var runningWarnEl = document.getElementById("runningWarn");
var oldWarnEl = document.getElementById("oldWarn");
var oldYearEl = document.getElementById("oldYear");

// O painel usa PageItem.uuid, que só existe a partir do Illustrator 2020 (24.0).
var MIN_YEAR = 2020;
var installBtn = document.getElementById("installBtn");
var doneEl = document.getElementById("done");
var doneTitleEl = document.getElementById("doneTitle");
var doneRestartEl = document.getElementById("doneRestart");
var logEl = document.getElementById("log");

function appendLog(lines) {
    (lines || []).forEach(function (line) {
        logEl.textContent += line + "\n";
    });
}

// Texto da verificação + rótulo do botão para cada cenário de detect.planInstall.
function describePlan(r) {
    var installed = (r.installed && r.installed.version) || "versão desconhecida";
    var bundled = r.bundledVersion || "nova";
    switch (r.mode) {
        case "update":
            return { text: "Atualização disponível: versão instalada " + installed + " → " + bundled + ".", button: "Atualizar painel" };
        case "reinstall":
            return { text: "A versão " + bundled + " já está instalada. Reinstalar copia tudo de novo, sem mudar de versão.", button: "Reinstalar painel" };
        case "downgrade":
            return { text: "A versão instalada (" + installed + ") é mais nova que a deste instalador (" + bundled + "). Continuar volta para a " + bundled + ".", button: "Voltar para a versão " + bundled };
        case "linked":
            return {
                text: "A pasta do painel hoje é um atalho para " + ((r.installed && r.installed.linkTarget) || "o código-fonte") +
                    " (usado para desenvolver o painel). Instalar troca o atalho por uma cópia da versão " + bundled +
                    " — os arquivos de lá não são alterados.",
                button: "Instalar painel"
            };
        default:
            return { text: "O painel ainda não está instalado. Versão " + bundled + ".", button: "Instalar painel" };
    }
}

function successTitle(result, mode) {
    if (result.replacedLink) return "Versão " + result.version + " instalada no lugar do atalho para o código-fonte.";
    if (mode === "update") return "Atualizado de " + (result.previousVersion || "versão anterior") + " para " + result.version + ".";
    if (mode === "reinstall") return "Versão " + result.version + " reinstalada.";
    return "Versão " + result.version + " instalada.";
}

var currentMode = "install";

window.autophysicsInstaller.detectIllustrator().then(function (result) {
    var installs = (result && result.installs) || [];
    if (installs.length === 0) {
        introEl.textContent = "Não encontramos uma instalação do Illustrator automaticamente — isso não impede a instalação do painel, só confirme que o Illustrator já está instalado antes de abri-lo depois.";
    } else {
        introEl.textContent = "Encontramos:";
        installs.forEach(function (item) {
            var li = document.createElement("li");
            li.textContent = item.name;
            foundEl.appendChild(li);
        });
        var newest = installs.reduce(function (max, i) { return Math.max(max, i.year || 0); }, 0);
        if (newest > 0 && newest < MIN_YEAR) {
            oldYearEl.textContent = newest;
            oldWarnEl.hidden = false;
        }
    }
    currentMode = (result && result.mode) || "install";
    var plan = describePlan(result || {});
    planEl.textContent = plan.text;
    installBtn.textContent = plan.button;
    runningWarnEl.hidden = !(result && result.running);
    installBtn.disabled = false;
});

installBtn.addEventListener("click", function () {
    installBtn.disabled = true;
    installBtn.textContent = currentMode === "update" ? "Atualizando..." : "Instalando...";
    window.autophysicsInstaller.runInstall().then(function (result) {
        appendLog(result.log);
        if (result.ok) {
            installBtn.hidden = true;
            runningWarnEl.hidden = true;
            doneTitleEl.textContent = successTitle(result, currentMode);
            // O aviso de fechar e reabrir aparece SEMPRE: o Illustrator só lê
            // uma extensão CEP nova ou atualizada ao ser aberto. Se ele ainda
            // está aberto agora, o texto fica mais direto.
            if (result.running) {
                doneRestartEl.innerHTML = "O Illustrator está aberto agora. Para o painel funcionar corretamente, " +
                    "<strong>feche-o por completo (Arquivo &gt; Sair) e abra de novo</strong> — até lá ele continua usando a versão anterior.";
            }
            doneEl.hidden = false;
            if (result.debugPartial) {
                appendLog(["", "Aviso: nem todas as versões do modo de depuração do CEP puderam ser habilitadas — se o painel não aparecer no menu, isso pode ser o motivo."]);
            }
        } else {
            installBtn.textContent = "Falhou — tentar de novo";
            installBtn.disabled = false;
            appendLog(["ERRO: " + result.error]);
            if (result.error && /EBUSY|EPERM|EACCES/.test(result.error)) {
                appendLog(["Dica: feche o Illustrator e tente de novo — ele pode estar segurando os arquivos do painel."]);
            }
        }
    });
});
