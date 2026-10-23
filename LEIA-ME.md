# Mapa do Romaneio

App para o motorista abrir o romaneio (.xlsx), digitar a rota (ex.: H-19) e ver todas as paradas no mapa antes de sair. Funciona no celular como app instalado (PWA).

## Arquivos

| Arquivo | O que faz |
|---|---|
| `index.html` | Telas e visual |
| `core.js` | O algoritmo: lê a planilha, normaliza endereços, pontua resultados, detecta pontos fora da área, otimiza a ordem |
| `app.js` | Mapa, busca de endereços em paralelo, cache, áreas de risco, ajuste de pino |
| `sw.js` + `manifest.webmanifest` + ícones `.png` | Deixa instalar na tela inicial e abrir sem internet |

## Como colocar no ar (grátis, pelo celular)

1. Crie uma conta em github.com e um repositório público, por exemplo `romaneio`.
2. Em **Add file → Upload files**, envie todos os arquivos desta pasta, incluindo os 3 ícones (.png).
3. Vá em **Settings → Pages**, escolha **Deploy from a branch**, branch `main`, pasta `/ (root)` e salve.
4. Em 1 ou 2 minutos o app fica em `https://SEU-USUARIO.github.io/romaneio/`.
5. Abra esse link no Chrome do celular → menu ⋮ → **Adicionar à tela inicial** (no iPhone: Safari → Compartilhar → Adicionar à Tela de Início).

Outra opção pelo computador: arraste a pasta inteira em app.netlify.com/drop.

O app precisa estar em um endereço `https://` para o GPS, a instalação e o modo sem internet funcionarem. Abrir o `index.html` direto do arquivo não funciona.

## O romaneio da Shopee

O app lê o arquivo do hub inteiro (ex.: `Romaneio_PM_23_10_2026.xlsx`, ~9.000 pacotes em ~96 gaiolas) com as colunas:

| Coluna | Uso |
|---|---|
| Corridor Cage | código da rota (G-31, H-20…). Ao escolher o arquivo, o app lista as rotas e avisa se a digitada não existe |
| Sequence | ordem dos pacotes; aparece como "seq 1, 2" em cada parada |
| Destination Address | "Rua, número, referência". A referência ("Última casa da rua", "Do lado do guardinha") aparece embaixo do endereço |
| City / Neighborhood | cidade e bairro, usados para achar o ponto certo |

Pacotes do mesmo endereço viram uma parada só (a G-31 tem 88 pacotes em 64 paradas).
Também entende variações que aparecem no arquivo: "Rua X 295, Ap510", "Av X - N.370", "S/N", "Sem N", "N⁰ 30", endereço com CEP e cidade no fim, e bairro duplicado como "Neves (Neves)".

## Como o algoritmo localiza as paradas

O romaneio não traz CEP nem coordenadas, então tudo sai do texto do endereço. Tudo acontece uma vez só, quando você escolhe a rota, e fica guardado no celular.

1. **O que já se sabe**: pinos ajustados por você, endereços já localizados antes. Aparecem na hora.
2. **Centro de cada bairro** da rota (uma busca por bairro, guardada para sempre). As grafias diferentes, como "Ponta D Areia", "Ponta DAreia" e "Ponta da Areia", viram o mesmo bairro.
3. **Mapa das ruas da região** (OpenStreetMap via Overpass), baixado em quadrados de ~2 km e guardado no celular. Com o tempo o hub inteiro fica salvo.
4. **Casamento local do nome da rua** (Jaro-Winkler) contra todas as ruas da região, sem depender de serviço de busca. "Travessa X" não é confundida com "Rua X".
5. **Posição pelo número**: no Brasil o número costuma ser a distância em metros desde o início da rua. O app coloca o 469 a ~469 m do começo da rua, com ímpares e pares em lados opostos. Isso separa paradas da mesma rua, que antes caíam todas no mesmo ponto.
6. **Viterbi na ordem da rota**: cada parada tem vários candidatos (rua homônima em outro bairro, os dois sentidos de numeração). O algoritmo escolhe o conjunto que melhor equilibra o nome e o bairro batendo com a parada ficar perto das vizinhas na sequência da Shopee. Isso elimina pinos "voando" para longe.
7. **Só o que sobrar** vai para a busca na internet (Photon, depois Nominatim).

Cores: verde = pelo número na rua · amarelo = só a rua (número fora do tamanho da rua, ou S/N) · vermelho = conferir (centro do bairro) · roxo = ajustado por você.

Medido com o romaneio real (G-31, H-21, I-1) e malha de ruas simulada:

- Rota pronta: 2–4 s
- Reabrir a mesma rota: instantâneo

## Áreas de risco

Toque no botão de alerta e depois no mapa, dê um nome e escolha o raio. Paradas dentro da área ganham a etiqueta **Risco**. Use **Exportar/Importar** para passar as áreas para outro celular.
