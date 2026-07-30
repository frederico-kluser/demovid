# Montagem comercial — gerado pelo demovid

Este projeto foi escrito por `demovid --format remotion`. Ele contém a gravação, a
narração e o **roteiro de edição** já no formato que o Remotion consome.

## Comandos

```bash
npm install         # só na primeira vez
npm run studio      # abre o Remotion Studio para preview e edição
npm run render      # renderiza out/comercial.mp4
```

## O que é o quê

| Arquivo | O que é |
|---|---|
| `src/edl.json` | **O roteiro de edição.** Cenas, cortes, transições, frases de impacto, narração. É o arquivo para editar. |
| `src/edl.ts` | Os tipos do EDL e a única conta que o renderizador é dono: a duração total. |
| `src/Root.tsx` | Registra a composição `Comercial`, com o EDL como `defaultProps`. |
| `src/Comercial.tsx` | Monta o `<TransitionSeries>` — gancho, cenas, fecho. |
| `src/components/Scene.tsx` | Uma cena: a janela do vídeo (`trimBefore`/`trimAfter`) mais o que é desenhado por cima. |
| `public/demo.mp4` | A gravação. Nenhum corte é feito em disco: cada cena aponta para um trecho deste arquivo. |
| `public/audio/*.mp3` | A narração, uma frase por arquivo. Ver "Áudio" abaixo. |

## Áudio: `embedded` ou `tracks`

O campo `audio` no `src/edl.json` decide de onde vem o som.

- **`embedded`** (padrão) — o MP4 gravado já carrega a narração, e a composição
  toca esse áudio. Existe **um relógio só**: a fala e a tela foram gravadas juntas,
  então não há nada para desalinhar. Os cortes caem dentro de silêncio medido, nunca
  em cima de palavra.
- **`tracks`** — o vídeo entra mudo e cada frase toca do seu próprio `.mp3`. É o que
  você quer quando começar a **reordenar cenas, regravar uma frase só ou fazer
  ducking de música de verdade** — e aí o alinhamento passa a ser seu.

Trocar é editar uma palavra no JSON. Os `.mp3` já estão em `public/audio` nos dois
casos.

## Editando

O `src/edl.json` é a superfície pretendida:

- **tirar uma cena** — apague o objeto de `scenes`. A duração total se ajusta.
- **mudar uma transição** — `transitionIn.presentation` aceita `fade`, `slide` ou
  `wipe`; `null` é corte seco. Só há três porque são as três que
  `src/Comercial.tsx` importa — acrescentar uma quarta é um import a mais lá.
- **transição custa frames dos dois lados.** `Total = Σcenas − Σtransições`, e os
  frames sobrepostos vêm do silêncio que o demovid reservou nas bordas do corte
  (320 ms). Uma transição mais longa que isso passa por cima de palavra falada.
- **frase de impacto** — `impact.atFrame` é relativo à **própria cena**, não ao
  vídeo. `trimBefore`/`trimAfter` são o contrário: frames absolutos no `demo.mp4`.
- **marca** — `brand` muda as três cores de uma vez. A fonte está em
  `src/components/theme.ts`, num stack de sistema para que um render nunca dependa
  da rede.

Não há schema zod aqui de propósito: o EDL é gerado a partir de dados já tipados no
demovid, e um segundo schema seria uma segunda fonte de verdade para a mesma forma.
Se quiser o formulário de props do Studio, declare um zod em `src/edl.ts` e passe
como `schema` no `<Composition>` — é uma mudança de um arquivo.

## Licença do Remotion

O Remotion é open source mas **não é MIT**: a documentação dele exige licença
comercial paga quando o total de pessoas envolvidas é 4 ou mais. Ver
<https://www.remotion.dev/docs/license>. Este projeto usa a versão gratuita.
