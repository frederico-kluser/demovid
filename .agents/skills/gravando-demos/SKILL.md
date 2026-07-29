---
name: gravando-demos
description: Como gerar um vídeo de demonstração narrado de um projeto frontend com o CLI `demovid` — do rascunho do roteiro ao MP4. Use quando o pedido for gravar/produzir um demo, um walkthrough, um vídeo de release ou uma demonstração de tela de um app web. Verificado por `demovid doctor`.
metadata:
  type: task
  verification_signal: demovid doctor
---

# Gravando demos com o demovid

## Quando usar

O usuário pediu um vídeo de demonstração de um projeto frontend — "grave um demo
do app X", "faz um vídeo mostrando o fluxo de login", "quero um walkthrough da
tela nova". Também serve para regravar um demo depois que a UI mudou.

## O fluxo, em ordem

```bash
demovid doctor                                   # 1. o ambiente aguenta?
demovid script ~/Projects/meu-app -o demo.yaml   # 2. rascunho do roteiro
demovid refine demo.yaml "mais curto, foca no login"   # 3. quantas vezes precisar
demovid voice demo.yaml                          # 4. sintetiza a narração
demovid rehearse demo.yaml                       # 5. ENSAIO — não pula
demovid record demo.yaml                         # 6. grava de verdade
```

## Conhecimento injetado (as partes não óbvias)

**`voice` roda ANTES de `record`, sempre.** A narração é pré-renderizada em MP3 e
tocada ao vivo durante a gravação; o `rec` capta pelo monitor do sink. É isso que
torna o disparo sem lag e a sincronia gratuita — `audio.onended` avança o passo.
Rodar `record` sem `voice` grava um vídeo mudo.

**Nunca pule o `rehearse`.** Ele resolve todos os seletores e monta a câmera sem
gravar. Se um seletor sumiu porque a UI mudou, você descobre em 10 segundos em vez
de no meio de uma gravação de 3 minutos. Ele também escolhe o degrau da câmera e
diz por que rebaixou, se rebaixou.

**Não mexa no volume nem troque o dispositivo de saída durante a gravação.** O
áudio capturado é o monitor do sink padrão. Trocar de sink no meio corta a
narração do vídeo, e não dá pra recuperar sem regravar.

**Uma gravação por vez.** O `rec` recusa iniciar se já houver captura rodando. Se
`doctor` acusar "captura em curso", pare com `recstop` antes.

**O browser abre com perfil descartável.** Se a demo precisa de login, o passo de
login vai **no roteiro**, com credencial de teste. Não aponte para o perfil real
do usuário — bookmarks, extensões e a conta pessoal dele apareceriam no vídeo.

**Presets são o visual e o ritmo; câmera é segurança.** São eixos independentes.
`--preset boardroom` (comitê, contido) ou `helpdesk` (usuário confuso, mais lento
e mais legível). `--camera` só se você quiser forçar um degrau — o padrão `auto`
decide no ensaio.

## Se der errado

| Sintoma | Causa provável |
|---|---|
| vídeo mudo | faltou `demovid voice` antes do `record` |
| balão fora do lugar | seletor casou com elemento errado — rode `rehearse -v` |
| `rec` recusa iniciar | já há captura rodando → `recstop` |
| tudo em `R3` (sem zoom) | o ensaio rebaixou; ele diz o motivo na saída |
| `insufficient_quota` | conta OpenAI sem saldo — `demovid doctor --deep` confirma |
