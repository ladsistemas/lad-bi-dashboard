# LAD BI · Painel estático

Dashboard **100% estático** (HTML/CSS/JS, sem build) que consome a API **LAD BI**
(`https://biapi.ladsistemas.com.br`) direto do navegador. Feito para hospedar em
**Amazon S3** (ou qualquer host estático: CloudFront, Netlify, Nginx, etc.).

Painel de indicadores **personalizado**, com os 5 gráficos principais:

| # | Pedido do cliente | Onde aparece | Endpoint |
|---|-------------------|--------------|----------|
| 1 | Quanto cada garçom vende | Gráfico "Quanto cada garçom vende" | `GET /api/v1/llm/caixa/relatorio` (`vendedores_ranking`) |
| 2 | Produto mais e menos vendido | "Produtos mais/menos vendidos" | mesmo endpoint (`produtos_mais/menos_vendidos`) |
| 3 | Garçom que mais cancela / perde | "Garçom que mais cancela" | `GET /api/v1/llm/cancelamentos` (`cancelamentosPorVendedor`) |
| 4 | Qual produto cada garçom mais vende | Tabela "O produto que cada garçom mais vende" | `GET /api/v1/llm/vendas/produto-vendedor` |
| 5 | Ticket médio de cada cliente | Tabela "Ticket médio por cliente" | `GET /api/v1/llm/financeiro/conta-cliente` |

Mais 3 indicadores de topo (KPIs): faturamento, comandas, ticket médio e total cancelado, e um gráfico de **formas de pagamento**.

---

## Configuração por empresa (⚙)

O botão **⚙ (Configurar painel)** no topo abre um painel onde o usuário **liga/desliga** e **reordena** cada gráfico/relatório. A configuração é **salva por empresa** (compartilhada entre os usuários e dispositivos daquela empresa).

- O catálogo de widgets vive em **`assets/js/widgets.js`** (fonte única). Para oferecer um indicador novo: registre nele, crie o card no `index.html` e o loader/render no `app.js`.
- Widgets ocultos **não** disparam chamadas de API (economia).
- A config é aplicada na hora (mostra/oculta/reordena) e salva no servidor **+** cache local (`localStorage`). Se o servidor estiver indisponível, ela persiste ao menos neste navegador e o painel continua funcionando.

### Indicadores opcionais já disponíveis (além da base)

| Widget | Endpoint |
|--------|----------|
| DRE / Resultado do período | `GET /api/v1/llm/financeiro/dre` |
| Contas a pagar (fornecedores / em aberto) | `GET /api/v1/llm/financeiro/contas-pagar` |
| Taxa de serviço por garçom | `GET /api/v1/llm/financeiro/taxa-servico` |
| Vendas por canal (salão/balcão/delivery) | `GET /api/v1/llm/kds/vendas/analise-canal` |
| Produtos e motivos mais cancelados | reusa `GET /api/v1/llm/cancelamentos` |
| Tempo de preparo e entrega (delivery): por dia da semana e por raio em km (ou bairro) | `GET /api/v1/llm/kds/tempo-entrega` |
| Programação da produção: média por semana do mês × dia da semana (sempre os últimos 90 dias) | `GET /api/v1/llm/vendas/sazonalidade-produtos` |
| Programação da produção por horário: a mesma grade, uma por turno do dashboard KDS (padrão Manhã/Almoço 06H-16H e Noite/Janta 16H-06H) | mesmo endpoint com `porTurno=true` |
| Produção dos próximos 7 dias: média da célula (semana do mês × dia) de cada dia + 15% de folga, arredondada para cima; dia inteiro ou por turno | mesmo endpoint |

---

## Multiloja

O seletor de lojas no topo aceita **várias lojas marcadas** (até 12). Com 2 ou mais, cada relatório é buscado em cada loja e **somado no navegador** (`assets/js/merge.js`); com 1 loja a resposta da API é usada como veio.

- **Produto** não é somado por `id_produto` (cada loja tem o seu). A opção **"Somar produtos das lojas por"** escolhe **nome** (sem acento/caixa/espaço duplo) ou **código** do cadastro. Garçom, cliente, fornecedor e forma de pagamento agrupam pelo nome.
- Cancelamentos e "produto por garçom" agrupam produto sempre pelo nome (a API não devolve o código neles).
- Percentual, ticket médio e margem são **recalculados** sobre o total somado.
- **Tempo de entrega** não é somado (mediana e p90 não se somam): vira um comparativo, uma linha por loja.
- Programação da produção: cada célula é a soma da média de cada loja.
- A configuração do painel (⚙) usada e salva é a da **primeira loja marcada**.
- Com várias lojas o caixa é pedido com `limiteRanking=2000`, para somar a lista inteira de produtos e não só o top 20 de cada loja (precisa do lad-bi 4.8.27 ou mais novo; antes dele, em período com um caixa só, a soma usa o top 10 de cada loja).

## Exportar (Excel, PDF, CSV)

Toda tabela/gráfico com dados tem o menu **Exportar** (`assets/js/exporter.js`, sem biblioteca externa):

- **Excel**: `.xlsx` de verdade, com número como número e formato de moeda/percentual.
- **PDF**: abre a impressão do navegador com a tabela formatada; escolher "Salvar como PDF".
- **CSV**: como antes.

O Excel e o PDF levam as lojas e o período no cabeçalho; o CSV leva o período no nome do arquivo.

### Onde a config é guardada (backend)

Como o **lad_bi** enxerga apenas a **réplica de leitura**, a **gravação** passa pelo **api-ladfood** (banco principal):

- **`GET /api/v1/llm/dashboard/config?idEmpresa=…`** (lad_bi) — lê `public.bi_dashboard_config` da réplica.
- **`PUT /api/v1/llm/dashboard/config?idEmpresa=…`** (lad_bi) — valida a permissão do usuário na empresa e **encaminha** a gravação ao **`PUT /ladfood/ws/bi/dashboard-config`** do api-ladfood.
- Migração (rodar **antes** no banco principal): `api-ladfood/sql/create_table_bi_dashboard_config.sql`.

O front fala **apenas com o `biapi` (lad_bi)** — reusa o mesmo login/token/CORS dos demais relatórios; nenhuma segunda URL é necessária.

---

## Como funciona o login

- A tela de login chama `POST /auth/login` com **e-mail e senha do LADFood** e recebe um **JWT** (`access_token` + `refresh_token`).
- O token fica no `localStorage` do navegador e é renovado automaticamente (via `POST /auth/refresh`) quando expira.
- Depois do login, o painel lista as empresas do usuário (`GET /auth/empresas`) e permite trocar de empresa no topo.
- Nenhuma credencial trafega para terceiros — apenas para a própria API LAD BI.

> A API já está com **CORS liberado para qualquer origem** (`addAllowedOriginPattern("*")`),
> então o site estático conversa com `biapi.ladsistemas.com.br` sem nenhuma alteração de backend.

---

## Estrutura

```
lad-bi-dashboard/
├── index.html              # tela de login + dashboard
├── assets/
│   ├── css/styles.css      # tema claro/escuro, layout responsivo, identidade LAD FOOD
│   ├── img/                # logo / símbolo LAD FOOD
│   ├── vendor/             # Chart.js (local, sem CDN)
│   └── js/
│       ├── config.js       # << URL da API e empresa padrão (edite aqui)
│       ├── widgets.js      # << catálogo de widgets (o que pode ligar/desligar)
│       ├── format.js       # moeda, datas, CSV
│       ├── api.js          # login/refresh + chamadas dos relatórios
│       ├── merge.js        # consolidação multiloja (soma das respostas de cada loja)
│       ├── exporter.js     # exportação Excel (.xlsx) e PDF (impressão)
│       ├── charts.js       # gráficos (Chart.js)
│       └── app.js          # orquestração da tela
├── test/merge.test.js      # check da consolidação e do xlsx: `node test/merge.test.js`
└── README.md
```

Chart.js já vem **vendorizado localmente** em `assets/vendor/chart.umd.min.js` (sem dependência de CDN —
funciona inclusive em redes que bloqueiam CDNs). Se o arquivo faltar, as **tabelas continuam funcionando**
e os gráficos exibem um aviso.

---

## Configuração

Edite **`assets/js/config.js`**:

```js
LADBI.config = {
  apiBase: 'https://biapi.ladsistemas.com.br', // ambiente da API
  empresaPadrao: 924,                          // empresa pré-selecionada (null = primeira)
  ...
};
```

Para apontar para homologação sem editar o arquivo, defina antes dos scripts:
`<script>window.LADBI_API_BASE='https://homolog...';</script>`.

---

## Testar localmente

Abrir o `index.html` direto pelo `file://` **não funciona** (o navegador bloqueia as chamadas).
Suba um servidor estático simples:

```bash
# Python
python -m http.server 8080
# ou Node
npx serve .
```

Depois acesse `http://localhost:8080`.

---

## Publicar no Amazon S3

1. **Criar o bucket** (ex.: `bi-minha-empresa`) na região desejada.
2. **Habilitar "Static website hosting"** (Propriedades → Hospedagem de site estático):
   - Index document: `index.html`
   - Error document: `index.html`
3. **Liberar leitura pública** (Permissões → desmarque "Block all public access" e aplique a policy):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Sid": "PublicReadGetObject",
       "Effect": "Allow",
       "Principal": "*",
       "Action": "s3:GetObject",
       "Resource": "arn:aws:s3:::SEU-BUCKET/*"
     }]
   }
   ```

4. **Enviar os arquivos** (mantendo a estrutura de pastas):

   ```bash
   aws s3 sync . s3://SEU-BUCKET --exclude ".git/*" --exclude "README.md" --exclude "test/*"
   ```

   > Não use `--acl public-read`: buckets criados a partir de abr/2023 vêm com ACLs desabilitadas
   > (Object Ownership = *Bucket owner enforced*) e o comando falharia com `AccessControlListNotSupported`.
   > A leitura pública já vem da bucket policy do passo 3.

5. Acesse pelo **endpoint do site** (ex.: `http://SEU-BUCKET.s3-website-sa-east-1.amazonaws.com`).

> **HTTPS / domínio (já provisionado):** o painel está publicado em
> **https://dashboard.ladfood.com.br** via **CloudFront** (distribution `E1X9PSXB4QAZB1`).
> A distribution usa **Default Root Object `index.html`**, **Origin = endpoint de site do S3**
> como *Custom Origin* http-only (`lad-bi-dashboard.s3-website-sa-east-1.amazonaws.com`),
> **viewer redirect-to-https**, e mapeia 403/404 → `/index.html` (200). Certificado no **ACM (us-east-1)**
> e alias A/AAAA no **Route53** (`dashboard.ladfood.com.br` na zona `ladfood.com.br`).
>
> **Importante:** com o CloudFront na frente, após o `aws s3 sync` invalide o cache para publicar na hora:
>
> ```bash
> aws cloudfront create-invalidation --distribution-id E1X9PSXB4QAZB1 --paths "/*"
> ```

---

## Segurança

- O token JWT fica no `localStorage` (padrão para SPAs internas). Use HTTPS (CloudFront) em produção.
- Cada usuário só enxerga as empresas e relatórios que sua conta LADFood já permite — a API valida permissão a cada chamada.
- Botão **Sair** apaga o token do navegador.

---

## Observações sobre os dados

- **Ticket médio por cliente** cobre apenas clientes identificados (fiado/conta corrente). Mesa/balcão não registram o cliente; por isso o ticket geral é por comanda.
- Valores de venda e cancelamento usam `item_venda` (correção 4.8.6/4.8.7) — sem inflar pelo número de vendas por comanda.
