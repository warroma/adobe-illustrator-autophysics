# AutoPhysics

Painel para o Adobe Illustrator que **deixa objetos caírem dentro da prancheta**: eles despencam com gravidade, batem uns nos outros e nas bordas da prancheta, quicam e se acomodam numa pilha. Você aplica o resultado no documento e pode **exportar a queda como GIF animado** — uma animação feita a partir da arte do próprio Illustrator.

> **Versão 1.0.0 — experimental, em validação.** Primeira versão para testar no dia a dia. Encontrou algo estranho? Abra uma [issue](https://github.com/warroma/adobe-illustrator-autophysics/issues).

Projeto irmão do [AutoGrids](https://github.com/warroma/adobe-illustrator-autogrids) (grades de referência), com a mesma arquitetura e o mesmo tipo de instalador.

## O que ele faz

- **Cada objeto selecionado vira um corpo** com a sua **elasticidade** (quanto quica), **peso** (densidade) e **offset de colisão** (folga ou sobreposição).
- **O mundo vale para todos**: gravidade, resistência do ar, atrito, duração máxima e quais bordas da prancheta são paredes (chão, laterais, teto).
- **Nada roda em tempo real.** **Simular** calcula a queda inteira no próprio painel e mostra uma prévia; o documento só muda quando você clica em **Aplicar estado final** — um passo só de desfazer.
- **Exportar GIF** monta a animação com a aparência real de cada objeto (gradientes, efeitos, texto, imagens), em cima do fundo da prancheta.

## Instalação

<p align="center">
  <a href="https://github.com/warroma/adobe-illustrator-autophysics/releases/latest/download/AutoPhysics-Instalador-Windows.exe"><b>⬇ Baixar para Windows</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/warroma/adobe-illustrator-autophysics/releases/latest/download/AutoPhysics-Instalador-macOS.dmg"><b>⬇ Baixar para macOS</b></a>
  <br><sub>todas as versões em <a href="https://github.com/warroma/adobe-illustrator-autophysics/releases">Releases</a></sub>
</p>

1. **Baixe** o instalador do seu sistema (links acima).
2. **Abra o arquivo.** Como ele não é assinado digitalmente, o sistema avisa na primeira vez:
   - **Windows** — "O Windows protegeu seu PC": clique em **Mais informações** e depois em **Executar assim mesmo**.
   - **macOS** — "desenvolvedor não identificado": clique com o botão direito no app, **Abrir**, e confirme em **Abrir**.

   Esse aviso aparece para qualquer programa sem assinatura digital — [entenda por que e o que o instalador faz](#perguntas-frequentes).
3. Clique em **Instalar painel**.
4. **Feche o Illustrator por completo e abra de novo** — ele só carrega o painel ao abrir.
5. Abra o painel em **Janela > Extensões > AutoPhysics** e, se quiser, arraste a aba dele para a doca lateral.

**Para atualizar**, é igual: baixe o instalador da versão nova e clique em **Atualizar painel** — ele reconhece a versão instalada e troca sozinho.

> Os instaladores ainda **não foram testados num Windows/Mac de verdade com o AutoPhysics** (o do AutoGrids, de onde este veio, já foi). Se algo der errado, use a instalação manual abaixo e conte numa [issue](https://github.com/warroma/adobe-illustrator-autophysics/issues).

<details>
<summary><b>Instalação manual (sem o instalador)</b></summary>

1. Baixe o **Source code (zip)** da [última release](https://github.com/warroma/adobe-illustrator-autophysics/releases/latest) e descompacte.
2. Copie a pasta `com.autophysics.panel` inteira para:
   - **Windows:** `%APPDATA%\Adobe\CEP\extensions\` (cole esse caminho na barra do Explorador de Arquivos)
   - **macOS:** `~/Library/Application Support/Adobe/CEP/extensions/` (no Finder, `Cmd+Shift+G` e cole o caminho — a pasta `Library` fica oculta)

   Se as pastas `CEP` ou `extensions` não existirem, crie-as. Ao atualizar, apague a pasta antiga antes de copiar a nova.
3. Libere extensões de desenvolvimento (uma vez só — se você já fez isso para o AutoGrids, pode pular):
   - **Windows** — no PowerShell:
     ```powershell
     '7','8','9','10','11','12' | ForEach-Object {
         $p = "HKCU:\Software\Adobe\CSXS.$_"
         if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
         New-ItemProperty -Path $p -Name PlayerDebugMode -Value "1" -PropertyType String -Force | Out-Null
     }
     ```
   - **macOS** — no Terminal (o `xattr` tira a "quarentena" que o macOS põe em arquivos baixados e que faz o painel abrir em branco):
     ```bash
     for v in 9 10 11 12; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
     xattr -cr ~/Library/Application\ Support/Adobe/CEP/extensions/com.autophysics.panel
     ```
4. Feche o Illustrator por completo, abra de novo e vá em **Janela > Extensões > AutoPhysics**.
</details>

## Como usar

1. **Selecione os objetos que vão cair** e clique em **Capturar seleção**. Cada objeto selecionado vira um corpo; um grupo cai como um corpo só. A prancheta onde eles estão vira a "caixa" da simulação — os objetos podem começar acima dela, que caem para dentro.
2. **Ajuste cada objeto** — clique nele na lista (Ctrl/Cmd e Shift para vários; ele também é selecionado no Illustrator):
   - **Elasticidade**: quanto ele quica (0% = cai e para; 100% = quica para sempre).
   - **Peso**: densidade relativa. O mais pesado empurra o mais leve nas colisões e, com resistência do ar, cai mais rápido.
   - **Offset de colisão**: positivo deixa uma folga em volta do objeto; negativo deixa os objetos se sobreporem.
3. **Ajuste o mundo**: gravidade (100% = Terra), resistência do ar, atrito, duração máxima e paredes.
4. **Simular** — a prévia mostra as formas de colisão caindo. Ajuste e simule de novo quantas vezes quiser; o documento não é tocado.
5. **Aplicar estado final** move os objetos para onde a simulação terminou. `Ctrl+Z` / `Cmd+Z` volta tudo ao início.
6. **Exportar GIF…** — largura, quadros por segundo, velocidade (câmera lenta), tempo parado no fim, fundo (a arte da prancheta ou branco) e repetição. Funciona antes ou depois de aplicar o estado final.

Os ajustes de cada objeto ficam gravados nele (numa *tag* invisível do Illustrator) ao aplicar, e voltam numa próxima captura.

## Como a física funciona

- O motor (`com.autophysics.panel/js/physics.js`) segue o **Box2D** de Erin Catto: colisão entre polígonos convexos e círculos (SAT + recorte de arestas), impulsos sequenciais com *warm starting* e correção de penetração separada da velocidade — é o que deixa uma pilha parada em vez de tremendo. Roda no próprio painel, em passos de 1/200 s; 150 objetos levam menos de 1 segundo.
- **Elasticidade** (restituição): na batida, a velocidade de volta é a de chegada × elasticidade, então a altura do quique é elasticidade² da queda. Entre dois objetos vale a maior das duas (uma bola elástica quica até num chão "morto").
- **Peso e gravidade**: no vácuo, objetos pesados e leves caem juntos (Galileu) — o peso só muda as colisões. Por isso existe a **resistência do ar**: um arrasto proporcional ao tamanho e à velocidade faz cada objeto ter a sua velocidade terminal, `g × massa / arrasto`. Com ar, o mais pesado cai mais rápido.
- **Escala**: a prancheta vale ~2 m (raiz de largura × altura). Com 100% de gravidade, um objeto cai a altura de uma A4 em ~0,6 s, como cairia de 2 m de verdade.
- **Aplicar no documento**: o Illustrator só gira objetos em torno de pontos fixos (centro dos limites, cantos, origem). O painel gira cada objeto em torno da origem do documento, mede onde o centro de massa foi parar com um caminho-sonda temporário e translada a diferença.
- **GIF**: o Illustrator exporta um PNG transparente de cada objeto e outro do fundo. Os quadros são montados no painel, girando e movendo esses PNGs, e codificados num GIF com paleta global de 255 cores e quadros incrementais (só o que mudou de um quadro para o outro).

## Limitações

- A colisão usa a **"casca" convexa** de cada objeto (como um elástico esticado em volta dele). Estrelas, letras e outras formas côncavas colidem pela casca. Círculos são reconhecidos e rolam de verdade.
- **Texto vivo** colide pela caixa do texto; para colisão pelas letras, converta em contornos.
- No GIF, a ordem de empilhamento dos objetos segue a da seleção, e a arte que **não** foi simulada fica sempre atrás deles.
- GIF tem no máximo 256 cores: degradês muito suaves podem ganhar faixas.

## Perguntas frequentes

<details>
<summary><b>Apareceu um aviso dizendo que o instalador pode ser perigoso. É seguro?</b></summary>

O Windows e o macOS mostram esse aviso para **qualquer** programa que não tem **assinatura digital** — um certificado pago que identifica quem publicou o programa. O AutoPhysics é um projeto gratuito e de código aberto, e por isso não tem essa assinatura. O aviso não significa que algo errado foi encontrado nele.

O instalador faz só o que está descrito na próxima pergunta: não acessa a internet, não coleta dados, não instala mais nada e não precisa de permissão de administrador. O painel em si é um conjunto de scripts (HTML e JavaScript) que roda dentro do Illustrator, e todo o código está neste repositório para quem quiser conferir.
</details>

<details>
<summary><b>O que exatamente o instalador muda no meu computador?</b></summary>

1. Copia a pasta do painel (`com.autophysics.panel`) para a pasta onde o Illustrator procura painéis extras: `%APPDATA%\Adobe\CEP\extensions` no Windows, `~/Library/Application Support/Adobe/CEP/extensions` no Mac.
2. Liga o "modo de desenvolvimento" do Illustrator (explicado abaixo) — uma configuração que vale só para o seu usuário. No Windows, é o valor `PlayerDebugMode` nas chaves `HKEY_CURRENT_USER\Software\Adobe\CSXS.7` a `CSXS.12`. É a mesma do AutoGrids: se ele já está instalado, nada muda.
3. No Mac, tira da pasta copiada a marca de "baixado da internet", que impediria o painel de abrir.

Nada além disso.
</details>

<details>
<summary><b>O que é CEP e esse "modo de desenvolvimento"?</b></summary>

CEP é o sistema que a Adobe usa para os painéis extras do Illustrator — o painel Bibliotecas, por exemplo, é feito com ele. Normalmente o Illustrator só carrega painéis com assinatura digital; o "modo de desenvolvimento" é uma chave do próprio Illustrator que permite carregar painéis sem assinatura, como o AutoPhysics. Ela não muda nada no resto do Illustrator, mas vale para qualquer painel sem assinatura — então, como sempre, só instale painéis de quem você confia.
</details>

<details>
<summary><b>Como desinstalar?</b></summary>

Apague a pasta `com.autophysics.panel` de dentro da pasta de extensões citada acima e reinicie o Illustrator.
</details>

## Requisitos

- Adobe Illustrator 2020 (24.0) ou mais recente — o painel usa o identificador único dos objetos (`PageItem.uuid`), que só existe a partir dessa versão
- Windows ou macOS

## Desenvolvimento

```
com.autophysics.panel/ o painel (CEP)
  js/physics.js        motor de física (Box2D-like), sem dependências
  js/gif.js            encoder de GIF animado, sem dependências
  js/bridge.js         coordenadas Illustrator <-> motor, aplicar, cronograma do GIF
  js/main.js           interface do painel
  jsx/host.jsx         ExtendScript: ler a seleção, aplicar o estado final, exportar PNGs
  icons/               ícone do painel no dock
installer/             instalador Electron (lógica testável em src/detect.js e src/install.js; `npm test`)
test/                  testes do painel em Node, sem dependências
```

- **Testes** (Node 18+, nada para instalar):
  ```bash
  node test/physics.test.js   # pilha estável, quique = elasticidade², peso x ar, offset
  node test/gif.test.js       # GIF codificado e decodificado de volta, pixel a pixel
  node test/bridge.test.js    # host.jsx real contra um Illustrator falso: captura -> física -> aplicar
  ```
  O `npm test` do instalador roda os do instalador e também estes.
- Para trabalhar no próprio clone sem reinstalar a cada mudança, troque a pasta instalada por um atalho para o repositório — cada mudança passa a valer ao reabrir o Illustrator. No Windows:
  ```powershell
  New-Item -ItemType Junction -Path "$env:APPDATA\Adobe\CEP\extensions\com.autophysics.panel" -Target "<clone>\com.autophysics.panel"
  ```
  Rodar o instalador troca esse atalho por uma cópia da versão dele (o clone não é alterado).
- A versão do painel fica em `ExtensionBundleVersion` no [`CSXS/manifest.xml`](com.autophysics.panel/CSXS/manifest.xml) — é ela que o instalador compara para decidir entre instalar, atualizar ou reinstalar.
- **Publicar uma versão:** suba a versão no manifest e no `installer/package.json`, escreva as notas em `docs/release-notes/vX.Y.Z.md` e empurre a tag (`git tag vX.Y.Z` e `git push origin vX.Y.Z`) — ou, sem git, vá em **Actions > Release > Run workflow** e informe a tag (`vX.Y.Z`), que o workflow cria sozinho. O workflow [`release.yml`](.github/workflows/release.yml) monta o `.exe` (Windows) e o `.dmg` (macOS), roda os testes e publica a release com esses arquivos — os links de download deste README apontam sempre para a última.
