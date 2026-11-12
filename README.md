# Nordvia Retail – From SAP tables to a knowledge graph

A semantic layer over the SAP FI extract of Nordvia Retail (three company codes: Spain, US and UK; fiscal year 2025). The 11 CSV tables become an OWL ontology and an RDF knowledge graph that answers the five competency questions with SPARQL, using business terms only.

```
11 SAP tables (CSV) → silver (typed, flagged) → gold (one table per class) → YARRRML mappings + Morph-KGC → RDF graph → SPARQL
```

## Deliverables

| # | Deliverable         | Where                                                                                                                                                                                                                               |
| - | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Ontology            | `ontology/nordvia-finance.ttl` (OWL, Turtle, labels and definitions on every term). Diagram of the model: `ontology/Nordvia.drawio`                                                                                             |
| 2 | Mappings            | `mappings/nordvia.yarrrml.yml` (YARRRML, one block per gold table) and `mappings/config.ini` (Morph-KGC)                                                                                                                        |
| 3 | Knowledge graph     | `kg/nordvia-kg.ttl` (data only; load it together with the ontology). Rebuild steps below                                                                                                                                          |
| 4 | Queries and answers | `queries/cq1…cq5 .rq`, with the answers in `queries/results/*.csv` and explained in `notebooks/05_competency_questions.ipynb`                                                                                                |
| 5 | Data quality log    | `data_quality/data_quality_log.csv` (21 findings: what, impact, proposed action), detail per row in `data_quality_detail.csv`, accepted cases in `reviewed_and_accepted.csv`; produced by `notebooks/01_data_quality.ipynb` |
| 6 | Presentation        | `presentation/Nordvia_presentation.pptx` (30-minute deck, with speaker notes)                                                                                                                                                     |

Extra, not requested: `app/`, a small local explorer of the graph (see "Explorer" below).

## Folder layout

```
README.md                      this file
requirements.txt               Python packages with the versions used
DATA_DICTIONARY.csv, data/     the input package (11 CSV tables)
notebooks/                     01 data quality, 02 silver, 03 gold, 04 knowledge graph, 05 competency questions
gold/                          output of notebook 03, input of the mappings
ontology/  mappings/  kg/  queries/  data_quality/  presentation/  app/
```

Each folder has its own short README with its files and how to run them.

`silver/` is not included: notebook 02 regenerates it.

## How to rebuild everything

Requires Python 3.12 or newer. The notebooks were run on 3.12/3.13 and the explorer on 3.14.

```bash
pip install -r requirements.txt
pip install jupyterlab            # to run the notebooks (jupyter lab notebooks/)
```

Run the notebooks (from the project root or from `notebooks/`) in order:

1. `notebooks/01_data_quality.ipynb` – writes `data_quality/` (optional: the files are already included).
2. `notebooks/02_silver.ipynb` – reads `data/`, writes `silver/`.
3. `notebooks/03_gold.ipynb` – reads `silver/`, writes `gold/` (it also derives the exchange rates to euros).
4. `notebooks/04_knowledge_graph.ipynb` – runs the mappings over `gold/`, checks the graph and saves `kg/nordvia-kg.ttl`.
5. `notebooks/05_competency_questions.ipynb` – runs the five queries and saves `queries/results/`.

Outside a notebook, the mapping step alone is:

```bash
python -m morph_kgc mappings/config.ini      # writes kg/nordvia-kg.nt
```

To query the graph with any SPARQL engine, load `ontology/nordvia-finance.ttl` and `kg/nordvia-kg.ttl` into the same store (the ontology holds the class hierarchy, the debt-age buckets and the exchange rates' method, which the queries use).

## Explorer 

```bash
python app/serve.py          # then open http://localhost:8080/
```

An overview, one page per competency question (chart, table and the SPARQL that produced it), an interactive map of the ontology, a SPARQL console and a page that writes SPARQL from a question in English or Spanish (this last page needs Claude Code installed and logged in). Details in `app/README.md`.

## Ontology in short

- 47 classes in the namespace `https://nordvia.com/ontology/finance#` (`nvf:`), in seven domains: organization, accounting documents, postings, business partners, accounts, code lists, currency and exchange rates.
- The line item is the hub: it points to its document, account, customer or payee, cost center, tax code, payment terms and, when settled, to the document that cleared it.
- Business rules are in the ontology, not hidden in queries: defined classes (`owl:equivalentClass`) for debit and credit lines, reversed documents and cost-center-required accounts; the debt-age buckets and net days of payment terms are individuals with their limits.
- Reuses ORG, ROV, SKOS, FOAF, DCMI Terms, schema.org and FIBO (Currency, Customer, Supplier, Payee). SKOS, ORG and ROV are imported; the others are referenced by IRI.
- Instances are minted under `https://nordvia.com/id/` from the SAP keys (for example `company/1000`, `document/1000-1800000187-2025`).

## Results

All amounts in euros, key date 31 Dec 2025. Full tables in `queries/results/`.

| Question                                  | Headline                                                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| CQ1 Receivables by customer and age       | Net receivables 728,281: not yet due 378,333; 1–30 days 150,139; 31–60 days 104,024; 61–90 days 19,897; over 90 days 98,372; open credits −22,484 |
| CQ2 Vendors that invoiced most in 2025    | Top vendor in Spain: Zenith Energy S.L. (191,488). Total invoiced: Spain 1,716,112; US 713,093; UK 867,981                                            |
| CQ3 Cost per cost center and expense type | 2,633,418 absorbed in total, by cost center and expense type                                                                                          |
| CQ4 Days to pay against terms             | Customers pay on average about 8.7 days later than their terms; 63 % of the 590 paid invoices were paid late                                          |
| CQ5 Profit and loss per company and month | Group result for 2025: 683,439; per company and month in the result file                                                                              |

## Assumptions and decisions

Each query file starts with the assumptions it uses; the main ones:

- **Key date and age.** The posting date decides the year and the key date; the due date (baseline date plus net days of the terms on the line) decides the debt age.
- **Open item.** A customer line with no clearing on or before the key date. Open credit memos reduce the balance and are shown apart, since a credit has no age.
- **Reversals and opening balances.** A reversal and the document it cancels are left out of invoicing, cost and profit and loss. Opening balances hold only bank, fixed assets and equity and affect none of the answers.
- **Vendors.** Employees paid through the vendor ledger are not vendors. The two records of one vendor (same Tax ID) become one payee with two identifiers.
- **Amount invoiced.** The gross amount credited to the vendor, tax included. A probable duplicate invoice is counted, because it was posted and paid; excluding it is a business decision.
- **Cost.** Postings to accounts that require a cost center; the few lines without one are kept and shown as "(no cost center)", with no dummy cost center invented.
- **Revenue and expense.** The source does not separate them: an account with a credit balance over the year is revenue.
- **Exchange rates to euros (none provided).** Derived from the documents: each header carries the rate between its document currency and the company's local currency. For each currency and month: the direct rate (average rate of the documents in that currency booked by the company that keeps its books in euros), else the inverse of the opposite quote, else a cross rate through the third currency. The method and the number of documents behind each rate are stored in the graph (`nvf:MonthlyExchangeRate`). Details and checks in `03_gold.ipynb`, section 2.

## Data quality

21 findings (4 high, 6 medium, 11 low impact), each with its impact and what was done about it: some are handled in gold (for example the customer without master record is kept as an *Unregistered Customer*), some are visible through a class of the ontology (reversals, one-time customers, employees), and the rest are handled or documented in the queries. Notebook 02 checks that every finding of the log is flagged on exactly the rows the log reports.

## Checks included

- Every term used in the graph is declared in the ontology; no link points to a missing instance; instances, links and amounts match gold (`04_knowledge_graph.ipynb`, section 2).
- Every gold reference points to an existing row, and every document balances in euros (`03_gold.ipynb`, section 5).

## What I would do next

Developed in the last slides of the presentation:

1. **The data.** SHACL shapes for the 21 quality rules, checked on every load; answers from the business on the open questions (the probable duplicate invoice, account 0000800100 in company 3000, the deleted customer with history); fix at the source where the defect comes from SAP.
2. **The numbers.** Replace the derived exchange rates with the real rate table; run the competency queries as regression tests with expected values; add a VAT question, since tax codes are already mapped on the line items.
3. **Running it.** Incremental loads from SAP with an orchestrator, a persistent triple store with a governed SPARQL endpoint, access by company code, ontology versioning, lineage and monitoring.

## Tools and versions

| Tool                   | Version                                |
| ---------------------- | -------------------------------------- |
| Python                 | 3.12/3.13 (notebooks), 3.14 (explorer) |
| Morph-KGC              | 2.10.0                                 |
| rdflib                 | 7.2.1                                  |
| pyoxigraph             | 0.3.22                                 |
| pandas                 | 2.3.3                                  |
| Protégé              | used to edit the ontology              |
| diagrams.net (draw.io) | used for `ontology/Nordvia.drawio`   |
