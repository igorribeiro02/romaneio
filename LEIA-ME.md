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

O romaneio não traz CEP nem coordenadas, então tudo sai do texto do endereço:

1. **Agrupa** os pacotes por endereço (menos buscas).
2. **Usa o que já sabe primeiro**, sem internet: pinos ajustados à mão (para sempre) e endereços já buscados (cache no celular). Reabrir uma rota já vista é instantâneo.
3. **Centro de cada bairro e cidade** da rota: poucos pedidos, guardados para sempre. Servem de âncora: uma "Rua Um" encontrada em outro bairro perde pontos.
4. **Busca** (Photon/OpenStreetMap) 5 endereços ao mesmo tempo, dentro da região da cidade. Se o resultado ficar fraco, tenta de novo só com rua e cidade.
5. **Pontuação** de cada resultado: semelhança do nome da rua (Jaro-Winkler), número, bairro, cidade e distância até o centro do bairro.
   - Verde (Exato): ≥ 0,80
   - Amarelo (Rua): ≥ 0,60, a rua certa sem o número exato no mapa
   - Vermelho (Conferir): abaixo disso. O pino fica no centro do bairro, e você ajusta uma vez só
6. **Pontos fora da área**: quem cai muito longe do resto da rota é marcado e buscado de novo.
7. **Segunda fonte** (Nominatim) em segundo plano para os duvidosos. O mapa já está pronto e os pinos vão se corrigindo sozinhos.

Medido com o romaneio real, rota G-31 (64 paradas), com busca simulada a 250 ms por pedido:

- Primeiro pino: ~1 s
- Mapa completo: ~6 s
- Reabrir a mesma rota: instantâneo

Com a internet real o tempo varia com a rede. Como as ruas do hub se repetem muito, o cache vai deixando tudo mais rápido a cada dia.

## Áreas de risco

Toque no botão de alerta e depois no mapa, dê um nome e escolha o raio. Paradas dentro da área ganham a etiqueta **Risco**. Use **Exportar/Importar** para passar as áreas para outro celular.
