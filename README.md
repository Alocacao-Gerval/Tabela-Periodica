# Return Map

Este projeto, estilo Return Map da BlackRock, é um refinamento da antiga Tabela Períodica feita pelo time de Alocação, mas com uma interface e funções mais interativas.

## O que ele já faz
- 3 modos de display: **Stacked**, **Relative to zero**, **Relative to asset**
- 3 modos de highlight: **Classe**, **Ativo** e **Retorno**
- Hover: destaca o mesmo ativo em todas as colunas + tooltip com métricas
- Colunas:
  - retornos por ano (detectados automaticamente no CSV)
  - **Anual. (CDI+ ou SOFR+)**
  - **Anual. Total**
  - **Vol.**
  - **Sharpe**
  - **Máx DD**

> RF (risk-free): no dataset Brasil ele procura a linha do **CDI**. No dataset Exterior ele vai procurar a linha do **SOFR**.

## Onde colocar os dados
- Brasil:
  - `data/br/CSV_Quantum.csv`
  - `data/br/asset_registry_br.csv`
- Exterior:
  - `data/ex/CSV_Quantum.csv`
  - `data/ex/asset_registry_ex.csv`

## asset_registry.csv
O app aceita dois formatos:
- Formato mínimo:
  - `asset;class;color`
- Formato atual (recomendado):
  - `asset;quantum_name;class;asset_color;class_color`

## Como publicar (Cloudflare Pages)
1. Crie um repositório no GitHub e suba os arquivos deste projeto.
2. No Cloudflare: **Pages** → **Create a project** → conecte seu repo.
3. Como isso é um site estático, você pode configurar:
   - Framework preset: **None**
   - Build command: (vazio)
   - Output directory: (raiz)
4. Deploy → você vai receber um link `*.pages.dev`.

## Atualização mensal (sem automação)
- Substitua `data/br/CSV_Quantum.csv` pelo novo CSV do Quantum
- Commit & push no GitHub
- O Pages redeploya automaticamente

## Próximos upgrades
- Proteger com login (Cloudflare Access)
- Gerar JSON no n8n e não publicar o CSV (quando o operacional virar prioridade)

Opção A (Python, normalmente já vem instalado):
1. Abra o Terminal na pasta do projeto
2. Rode:
   - `python -m http.server 8000`
3. Abra no navegador:
   - `http://localhost:8000`

Opção B (VS Code):
- Use a extensão **Live Server** e clique em “Go Live”.
